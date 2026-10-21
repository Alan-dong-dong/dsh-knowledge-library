// Isolated Harness test provider. This module is never part of the npm package.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'knowledge-model-fixture';
export const inject = ['llm'];
class FixtureAdapter extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: 'Knowledge fixture' }; }
  async listModels(provider) { return [{ provider, id: 'knowledge-fixture', name: 'Knowledge fixture' }]; }
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 64_000 } }; }
  async *stream(options) {
    const base = process.env.KNOWLEDGE_TEST_PROVIDER;
    if (!base?.startsWith('http://127.0.0.1:')) throw new Error('Fixture provider must be local');
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST', signal: options.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: options.model, max_tokens: options.maxTokens, messages: [{ role: 'system', content: options.system }, ...options.messages.map(m => ({ role: m.role, content: m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') }))] }) });
    if (!response.ok) throw new Error(`Fixture provider HTTP ${response.status}`);
    const data = await response.json(); const text = data.choices[0].message.content;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx) { ctx.llm.registerAdapter(['knowledge-test'], new FixtureAdapter()); }
