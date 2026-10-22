import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { Library } from '../src/core/library.js';
import { KnowledgeQueue } from '../src/core/knowledge.js';
import { ImportQueue } from '../src/core/jobs.js';
import { createHandler, API_PATH } from '../src/http.js';
import { previewKnowledgeModel, harnessKnowledgeModel, type KnowledgeModel, type ModelRequest } from '../src/knowledge-model.js';
import type { MaterialDetail } from '../src/types.js';

function response(sources: MaterialDetail[]) {
  return JSON.stringify({ title: '可复用的知识', content: `## 核心观点\n从证据形成理解。\n\n## 关键概念\n区分资料和知识。\n\n## 可复用方法\n采集、核验、归纳。\n\n## 适用条件与局限\n仅基于所选资料。\n\n## 待验证问题\n其他情境是否成立？\n\n${sources.map(s => `library://${s.id}/${s.segments[0].id}`).join('\n')}`, tags: ['知识管理'], citations: sources.map(s => ({ materialId: s.id, segmentId: s.segments[0].id })) });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-knowledge-test-'));
  let library = new Library(root);
  let sources = [library.captureText('知识需要归纳证据，保留来源和适用条件。', { title: '来源一' }).material];
  const requests: ModelRequest[] = [];
  let generate: KnowledgeModel['generate'] = async request => request.prompt.includes('不超过1500字') ? `证据提炼 library://${sources[0].id}/p0001` : response(sources);
  const model: KnowledgeModel = { status: () => ({ available: true, model: 'test / isolated' }), generate: async request => { requests.push(request); return generate(request); } };
  let knowledge = new KnowledgeQueue(library, model);
  return { root, get library() { return library; }, get knowledge() { return knowledge; }, model, requests, get sources() { return sources; }, setSources(items: MaterialDetail[]) { sources = items; }, setGenerate(fn: KnowledgeModel['generate']) { generate = fn; },
    async reopen(beforeOpen?: () => void) { await knowledge.close(); library.close(); beforeOpen?.(); library = new Library(root); knowledge = new KnowledgeQueue(library, model); },
    async cleanup() { await knowledge.close(); library.close(); assert.ok(root.startsWith(join(tmpdir(), 'dsh-knowledge-test-'))); rmSync(root, { recursive: true, force: true }); } };
}

test('generation persists an editable draft, confirms once, preserves originals and links states across restart', async () => {
  const f = fixture();
  try {
    const source = f.sources[0]; const original = readFileSync(join(source.path, 'content.md'));
    const job = f.knowledge.add([source.id], '资料到知识');
    assert.equal(f.knowledge.add([source.id], '资料到知识').id, job.id);
    await f.knowledge.idle();
    assert.equal(f.knowledge.get(job.id).status, 'draft');
    assert.equal(f.library.stats().notes, 0, 'generation must not publish notes');
    assert.equal(f.knowledge.overview().states[source.id].status, 'draft');
    await f.reopen();
    const draft = f.knowledge.get(job.id).draft!;
    const edited = f.knowledge.edit(job.id, { ...draft, title: '我的知识笔记', content: draft.content + '\n\n我的理解：先核验，再复用。' }, 1);
    assert.throws(() => f.knowledge.confirm(job.id, 1), /草稿已改变/);
    const saved = f.knowledge.confirm(job.id, edited.draftVersion, '知识笔记/实践');
    assert.equal(saved.material.kind, 'note'); assert.equal(saved.material.title, '我的知识笔记');
    assert.equal(saved.material.category, '知识笔记/实践');
    assert.equal(saved.material.knowledgeJobId, job.id);
    assert.equal(f.knowledge.confirm(job.id, edited.draftVersion).material.id, saved.material.id);
    assert.deepEqual(readFileSync(join(source.path, 'content.md')), original);
    assert.equal(f.library.stats().notes, 1);
    await f.reopen();
    assert.equal(f.knowledge.overview().states[source.id].status, 'completed');
    assert.deepEqual(f.knowledge.overview().states[source.id].noteIds, [saved.material.id]);
    assert.match(f.library.exportMarkdown(saved.material.id), new RegExp(source.id));
    f.library.trash(saved.material.id);
    assert.equal(f.knowledge.overview().states[source.id].status, 'pending');
  } finally { await f.cleanup(); }
});

test('batch generation covers long content including the end, and never silently truncates or accepts oversized input', async () => {
  const f = fixture();
  try {
    const long = f.library.captureText('起始证据。\n\n' + '跨段内容需要完整处理。'.repeat(1800) + '\n\n末尾关键条件XYZ', { title: '长文' }).material;
    f.setSources([...f.sources, long]);
    f.setGenerate(async request => {
      assert.equal(request.expectedModel, 'test / isolated');
      if (request.prompt.includes('不超过1500字')) { assert.ok(request.maxTokens >= 16_384, 'leave room for reasoning and summary output'); return `证据提炼 library://${f.sources[0].id}/p0001`; }
      assert.ok(request.maxTokens >= 32_768); return response(f.sources);
    });
    const job = f.knowledge.add(f.sources.map(s => s.id), '跨来源综合', 'compose');
    await f.knowledge.idle();
    assert.equal(f.knowledge.get(job.id).status, 'draft', f.knowledge.get(job.id).error);
    assert.ok(f.requests.length > 2);
    assert.ok(f.requests.some(r => r.prompt.includes('末尾关键条件XYZ')));
    assert.equal(f.knowledge.get(job.id).draft!.citations.length, 2);
    const huge = f.library.captureText('界'.repeat(100_001)).material;
    assert.throws(() => f.knowledge.add([huge.id]), /10 万字/);
  } finally { await f.cleanup(); }
});

test('unconfigured models, archived-only files, notes and trashed sources are rejected before dispatch', async () => {
  const f = fixture();
  try {
    const unavailable = new KnowledgeQueue(f.library, { status: () => ({ available: false, reason: '未配置测试模型' }), async generate() { throw new Error('must not call'); } });
    assert.throws(() => unavailable.add([f.sources[0].id]), /未配置/); await unavailable.close();
    assert.throws(() => f.knowledge.add([]), /1 至 10/);
    const archived = f.library.importBytes('clip.mp4', Buffer.from('video bytes')).material;
    assert.throws(() => f.knowledge.add([archived.id]), /仅归档/);
    const note = f.library.saveNote('个人理解', [], {}).material;
    assert.throws(() => f.knowledge.add([note.id]), /原始资料/);
    f.library.trash(f.sources[0].id);
    assert.throws(() => f.knowledge.add([f.sources[0].id]), /回收站/);
    assert.equal(f.requests.length, 0);
  } finally { await f.cleanup(); }
});

test('a pre-grouping multi-source draft without mode or metadata snapshots remains confirmable after upgrade', async () => {
  const f = fixture();
  try {
    f.setSources([...f.sources, f.library.captureText('第二份同主题资料保留其旧版引用。').material]);
    const job = f.knowledge.add(f.sources.map(s => s.id), '旧版直接综合', 'compose'); await f.knowledge.idle();
    const file = join(f.root, '.system', 'knowledge-jobs.json');
    await f.reopen(() => {
      const records = JSON.parse(readFileSync(file, 'utf8')); delete records[0].mode; delete records[0].modelCalls;
      for (const source of records[0].sources) { delete source.category; delete source.tags; }
      writeFileSync(file, JSON.stringify(records));
    });
    assert.equal(f.knowledge.get(job.id).status, 'draft');
    const saved = f.knowledge.confirm(job.id, 1);
    assert.equal(saved.material.citations.length, 2); assert.equal(f.library.stats().notes, 1);
  } finally { await f.cleanup(); }
});

test('foreign and fabricated citations fail without publishing, and an explicit retry can succeed', async () => {
  const f = fixture();
  try {
    f.setGenerate(async () => JSON.stringify({ ...JSON.parse(response(f.sources)), citations: [{ materialId: f.sources[0].id, segmentId: 'fake' }] }));
    const failed = f.knowledge.add([f.sources[0].id]); await f.knowledge.idle();
    assert.equal(f.knowledge.get(failed.id).status, 'failed');
    assert.match(f.knowledge.get(failed.id).error!, /引用/);
    assert.equal(f.library.stats().notes, 0);
    f.setGenerate(async () => response(f.sources));
    const retry = f.knowledge.add([f.sources[0].id]); await f.knowledge.idle();
    assert.notEqual(failed.id, retry.id); assert.equal(f.knowledge.get(retry.id).status, 'draft');
    assert.throws(() => f.knowledge.add([f.sources[0].id], 'different'), /进行中/);
    f.knowledge.discard(retry.id);
    assert.equal(f.knowledge.get(retry.id).draft, undefined);
  } finally { await f.cleanup(); }
});

test('cancellation prevents late completion from becoming a draft; source deletion prevents confirmation', async () => {
  const f = fixture();
  try {
    let release!: (value: string) => void;
    f.setGenerate(() => new Promise<string>(resolve => { release = resolve; }));
    const running = f.knowledge.add([f.sources[0].id]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.knowledge.get(running.id).status, 'running');
    f.knowledge.cancel(running.id); release(response(f.sources)); await f.knowledge.idle();
    assert.equal(f.knowledge.get(running.id).status, 'cancelled');
    assert.equal(f.knowledge.get(running.id).draft, undefined);
    f.setGenerate(async () => response(f.sources));
    const job = f.knowledge.add([f.sources[0].id]); await f.knowledge.idle();
    f.library.trash(f.sources[0].id);
    assert.throws(() => f.knowledge.confirm(job.id, 1), /回收站/);
    assert.equal(f.library.stats().notes, 0);
    f.library.restore(f.sources[0].id);
    f.library.db.prepare('UPDATE materials SET content=? WHERE id=?').run('来源正文已变化', f.sources[0].id);
    assert.throws(() => f.knowledge.confirm(job.id, 1), /正文已改变/);
  } finally { await f.cleanup(); }
});

test('body-only invented references and model changes cannot become a valid knowledge draft', async () => {
  const f = fixture();
  try {
    f.setGenerate(async () => JSON.stringify({ ...JSON.parse(response(f.sources)), content: '虚构引用 library://INVENTED/p9999' }));
    const invalid = f.knowledge.add([f.sources[0].id]); await f.knowledge.idle();
    assert.equal(f.knowledge.get(invalid.id).status, 'failed'); assert.match(f.knowledge.get(invalid.id).error!, /无法核验/);
    const changed = f.knowledge.add([f.sources[0].id]);
    f.model.status = () => ({ available: true, model: 'different-model' });
    const calls = f.requests.length;
    await f.knowledge.idle();
    assert.match(f.knowledge.get(changed.id).error!, /模型配置已改变/);
    assert.equal(f.requests.length, calls);
  } finally { await f.cleanup(); }
});

test('restart marks interrupted calls failed without spending model calls; an already-written note repairs confirmation state', async () => {
  const f = fixture();
  try {
    const job = f.knowledge.add([f.sources[0].id]); await f.knowledge.idle();
    const record = f.knowledge.get(job.id);
    const file = join(f.root, '.system', 'knowledge-jobs.json');
    const calls = f.requests.length;
    await f.reopen(() => writeFileSync(file, JSON.stringify([{ ...record, status: 'running', draft: undefined }])));
    assert.equal(f.knowledge.get(job.id).status, 'failed'); assert.equal(f.requests.length, calls);
    const retry = f.knowledge.add([f.sources[0].id]); await f.knowledge.idle();
    const ready = f.knowledge.get(retry.id);
    const saved = f.knowledge.confirm(retry.id, 1);
    await f.reopen(() => writeFileSync(file, JSON.stringify([record, ready])));
    assert.equal(f.knowledge.get(retry.id).noteId, saved.material.id);
    assert.equal(f.knowledge.get(retry.id).status, 'completed'); assert.equal(f.library.stats().notes, 1);
  } finally { await f.cleanup(); }
});

test('knowledge HTTP routes enforce same-origin, current root, version and explicit confirmation', async () => {
  const f = fixture(); const queue = new ImportQueue(f.library); let origin = '';
  const server = createServer(createHandler(f.library, queue, () => origin, undefined, f.knowledge));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const send = (path: string, body: any, method = 'POST', extra = {}) => fetch(origin + API_PATH + path, { method, headers: { 'Content-Type': 'application/json', 'X-Knowledge-Library': '1', ...extra }, body: JSON.stringify({ expectedRoot: f.root, ...body }) });
  try {
    assert.equal((await send('/knowledge/jobs', { sourceIds: [f.sources[0].id], expectedRoot: 'old' })).status, 400);
    assert.equal((await send('/knowledge/jobs', { sourceIds: [f.sources[0].id] }, 'POST', { Origin: 'https://evil.example' })).status, 403);
    const created = await send('/knowledge/jobs', { sourceIds: [f.sources[0].id] }); assert.equal(created.status, 202);
    const job = await created.json() as any; await f.knowledge.idle();
    const path = `/knowledge/jobs/${job.id}`;
    assert.equal((await send(path + '/confirm', { version: 1 })).status, 400);
    assert.equal((await send(path + '/confirm', { version: 0, confirmed: true })).status, 400);
    const saved = await send(path + '/confirm', { version: 1, confirmed: true, category: '知识笔记' }); assert.equal(saved.status, 200);
    assert.equal((await (await fetch(origin + API_PATH + '/knowledge')).json() as any).states[f.sources[0].id].status, 'completed');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await queue.close(); await f.cleanup(); }
});

test('preview model uses the actual compatible HTTP protocol without exposing credentials or provider error bodies', async () => {
  let mode = 'success'; let count = 0;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer private-test-key');
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-model', max_tokens: 4096 }] })); return; }
    count++; assert.equal(req.url, '/v1/chat/completions');
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.model, 'fixture-model'); assert.equal(body.messages[0].role, 'system');
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'error') { res.writeHead(401); res.end(JSON.stringify({ error: 'private-test-key secret detail' })); }
    else res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '完整模型正文' } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const model = previewKnowledgeModel({ KNOWLEDGE_LIBRARY_MODEL_API_KEY: 'private-test-key', KNOWLEDGE_LIBRARY_MODEL: 'fixture-model', KNOWLEDGE_LIBRARY_MODEL_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/v1` });
  try {
    assert.ok(!JSON.stringify(model.status()).includes('private-test-key'));
    assert.equal(await model.generate({ system: '只读资料', prompt: '测试', maxTokens: 100, signal: new AbortController().signal }), '完整模型正文');
    mode = 'error'; await assert.rejects(model.generate({ system: 'system', prompt: 'test', maxTokens: 100, signal: new AbortController().signal }), error => { assert.match((error as Error).message, /401/); assert.doesNotMatch((error as Error).message, /private-test-key/); return true; });
    assert.equal(count, 2);
    assert.equal(previewKnowledgeModel({}).status().available, false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Harness model adapter consumes completed text blocks and refuses incomplete provider results', async () => {
  let maxTokens = false;
  const services = {
    llm: { listProviders: () => [{ id: 'test' }], async *stream(options: any) { assert.equal(options.provider, 'test'); assert.equal(options.model, 'fixture'); assert.equal(options.tools, undefined); assert.equal(options.messages[0].content[0].text, '资料'); yield { type: 'text-delta', index: 0, text: '正文' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: '正文' } }; yield { type: 'finish', reason: { kind: maxTokens ? 'max-tokens' : 'stop' } }; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'fixture' }) },
  };
  const model = harnessKnowledgeModel({ get: (name: keyof typeof services) => services[name] } as any);
  assert.equal(model.status().available, true);
  const request = { system: '规则', prompt: '资料', maxTokens: 100, signal: new AbortController().signal };
  assert.equal(await model.generate(request), '正文');
  maxTokens = true; await assert.rejects(model.generate(request), /长度上限/);
});

test('Harness respects the adapter allowance and max reasoning, reports the real cutoff and never retries truncation', async () => {
  let calls = 0; let truncated = false;
  const services = {
    llm: {
      listProviders: () => [{ id: 'test' }],
      resolveModelInfo: async () => ({ defaultMaxTokens: 8192 }),
      async *stream(options: any) {
        calls++; assert.equal(options.maxTokens, 8192); assert.equal(options.reasoningEffort, 'max');
        assert.equal(options.provider, 'test'); assert.equal(options.model, 'fixture');
        yield { type: 'block-end', block: { type: 'text', text: '有界正文' } };
        yield { type: 'finish', reason: { kind: truncated ? 'max-tokens' : 'stop' } };
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'fixture', reasoningEffort: 'max' }) },
  };
  const model = harnessKnowledgeModel({ get: (name: keyof typeof services) => services[name] } as any);
  const request = { system: '规则', prompt: '资料', maxTokens: 32_768, expectedModel: 'test / fixture', signal: new AbortController().signal };
  assert.equal(await model.generate(request), '有界正文');
  truncated = true; await assert.rejects(model.generate(request), /8192 tokens.*未自动重试/); assert.equal(calls, 2);
});

test('async model metadata cannot silently change the selected model before dispatch', async () => {
  let selected = 'first'; let calls = 0;
  const services = {
    llm: { listProviders: () => [{ id: 'test' }], resolveModelInfo: async () => { selected = 'changed'; return { defaultMaxTokens: 16384 }; }, async *stream() { calls++; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: selected }) },
  };
  const model = harnessKnowledgeModel({ get: (name: keyof typeof services) => services[name] } as any);
  await assert.rejects(model.generate({ system: 'rules', prompt: 'text', maxTokens: 16384, expectedModel: 'test / first', signal: new AbortController().signal }), /模型配置已改变/);
  assert.equal(calls, 0);
});

test('unknown capacity preserves the stage budget; a failed capacity lookup dispatches no inference or private error detail', async () => {
  let fail = false; let calls = 0;
  const services = {
    llm: { listProviders: () => [{ id: 'test' }], resolveModelInfo: async () => { if (fail) throw new Error('private-provider-detail'); return {}; }, async *stream(options: any) { calls++; assert.equal(options.maxTokens, 16384); yield { type: 'block-end', block: { type: 'text', text: '完整正文' } }; yield { type: 'finish', reason: { kind: 'stop' } }; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'fixture' }) },
  };
  const model = harnessKnowledgeModel({ get: (name: keyof typeof services) => services[name] } as any);
  const request = { system: 'rules', prompt: 'text', maxTokens: 16384, signal: new AbortController().signal };
  assert.equal(await model.generate(request), '完整正文'); fail = true;
  await assert.rejects(model.generate(request), error => { assert.match((error as Error).message, /输出额度/); assert.doesNotMatch((error as Error).message, /private-provider-detail/); return true; });
  assert.equal(calls, 1);
});

test('preview observes disclosed output capacity and rejects partial text without a second completion request', async () => {
  const budgets: number[] = []; let cap: number | undefined = 8192; let truncated = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'fixture', ...(cap ? { max_tokens: cap } : {}) }] })); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString()); budgets.push(request.max_tokens);
    res.end(JSON.stringify({ choices: [{ finish_reason: truncated ? 'length' : 'stop', message: { content: truncated ? '不完整正文' : '完整正文' } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { KNOWLEDGE_LIBRARY_MODEL_API_KEY: 'isolated-key', KNOWLEDGE_LIBRARY_MODEL: 'fixture', KNOWLEDGE_LIBRARY_MODEL_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/v1` };
  const request = { system: 'rules', prompt: 'text', maxTokens: 32_768, signal: new AbortController().signal };
  try {
    const model = previewKnowledgeModel(env);
    assert.equal(await model.generate(request), '完整正文'); truncated = true;
    await assert.rejects(model.generate(request), /8192 tokens.*未自动重试/); assert.deepEqual(budgets, [8192, 8192]);
    cap = undefined; truncated = false; assert.equal(await previewKnowledgeModel(env).generate(request), '完整正文'); assert.equal(budgets[2], 32_768, 'unknown metadata must not invent a smaller cap');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
