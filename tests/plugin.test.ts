import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context, Service } from '@deepseek-ai/cordis';
import { ToolRuntime, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import * as plugin from '../src/index.js';
import { LlmRuntime, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { createServer } from 'node:http';

test('native Cordis plugin registers typed DSH tools, unloads cleanly and reopens the same library', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-test-'));
  const ctx = new Context();
  const routes = new Map<string, unknown>();
  class TestWebServer extends Service {
    constructor(ctx: Context) { super(ctx, 'webServer'); }
    getOrigin() { return 'http://127.0.0.1:4317'; }
    register(route: { path: string }) {
      assert.equal(routes.has(route.path), false, 'old HTTP route must be disposed before reloading');
      routes.set(route.path, route);
      return () => { routes.delete(route.path); };
    }
  }
  const webServer = ctx.plugin(TestWebServer);
  await webServer.await();
  const prompt = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await prompt.await();
  const runtime = ctx.plugin(ToolRuntime, { mode: 'native' });
  await runtime.await();
  let libraryPlugin = ctx.plugin(plugin, { root });
  const exec = { signal: new AbortController().signal } as ToolRunContext;
  try {
    await libraryPlugin.await();
    assert.equal(routes.size, 1);
    const tool = ctx.tools.get('library_capture');
    assert.ok(tool);
    await assert.rejects(tool.execute({ type: 'wrong', content: 'x' }, exec), /type|enum/);
    const saved = await tool.execute({ type: 'text', content: '插件通过原生工具保存的知识资料。', title: '原生工具验证', category: '测试' }, exec) as any;
    assert.equal(saved.status, 'ready');
    const read = await ctx.tools.get('library_read')!.execute({ id: saved.id }, exec) as any;
    assert.equal(read.segments[0].citation, `library://${saved.id}/p0001`);
    assert.equal(read.segments[0].text, '插件通过原生工具保存的知识资料。');
    await libraryPlugin.dispose();
    assert.equal(routes.size, 0);
    assert.equal(ctx.tools.get('library_capture'), undefined);
    libraryPlugin = ctx.plugin(plugin, { root });
    await libraryPlugin.await();
    assert.equal(routes.size, 1);
    const search = await ctx.tools.get('library_search')!.execute({ query: '知识' }, exec) as any;
    assert.equal(search.items[0].id, saved.id);
    const note = await ctx.tools.get('library_save_note')!.execute({ content: '测试结论', title: '测试笔记', citations: [{ materialId: saved.id, segmentId: 'p0001' }] }, exec) as any;
    assert.equal(note.kind, 'note');
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(ctx.tools.get('library_read')!.execute({ id: saved.id }, { signal: aborted.signal } as ToolRunContext));
  } finally {
    await libraryPlugin.dispose(); await runtime.dispose(); await prompt.dispose(); await webServer.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('native Cordis model runtime and registered tools generate a confirmable draft through the actual HTTP route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-knowledge-test-'));
  const ctx = new Context(); let origin = ''; let route: any; let calls = 0;
  class Web extends Service {
    constructor(ctx: Context) { super(ctx, 'webServer'); }
    getOrigin() { return origin; }
    register(value: any) { route = value; return () => { route = undefined; }; }
  }
  class Defaults extends Service {
    constructor(ctx: Context) { super(ctx, 'agentDefaultModel'); }
    currentSelection() { return { provider: 'knowledge-test', model: 'knowledge-fixture' }; }
  }
  class Adapter extends LlmAdapter {
    providerInfo(provider: string) { return { id: provider, name: 'Isolated knowledge test' }; }
    async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 64_000 } }; }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls++; assert.equal(options.provider, 'knowledge-test'); assert.equal(options.tools, undefined);
      const input = options.messages[0].content[0]; assert.equal(input.type, 'text');
      const sources = JSON.parse((input as any).text.match(/来源目录：([^\n]+)/)[1]);
      const text = JSON.stringify({ title: '宿主原生模型笔记', content: '## 核心观点\n保持证据与理解的联系。', tags: ['宿主'], citations: sources.map((s: any) => ({ materialId: s.materialId, segmentId: s.segmentIds[0] })) });
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const web = ctx.plugin(Web); await web.await();
  const defaults = ctx.plugin(Defaults); await defaults.await();
  const prompt = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false }); await prompt.await();
  const tools = ctx.plugin(ToolRuntime, { mode: 'native' }); await tools.await();
  const llm = ctx.plugin(LlmRuntime); await llm.await();
  const unregister = ctx.llm.registerAdapter(['knowledge-test'], new Adapter());
  const server = createServer((req, res) => { void route.handler(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  let library = ctx.plugin(plugin, { root }); await library.await();
  const exec = { signal: new AbortController().signal } as ToolRunContext;
  try {
    const captured = await ctx.tools.get('library_capture')!.execute({ type: 'text', content: '知识笔记需要可核验的来源。', title: '原生来源' }, exec) as any;
    const job = await ctx.tools.get('library_knowledge_generate')!.execute({ sourceIds: [captured.id], topic: '证据' }, exec) as any;
    let state: any;
    for (let i = 0; i < 100; i++) {
      state = await ctx.tools.get('library_knowledge_status')!.execute({ id: job.id }, exec);
      if (state.status === 'draft' || state.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(state.status, 'draft', state.error); assert.equal(calls, 1);
    assert.equal((await (await fetch(origin + '/knowledge-library/api/stats')).json() as any).notes, 0);
    const response = await fetch(origin + `/knowledge-library/api/knowledge/jobs/${job.id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Knowledge-Library': '1' }, body: JSON.stringify({ expectedRoot: root, version: state.draftVersion, confirmed: true }) });
    assert.equal(response.status, 200); const saved = await response.json() as any;
    assert.equal(saved.material.title, '宿主原生模型笔记');
    await library.dispose(); library = ctx.plugin(plugin, { root }); await library.await();
    const overview = await (await fetch(origin + '/knowledge-library/api/knowledge')).json() as any;
    assert.deepEqual(overview.states[captured.id].noteIds, [saved.material.id]);
    assert.equal(calls, 1, 'reload must not call the model again');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); await library.dispose(); unregister(); await llm.dispose(); await tools.dispose(); await prompt.dispose(); await defaults.dispose(); await web.dispose();
    assert.ok(root.startsWith(join(tmpdir(), 'dsh-native-knowledge-test-'))); rmSync(root, { recursive: true, force: true });
  }
});
