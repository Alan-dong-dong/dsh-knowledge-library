// Isolated Harness test provider. This module is never part of the npm package.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'knowledge-model-fixture';
export const inject = ['llm', 'attachments'];
class FixtureAdapter extends LlmAdapter {
  constructor(ctx) { super(); this.ctx = ctx; }
  providerInfo(provider) { return { id: provider, name: 'Knowledge fixture' }; }
  async listModels(provider) { return [{ provider, id: 'knowledge-fixture', name: 'Knowledge fixture', inputModalities: ['text', 'image'] }]; }
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 64_000 }, inputModalities: ['text', 'image'] }; }
  async *stream(options) {
    const base = process.env.KNOWLEDGE_TEST_PROVIDER;
    if (!base?.startsWith('http://127.0.0.1:')) throw new Error('Fixture provider must be local');
    const messages = await Promise.all(options.messages.map(async m => {
      if (!m.content.some(b => b.type === 'image')) return { role: m.role, content: m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') };
      const content = await Promise.all(m.content.map(async b => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type !== 'image') throw new Error('Unexpected fixture content');
        const stored = await this.ctx.attachments.readImage(b.attachment, options.signal);
        return { type: 'image_url', image_url: { url: `data:${b.attachment.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` } };
      }));
      return { role: m.role, content };
    }));
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST', signal: options.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: options.model, max_tokens: options.maxTokens, messages: [{ role: 'system', content: options.system }, ...messages] }) });
    if (!response.ok) throw new Error(`Fixture provider HTTP ${response.status}`);
    const data = await response.json(); const text = data.choices[0].message.content;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx) { ctx.llm.registerAdapter(['knowledge-test'], new FixtureAdapter(ctx)); }
