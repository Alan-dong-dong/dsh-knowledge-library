import type { Context } from '@deepseek-ai/cordis';
import type { ImageBlock, LlmRuntime, TextBlock } from '@deepseek-ai/dsh-llm';
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model';

export interface ModelRequest { system: string; prompt: string; maxTokens: number; signal: AbortSignal; expectedModel?: string; images?: Array<{ data: Uint8Array; mediaType: ImageMediaType; name?: string }> }
export interface VisionStatus { available: boolean; model?: string; reason?: string }
export interface KnowledgeModel {
  status(): { available: boolean; model?: string; reason?: string };
  generate(request: ModelRequest): Promise<string>;
  visionStatus?(): Promise<VisionStatus>;
}
const unavailable = '请先在 Harness 设置中配置默认模型；独立预览可通过环境变量配置模型。';
class ModelResponseError extends Error {}
async function boundedJson(response: Response, limit = 512_000): Promise<any> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('模型响应为空');
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > limit) throw new Error('模型响应过大，请缩小整理范围'); chunks.push(part.value); } }
  finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('模型响应不是有效 JSON'); }
}
function checkImages(images: ModelRequest['images']) {
  if (!images?.length) return;
  if (images.length > 10 || images.some(image => !image.data.byteLength || image.data.byteLength > 6 * 1024 * 1024 || !['image/png','image/jpeg','image/webp','image/gif'].includes(image.mediaType)) || images.reduce((sum, image) => sum + image.data.byteLength, 0) > 20 * 1024 * 1024) throw new Error('图片请求超过数量、格式或字节限制');
}

export function harnessKnowledgeModel(ctx: Context): KnowledgeModel {
  function services() {
    const llm = ctx.get('llm') as LlmRuntime | undefined;
    const defaults = ctx.get('agentDefaultModel') as AgentDefaultModelConfig | undefined;
    const selection = defaults?.currentSelection();
    if (!llm || !selection?.provider || !selection.model || !llm.listProviders().some(p => p.id === selection.provider)) throw new Error(unavailable);
    return { llm, selection };
  }
  async function visionStatus(): Promise<VisionStatus> {
    try {
      const { llm, selection } = services(); const model = `${selection.provider} / ${selection.model}`;
      if (!ctx.get('attachments')) return { available: false, model, reason: '当前宿主未提供图片附件服务，请升级或启用附件服务' };
      const info = await llm.resolveModelInfo(selection.provider, selection.model, AbortSignal.timeout(5000));
      return info.inputModalities?.includes('image') ? { available: true, model } : { available: false, model, reason: '当前默认模型未声明图片输入能力，请在 Harness 中选择支持视觉的模型（如 deepseek-flash）' };
    } catch { return { available: false, reason: '无法确认默认模型的图片能力，请检查 Harness 模型设置' }; }
  }
  return {
    visionStatus,
    status() {
      try { const { selection } = services(); return { available: true, model: `${selection.provider} / ${selection.model}` }; }
      catch { return { available: false, reason: unavailable }; }
    },
    async generate({ system, prompt, maxTokens, signal, images, expectedModel }) {
      checkImages(images);
      const { llm, selection } = services();
      if (expectedModel !== undefined && expectedModel !== `${selection.provider} / ${selection.model}`) throw new Error('模型已改变，请重新核对');
      signal.throwIfAborted();
      const content: Array<TextBlock | ImageBlock> = [{ type: 'text', text: prompt }];
      if (images?.length) {
        const status = await visionStatus(); signal.throwIfAborted();
        if (!status.available || status.model !== `${selection.provider} / ${selection.model}`) throw new Error(status.reason || '图片模型配置已改变');
        const attachments = ctx.get('attachments') as AttachmentStore;
        const refs = await attachments.saveImages(images); signal.throwIfAborted();
        const current = services().selection;
        if (current.provider !== selection.provider || current.model !== selection.model) throw new Error('图片模型配置已改变，请重新核对');
        content.push(...refs.map(attachment => ({ type: 'image' as const, attachment })));
      }
      let text = ''; let finished = false;
      try { for await (const chunk of llm.stream({ ...selection, system, messages: [{ role: 'user', content }], maxTokens, signal })) {
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
  let cached: { time: number; value: VisionStatus } | undefined;
  async function visionStatus(): Promise<VisionStatus> {
    if (!key) return { available: false, model, reason: unavailable };
    if (cached && Date.now() - cached.time < 15_000) return cached.value;
    let value: VisionStatus;
    try {
      const response = await fetch(`${base.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const data = await boundedJson(response); const entry = Array.isArray(data.data) && data.data.find((item: any) => item.id === model);
      value = entry?.input_modalities?.includes('image') ? { available: true, model } : { available: false, model, reason: '当前模型未声明图片输入能力，请设置支持视觉的 KNOWLEDGE_LIBRARY_MODEL（如 deepseek-flash）' };
    } catch { value = { available: false, model, reason: '无法读取模型图片能力，请检查服务地址的 /models 接口和网络' }; }
    cached = { time: Date.now(), value }; return value;
  }
  return {
    visionStatus,
    status: () => key ? { available: true, model } : { available: false, reason: unavailable },
    async generate({ system, prompt, maxTokens, signal, images, expectedModel }) {
      checkImages(images);
      if (!key) throw new Error(unavailable);
      if (expectedModel !== undefined && expectedModel !== model) throw new Error('模型已改变，请重新核对');
      if (images?.length) { const status = await visionStatus(); signal.throwIfAborted(); if (!status.available) throw new Error(status.reason); }
      let response: Response;
      try {
        const url = new URL(`${base.replace(/\/$/, '')}/chat/completions`);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
        response = await fetch(url, { method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, stream: false, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: images?.length ? [{ type: 'text', text: prompt }, ...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`, detail: 'original' } }))] : prompt }] }) });
      } catch {
        signal.throwIfAborted(); throw new Error('模型连接失败，请检查服务地址和网络后重试');
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`模型调用失败（HTTP ${response.status}），请检查模型配置或额度`); }
      const data = await boundedJson(response);
      const choice = data.choices?.[0];
      if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string' || !choice.message.content.trim()) throw new Error('模型未返回完整正文，可能达到输出上限，请缩小范围后重试');
      return choice.message.content;
    },
  };
}
