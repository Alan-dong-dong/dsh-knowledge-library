import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { Library } from '../src/core/library.js';
import { KnowledgeQueue } from '../src/core/knowledge.js';
import { ImportQueue } from '../src/core/jobs.js';
import { createHandler, API_PATH } from '../src/http.js';
import { recallNotes } from '../src/core/incremental.js';
import type { KnowledgeModel } from '../src/knowledge-model.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-incremental-'));
  let library = new Library(root);
  const old = library.captureText('Agent可靠性依赖可验证证据。', { title: 'Agent证据' }).material;
  const target = library.saveNote('## Agent可靠性\n保留来源证据。\n\n## 局限\n原有结论需要核实。', [{ materialId: old.id, segmentId: old.segments[0].id }], { title: 'Agent可靠性实践', category: '技术/AI', tags: ['旧标签'] }).material;
  const source = library.captureText('Agent失败恢复必须有停止条件；增加调用预算。', { title: 'Agent恢复条件' }).material;
  const citation = { materialId: source.id, segmentId: source.segments[0].id };
  const draft = { title: 'Agent可靠性恢复', content: `## Agent可靠性\n预算与停止条件。 library://${source.id}/${citation.segmentId}`, tags: ['可靠性'], citations: [citation] };
  let action = 'append'; let bad = ''; let calls = 0;
  const prompts: string[] = [];
  const model: KnowledgeModel = { status: () => ({ available: true, model: 'local / incremental' }), async generate(request) {
    calls++; prompts.push(request.prompt);
    if (request.prompt.includes('任务：增量知识对比')) return JSON.stringify({ action, noteId: bad === 'target' ? 'r_00000000-0000-0000-0000-000000000000' : target.id, reason: '围绕同一具体问题，新增失败恢复条件', overlaps: ['保留证据'], additions: action === 'append' ? ['设置停止条件'] : [], conflicts: ['旧结论的适用范围仍需核实'], content: action === 'append' ? `## 新增条件\n明确预算和停止条件。 library://${source.id}/${bad === 'citation' ? 'invented' : citation.segmentId}` : '' });
    return JSON.stringify(draft);
  } };
  let queue = new KnowledgeQueue(library, model);
  return { root, source, old, target, draft, prompts, model, get calls() { return calls; }, get library() { return library; }, get queue() { return queue; }, action(value: string) { action = value; }, bad(value: string) { bad = value; },
    async run() { const job = queue.add([source.id], 'Agent可靠性'); await queue.idle(); return queue.get(job.id); },
    async reopen(change?: () => void) { await queue.close(); library.close(); change?.(); library = new Library(root); queue = new KnowledgeQueue(library, model); },
    async cleanup() { await queue.close(); library.close(); assert.ok(root.startsWith(join(tmpdir(), 'dsh-incremental-'))); rmSync(root, { recursive: true, force: true }); } };
}

test('incremental comparison is read-only until confirmation; append retains ID, old paragraphs and citations across restart', async () => {
  const f = fixture();
  try {
    const job = await f.run(); assert.equal(job.status, 'draft', job.error);
    assert.equal(job.integration!.recommendation, 'append'); assert.equal(f.calls, 2);
    assert.ok(f.prompts[1].includes(JSON.stringify(f.target.content).slice(1, -1)));
    assert.equal(f.library.get(f.target.id).content, f.target.content);
    assert.equal(f.library.stats().notes, 1);
    const edited = f.queue.edit(job.id, job.draft, 1, { choice: 'append', content: job.integration!.content + '\n我的核对：保留适用边界。' });
    assert.throws(() => f.queue.confirm(job.id, 1), /已改变/);
    const saved = f.queue.confirm(job.id, edited.draftVersion).material;
    assert.equal(saved.id, f.target.id); assert.equal(saved.revision, 2); assert.ok(saved.content.startsWith(f.target.content));
    assert.deepEqual(saved.segments.slice(0, f.target.segments.length), f.target.segments);
    assert.equal(saved.citations.length, 2); assert.deepEqual(saved.tags, ['旧标签', '可靠性']);
    assert.equal(f.queue.confirm(job.id, 0).material.revision, 2);
    assert.equal(f.library.get(f.source.id).content, f.source.content);
    await f.reopen(); assert.equal(f.library.get(saved.id).content, saved.content); assert.equal(f.calls, 2);
    assert.equal(f.queue.overview().states[f.source.id].noteIds[0], saved.id);
    assert.equal(f.queue.overview().states[f.source.id].status, 'completed');
    const history = JSON.parse(readFileSync(join(saved.path, '.history', job.id + '.json'), 'utf8'));
    assert.equal(history.before.content, f.target.content); assert.equal(history.after.meta.revision, 2);
  } finally { await f.cleanup(); }
});

test('append and edited additions retain verified body citations omitted from the original draft list', async () => {
  const f = fixture();
  try {
    const source = f.library.captureText('Agent可靠性第一条。\n\nAgent可靠性第二条。\n\nAgent可靠性第三条。').material;
    const ref = (index: number) => '`library://' + source.id + '/' + source.segments[index].id + '`';
    f.model.generate = async request => request.prompt.includes('任务：增量知识对比')
      ? JSON.stringify({ action: 'append', noteId: f.target.id, reason: '补充Agent可靠性', overlaps: [], additions: ['补充'], conflicts: [], content: ref(1) })
      : JSON.stringify({ ...f.draft, content: 'Agent可靠性 ' + ref(0), citations: [{ materialId: source.id, segmentId: source.segments[0].id }] });
    const pending = f.queue.add([source.id], 'Agent可靠性'); await f.queue.idle(); const job = f.queue.get(pending.id);
    assert.equal(job.status, 'draft', job.error);
    assert.deepEqual(job.draft!.citations.map(c => c.segmentId), source.segments.slice(0, 2).map(s => s.id));
    const edited = f.queue.edit(job.id, job.draft, 1, { choice: 'append', content: job.integration!.content + '\n' + ref(2) });
    assert.deepEqual(edited.draft!.citations.map(c => c.segmentId), source.segments.map(s => s.id));
    const note = f.queue.confirm(job.id, edited.draftVersion).material;
    assert.equal(note.id, f.target.id);
    assert.deepEqual(note.citations.filter(c => c.materialId === source.id).map(c => c.segmentId), source.segments.map(s => s.id));
    assert.ok(note.content.includes(ref(1)) && note.content.includes(ref(2)));
  } finally { await f.cleanup(); }
});

test('user can choose a separate note even when an append target changed or was deleted', async () => {
  const f = fixture();
  try {
    const job = await f.run(); f.library.update(f.target.id, { tags: ['用户修改'] });
    assert.throws(() => f.queue.confirm(job.id, 1), /已有笔记已改变/);
    f.library.trash(f.target.id);
    const edited = f.queue.edit(job.id, job.draft, 1, { choice: 'new', content: job.integration!.content });
    const note = f.queue.confirm(job.id, edited.draftVersion).material;
    assert.notEqual(note.id, f.target.id); assert.equal(note.content, job.draft!.content);
    assert.equal(f.library.get(f.target.id).content, f.target.content);
  } finally { await f.cleanup(); }
});

test('duplicate knowledge links new evidence without repeating the body and can still be saved separately', async () => {
  const f = fixture();
  try {
    f.action('duplicate'); const job = await f.run();
    assert.equal(job.integration!.recommendation, 'duplicate');
    assert.throws(() => f.queue.edit(job.id, job.draft, 1, { choice: 'append', content: 'overwrite' }), /已核对/);
    const saved = f.queue.confirm(job.id, 1).material;
    assert.equal(saved.content, f.target.content); assert.deepEqual(saved.segments, f.target.segments);
    assert.equal(saved.citations.length, 2); assert.equal(saved.revision, 2);
    assert.equal(f.queue.confirm(job.id, 1).material.revision, 2);
  } finally { await f.cleanup(); }
});

for (const bad of ['target', 'citation']) test(`comparison cannot use a fabricated ${bad}`, async () => {
  const f = fixture();
  try { f.bad(bad); const job = await f.run(); assert.equal(job.status, 'failed'); assert.match(job.error!, /笔记|引用/); assert.equal(f.library.get(f.target.id).revision, 1); }
  finally { await f.cleanup(); }
});

test('new-topic recommendation creates a new note and leaves the candidate unchanged', async () => {
  const f = fixture();
  try { f.action('new'); const job = await f.run(); assert.equal(job.integration!.recommendation, 'new'); const note = f.queue.confirm(job.id, 1).material; assert.notEqual(note.id, f.target.id); assert.equal(f.library.get(f.target.id).content, f.target.content); }
  finally { await f.cleanup(); }
});

test('index failure rolls back all canonical note files; retry appends exactly once', async () => {
  const f = fixture();
  try {
    const job = await f.run();
    f.library.db.exec(`CREATE TRIGGER fail_update BEFORE INSERT ON materials WHEN NEW.id='${f.target.id}' AND json_extract(NEW.meta, '$.revision')=2 BEGIN SELECT RAISE(ABORT, 'injected index failure'); END;`);
    assert.throws(() => f.queue.confirm(job.id, 1), /injected/);
    assert.equal(readFileSync(join(f.target.path, 'content.md'), 'utf8'), f.target.content);
    assert.deepEqual(JSON.parse(readFileSync(join(f.target.path, 'segments.json'), 'utf8')), f.target.segments);
    assert.equal(f.library.get(f.target.id).revision, 1);
    f.library.db.exec('DROP TRIGGER fail_update'); await f.reopen();
    const note = f.queue.confirm(job.id, 1).material; assert.equal(note.revision, 2); assert.equal(f.queue.confirm(job.id, 1).material.revision, 2);
  } finally { await f.cleanup(); }
});

for (const phase of ['prepared', 'committed']) test(`restart recovers ${phase} note update after partial file writes without model calls`, async () => {
  const f = fixture();
  try {
    const job = await f.run(); const saved = f.queue.confirm(job.id, 1).material;
    await f.reopen(() => {
      const history = join(saved.path, '.history', job.id + '.json');
      const update = JSON.parse(readFileSync(history, 'utf8')); update.phase = phase;
      const journal = join(f.root, '.system/note-update.json'); renameSync(history, journal); writeFileSync(journal, JSON.stringify(update));
      writeFileSync(join(saved.path, 'content.md'), 'interrupted partial write');
      const records = JSON.parse(readFileSync(join(f.root, '.system/knowledge-jobs.json'), 'utf8')); records[0].status = 'draft'; delete records[0].noteId; writeFileSync(join(f.root, '.system/knowledge-jobs.json'), JSON.stringify(records));
    });
    assert.equal(f.calls, 2);
    assert.equal(f.library.get(saved.id).content, phase === 'committed' ? saved.content : f.target.content);
    assert.equal(f.queue.get(job.id).status, phase === 'committed' ? 'completed' : 'draft');
    if (phase === 'prepared') assert.equal(f.queue.confirm(job.id, 1).material.revision, 2);
    assert.ok(!existsSync(join(f.root, '.system/note-update.json')));
  } finally { await f.cleanup(); }
});

test('bounded recall excludes trash and oversized bodies; selected candidates are complete', async () => {
  const f = fixture();
  try {
    const trashed = f.library.saveNote('Agent恢复证据', [], { title: 'Agent回收站' }).material; f.library.trash(trashed.id);
    f.library.saveNote('Agent可靠性'.repeat(11_000), [], { title: 'Agent长文' });
    const recalled = recallNotes(f.library, f.draft, 'Agent可靠性', [f.source]);
    assert.ok(!recalled.candidates.some(n => n.id === trashed.id)); assert.equal(recalled.search.oversized, 1);
    assert.equal(recalled.candidates[0].content, f.target.content); assert.equal(recalled.search.scanned, 2);
  } finally { await f.cleanup(); }
});

test('appended note history moves with the note and is removed when its trash is permanently cleared', async () => {
  const f = fixture();
  try {
    const job = await f.run(); f.queue.confirm(job.id, 1);
    const moved = f.library.update(f.target.id, { category: '知识/已整理' });
    assert.ok(existsSync(join(moved.path, '.history', job.id + '.json')));
    f.library.trash(moved.id); f.library.emptyTrash(f.library.trashSnapshot().token);
    assert.ok(!existsSync(moved.path)); await f.reopen(); assert.equal(f.library.has(moved.id), false);
  } finally { await f.cleanup(); }
});

test('HTTP integration choice requires a valid version and explicit confirmation before updating a note', async () => {
  const f = fixture(); const imports = new ImportQueue(f.library); let origin = '';
  const server = createServer(createHandler(f.library, imports, () => origin, undefined, f.queue));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const send = (path: string, data: unknown, method = 'POST') => fetch(origin + API_PATH + path, { method, headers: { 'Content-Type': 'application/json', 'X-Knowledge-Library': '1' }, body: JSON.stringify(data) });
  try {
    const job = await f.run(); const path = `/knowledge/jobs/${job.id}`;
    assert.equal((await send(path, { expectedRoot: 'old', version: 1, draft: job.draft }, 'PATCH')).status, 400);
    const edited = await send(path, { expectedRoot: f.root, version: 1, draft: job.draft, integration: { choice: 'append', content: job.integration!.content } }, 'PATCH'); assert.equal(edited.status, 200);
    assert.equal((await send(path + '/confirm', { expectedRoot: f.root, version: 2 })).status, 400);
    assert.equal(f.library.get(f.target.id).revision, 1);
    assert.equal((await send(path + '/confirm', { expectedRoot: f.root, version: 2, confirmed: true })).status, 400);
    assert.equal((await send(path + '/confirm', { expectedRoot: f.root, version: 2, confirmed: true, integrationChoice: 'append' })).status, 200);
    assert.equal(f.library.get(f.target.id).revision, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await imports.close(); await f.cleanup(); }
});
