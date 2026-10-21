import type { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model';

export interface ModelRequest { system: string; prompt: string; maxTokens: number; signal: AbortSignal }
export interface KnowledgeModel {
  status(): { available: boolean; model?: string; reason?: string };
  generate(request: ModelRequest): Promise<string>;
}
const unavailable = '请先在 Harness 设置中配置默认模型；独立预览可通过环境变量配置模型。';
class ModelResponseError extends Error {}

export function harnessKnowledgeModel(ctx: Context): KnowledgeModel {
  function services() {
    const llm = ctx.get('llm') as LlmRuntime | undefined;
    const defaults = ctx.get('agentDefaultModel') as AgentDefaultModelConfig | undefined;
    const selection = defaults?.currentSelection();
    if (!llm || !selection?.provider || !selection.model || !llm.listProviders().some(p => p.id === selection.provider)) throw new Error(unavailable);
    return { llm, selection };
  }
  return {
    status() {
      try { const { selection } = services(); return { available: true, model: `${selection.provider} / ${selection.model}` }; }
      catch { return { available: false, reason: unavailable }; }
    },
    async generate({ system, prompt, maxTokens, signal }) {
      const { llm, selection } = services();
      signal.throwIfAborted();
      let text = ''; let finished = false;
      try { for await (const chunk of llm.stream({ ...selection, system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], maxTokens, signal })) {
        signal.throwIfAborted();
        // Complete blocks are authoritative; deltas may include reasoning or retries.
        if (chunk.type === 'block-end' && chunk.block.type === 'text') text += chunk.block.text;
        if (text.length > 60_000) throw new ModelResponseError('模型输出过长，请缩小整理范围');
        if (chunk.type === 'finish') {
          if (chunk.reason.kind !== 'stop') throw new ModelResponseError(chunk.reason.kind === 'max-tokens' ? '模型输出达到长度上限，请缩小整理范围后重试' : '模型调用未完成，请检查 Harness 模型设置后重试');
          finished = true;
        }
      } } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ModelResponseError) throw error;
        throw new Error('模型调用失败，请检查 Harness 模型配置或网络后重试');
      }
      signal.throwIfAborted();
      if (!finished || !text.trim()) throw new Error('模型没有返回完整正文，请重试');
      return text;
    },
  };
}

/** Preview credentials stay on the server and are never returned through HTTP. */
export function previewKnowledgeModel(env: NodeJS.ProcessEnv = process.env): KnowledgeModel {
  const key = env.KNOWLEDGE_LIBRARY_MODEL_API_KEY || env.DEEPSEEK_API_KEY;
  const model = env.KNOWLEDGE_LIBRARY_MODEL || 'deepseek-chat';
  const base = env.KNOWLEDGE_LIBRARY_MODEL_BASE_URL || 'https://api.deepseek.com';
  return {
    status: () => key ? { available: true, model } : { available: false, reason: unavailable },
    async generate({ system, prompt, maxTokens, signal }) {
      if (!key) throw new Error(unavailable);
      let response: Response;
      try {
        const url = new URL(`${base.replace(/\/$/, '')}/chat/completions`);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
        response = await fetch(url, { method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, stream: false, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }) });
      } catch {
        signal.throwIfAborted(); throw new Error('模型连接失败，请检查服务地址和网络后重试');
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`模型调用失败（HTTP ${response.status}），请检查模型配置或额度`); }
      // Bound bytes before JSON parsing, including chunked responses.
      const reader = response.body?.getReader(); if (!reader) throw new Error('模型响应为空');
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          length += part.value.length;
          if (length > 512_000) throw new Error('模型响应过大，请缩小整理范围');
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      let data: any;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('模型响应不是有效 JSON'); }
      const choice = data.choices?.[0];
      if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string' || !choice.message.content.trim()) throw new Error('模型未返回完整正文，可能达到输出上限，请缩小范围后重试');
      return choice.message.content;
    },
  };
}
