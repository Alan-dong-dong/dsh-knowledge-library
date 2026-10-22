import type { Context } from '@deepseek-ai/cordis';
import type { ImageBlock, LlmRuntime, TextBlock } from '@deepseek-ai/dsh-llm';
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model';

export interface ModelRequest { system: string; prompt: string; signal: AbortSignal; expectedModel?: string; images?: Array<{ data: Uint8Array; mediaType: ImageMediaType; name?: string }> }
export interface VisionStatus { available: boolean; model?: string; reason?: string }
export interface KnowledgeModel {
  status(): { available: boolean; model?: string; reason?: string };
  generate(request: ModelRequest): Promise<string>;
  visionStatus?(): Promise<VisionStatus>;
}
const unavailable = '请先在 Harness 设置中配置默认模型；独立预览可通过环境变量配置模型。';
class ModelResponseError extends Error {}
function outputLimitMessage() {
  return '模型输出达到当前模型或服务的长度上限。插件沿用模型默认输出配置，未另设 token 上限；思考可能与正文共用额度，本次未自动重试。请检查模型配置，或分批整理后主动重试。';
}
function failureMessage(value: unknown, fallback: string): string {
  // Only expose known classifications and numeric HTTP status, never provider
  // messages, URLs, bodies or arbitrary codes that may contain credentials.
  const failure = value && typeof value === 'object' ? value as { code?: unknown; status?: unknown } : {};
  const reasons: Record<string, string> = {
    CONTEXT_WINDOW_EXCEEDED: '模型上下文容量不足，请减少本次所选资料后主动重试',
    QUOTA: '模型账户额度或余额不足，请检查服务商账户',
    ACCOUNT_QUOTA: '模型账户额度不足，请在 Harness 中检查账户额度',
    EMPTY_RESPONSE: '模型服务返回空响应，请稍后主动重试',
    INVALID_CREDENTIAL: '模型凭据无效，请检查 Harness 模型认证设置',
    MISSING_CREDENTIAL: '缺少模型凭据，请在 Harness 中配置模型认证',
    RATE_LIMIT: '模型服务请求频率受限，请稍后主动重试',
  };
  const status = typeof failure.status === 'number' && Number.isInteger(failure.status) && failure.status >= 400 && failure.status <= 599 ? failure.status : undefined;
  const known = typeof failure.code === 'string' && Object.hasOwn(reasons, failure.code) ? reasons[failure.code] : undefined;
  const reason = known || (status === 401 || status === 403 ? '模型服务拒绝认证或访问，请检查模型凭据及权限'
    : status === 402 ? '模型服务要求补充账户额度，请检查服务商账户'
    : status === 429 ? '模型服务请求频率或额度受限，请稍后重试并检查账户额度'
    : status !== undefined && status >= 500 ? '模型服务暂时不可用，请稍后主动重试'
    : fallback);
  return `${reason}${status === undefined ? '' : `（HTTP ${status}）`}；本次未自动重试。`;
}
const toolCallMessage = '模型返回了工具调用，未形成完整知识正文。请检查模型配置后主动重试；插件未执行工具，也未自动重试。';
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
    async generate({ system, prompt, signal, images, expectedModel }) {
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
        content.push(...refs.map(attachment => ({ type: 'image' as const, attachment })));
      }
      const current = services().selection;
      if (current.provider !== selection.provider || current.model !== selection.model || current.reasoningEffort !== selection.reasoningEffort) throw new Error('模型配置已改变，请重新核对');
      let text = ''; let finished = false;
      // Omit maxTokens so the Harness runtime materializes the model's own defaults.
      try { for await (const chunk of llm.stream({ ...selection, system, messages: [{ role: 'user', content }], signal })) {
        signal.throwIfAborted();
        // Complete blocks are authoritative; deltas may include reasoning or retries.
        if (chunk.type === 'block-end' && chunk.block.type === 'text') text += chunk.block.text;
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') throw new ModelResponseError(toolCallMessage);
        if (text.length > 60_000) throw new ModelResponseError('模型输出过长，请缩小整理范围');
        if (chunk.type === 'finish') {
          if (chunk.reason.kind === 'max-tokens') throw new ModelResponseError(outputLimitMessage());
          if (chunk.reason.kind === 'tool-calls') throw new ModelResponseError(toolCallMessage);
          if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') throw new ModelResponseError(failureMessage(chunk.reason.failure, chunk.reason.kind === 'aborted' ? '模型调用被中断，未返回完整正文，请检查服务连接后主动重试' : '模型服务返回错误，请检查 Harness 模型配置或网络后主动重试'));
          if (chunk.reason.kind !== 'stop') throw new ModelResponseError('模型返回未识别的结束状态，未保存不完整正文；请检查 Harness 模型配置后主动重试。');
          finished = true;
        }
      } } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ModelResponseError) throw error;
        throw new Error(failureMessage(error, '模型调用失败，请检查 Harness 模型配置或网络后主动重试'));
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
    async generate({ system, prompt, signal, images, expectedModel }) {
      checkImages(images);
      if (!key) throw new Error(unavailable);
      if (expectedModel !== undefined && expectedModel !== model) throw new Error('模型已改变，请重新核对');
      signal.throwIfAborted();
      if (images?.length) { const info = await visionStatus(); signal.throwIfAborted(); if (!info.available) throw new Error(info.reason); }
      let response: Response;
      try {
        const url = new URL(`${base.replace(/\/$/, '')}/chat/completions`);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
        response = await fetch(url, { method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: images?.length ? [{ type: 'text', text: prompt }, ...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`, detail: 'original' } }))] : prompt }] }) });
      } catch {
        signal.throwIfAborted(); throw new Error('模型连接失败，请检查服务地址和网络后重试');
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`模型调用失败（HTTP ${response.status}），请检查模型配置或额度`); }
      const data = await boundedJson(response);
      const choice = data.choices?.[0];
      if (choice?.finish_reason === 'length' || choice?.finish_reason === 'max_tokens') throw new Error(outputLimitMessage());
      if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string' || !choice.message.content.trim()) throw new Error('模型未返回完整正文，可能达到输出上限，请缩小范围后重试');
      return choice.message.content;
    },
  };
}
