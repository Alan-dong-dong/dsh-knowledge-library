import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { Library } from '../src/core/library.js';
import { KnowledgeQueue } from '../src/core/knowledge.js';
import { ImportQueue } from '../src/core/jobs.js';
import { createHandler, API_PATH } from '../src/http.js';
import type { KnowledgeModel } from '../src/knowledge-model.js';
import type { GroupingPlan } from '../src/types.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-grouping-test-'));
  let library = new Library(root);
  const sources = [
    library.captureText('Agent可靠性依赖可验证的工具结果。', { title: 'AI证据', tags: ['保留'] }).material,
    library.captureText('为Agent工具调用设置失败恢复与停止条件。', { title: 'AI恢复' }).material,
    library.captureText('投资风险需要与资金期限相匹配。', { title: '投资' }).material,
    library.captureText('片段缺少上下文，不能判断它说明什么。', { title: '未知' }).material,
  ];
  let calls = 0; let bad: 'duplicate' | 'omitted' | 'foreign' | undefined;
  const requests: string[] = [];
  const model: KnowledgeModel = {
    status: () => ({ available: true, model: 'isolated / grouping' }),
    async generate(request) {
      calls++;
      requests.push(request.prompt);
      if (request.prompt.includes('不超过1500字')) return '分段证据提炼，保持适用条件与引用。';
      if (request.prompt.includes('任务：逐篇分析')) {
        const directory = JSON.parse(request.prompt.match(/来源目录：([^\n]+)/)![1]); const source = sources.find(s => s.id === directory[0].materialId)!;
        return JSON.stringify({ sourceId: source.id, theme: source.title, concepts: ['证据'], summary: source.content.slice(0, 2400), usage: '形成可复用的理解', category: source.title.startsWith('AI') ? '技术/AI' : '生活/投资', tags: ['建议'], certainty: source.title === '未知' ? 'uncertain' : 'clear', uncertainty: source.title === '未知' ? '缺少上下文' : '', citations: [{ materialId: source.id, segmentId: source.segments[0].id }] });
      }
      if (request.prompt.includes('任务：智能分组')) {
        const groups = [
          { title: 'Agent可靠性', reason: '同一问题下证据与失败恢复相互补充', sourceIds: [sources[0].id, sources[1].id], category: '技术/AI', tags: ['可靠性'] },
          { title: '投资期限', reason: '与Agent无关，独立整理投资条件', sourceIds: [sources[2].id], category: '生活/投资', tags: ['风险'] },
          // Intentionally group uncertain evidence: the engine must conservatively unassign it.
          { title: '信息片段', reason: '待进一步理解', sourceIds: [sources[3].id], category: '片段', tags: [] },
        ];
        if (bad === 'duplicate') groups[1].sourceIds.push(sources[0].id);
        if (bad === 'omitted') groups.pop();
        if (bad === 'foreign') groups[1].sourceIds.push('r_00000000-0000-0000-0000-000000000000');
        return JSON.stringify({ groups, unassigned: [] });
      }
      const directory = JSON.parse(request.prompt.match(/来源目录：([^\n]+)/)![1]);
      return JSON.stringify({ title: '独立知识草稿', content: '## 核心观点\n基于本组证据整理。', tags: ['知识'], citations: directory.map((s: any) => ({ materialId: s.materialId, segmentId: s.segmentIds[0] })) });
    },
  };
  let queue = new KnowledgeQueue(library, model);
  return { root, sources, requests, model, get library() { return library; }, get queue() { return queue; }, get calls() { return calls; }, bad(value: typeof bad) { bad = value; },
    async plan() { const job = queue.add(sources.map(s => s.id)); await queue.idle(); return queue.get(job.id); },
    async reopen(before?: () => void) { await queue.close(); library.close(); before?.(); library = new Library(root); queue = new KnowledgeQueue(library, model); },
    async cleanup() { await queue.close(); library.close(); assert.ok(root.startsWith(join(tmpdir(), 'dsh-grouping-test-'))); rmSync(root, { recursive: true, force: true }); },
  };
}

test('heterogeneous input is analyzed individually, partitioned conservatively, and only changes folders after confirmation', async () => {
  const f = fixture();
  try {
    const job = await f.plan(); assert.equal(job.mode, 'smart'); assert.equal(job.status, 'grouping', job.error);
    assert.equal(f.calls, 5); assert.equal(job.analyses!.length, 4);
    assert.deepEqual(job.plan!.groups.map(g => g.sourceIds.length), [2, 1]);
    assert.equal(job.plan!.unassigned[0].sourceId, f.sources[3].id);
    for (const source of f.sources) { assert.ok(existsSync(source.path)); assert.equal(f.library.get(source.id).category, '收件箱'); }
    assert.equal(f.library.stats().notes, 0);
    const confirmed = f.queue.confirmPlan(job.id, 1, true);
    assert.equal(confirmed.status, 'grouped'); assert.equal(confirmed.children!.length, 2);
    assert.deepEqual(f.queue.confirmPlan(job.id, 1, true).children, confirmed.children);
    assert.equal(f.library.get(f.sources[0].id).category, '技术/AI');
    assert.deepEqual(f.library.get(f.sources[0].id).tags, ['保留', '可靠性']);
    assert.equal(f.library.get(f.sources[3].id).category, '收件箱');
    assert.ok(existsSync(f.library.get(f.sources[0].id).path));
    assert.equal(f.library.get(f.sources[0].id).content, f.sources[0].content);
    await f.queue.idle();
    const children = confirmed.children!.map(c => f.queue.get(c.jobId));
    assert.deepEqual(children.map(c => c.status), ['draft', 'draft']);
    assert.deepEqual(children.map(c => c.sourceIds.length), [2, 1]);
    assert.equal(f.queue.overview().states[f.sources[3].id].status, 'pending');
    const note = f.queue.confirm(children[0].id, 1).material;
    assert.equal(note.citations.length, 2);
    assert.ok(!note.citations.some(c => c.materialId === f.sources[2].id));
    const beforeCalls = f.calls; await f.reopen();
    assert.equal(f.queue.get(job.id).children!.length, 2); assert.equal(f.calls, beforeCalls);
    assert.equal(f.queue.overview().states[f.sources[0].id].status, 'completed');
  } finally { await f.cleanup(); }
});

test('confirmed classification generates and saves child notes with Markdown-wrapped body citations', async () => {
  const f = fixture();
  try {
    const original = f.model.generate.bind(f.model);
    f.model.generate = async request => {
      const output = await original(request);
      if (request.prompt.includes('任务：')) return output;
      const data = JSON.parse(output);
      data.content += '\n' + data.citations.map((c: any) => '`library://' + c.materialId + '/' + c.segmentId + '`').join('\n');
      data.citations = [];
      return JSON.stringify(data);
    };
    const parent = await f.plan(); const grouped = f.queue.confirmPlan(parent.id, 1, true);
    await f.queue.idle();
    for (const child of grouped.children!) {
      const job = f.queue.get(child.jobId); assert.equal(job.status, 'draft', job.error);
      assert.equal(job.draft!.citations.length, job.sourceIds.length);
      const note = f.queue.confirm(job.id, 1).material;
      for (const id of job.sourceIds) {
        const source = f.library.get(id);
        assert.notEqual(source.category, '收件箱'); assert.ok(existsSync(source.path));
        assert.equal(source.content, f.sources.find(s => s.id === id)!.content);
        assert.ok(note.citations.some(c => c.materialId === id && source.segments.some(s => s.id === c.segmentId)));
      }
    }
    assert.equal(f.calls, 7, 'classification and child drafts must not need repair calls');
    assert.equal(f.library.stats().notes, 2);
    await f.reopen(); assert.equal(f.calls, 7); assert.equal(f.library.stats().notes, 2);
  } finally { await f.cleanup(); }
});

test('plan editing can split, reassign or leave everything pending; stale and invalid partitions are refused', async () => {
  const f = fixture();
  try {
    const job = await f.plan(); const plan = structuredClone(job.plan!);
    assert.throws(() => f.queue.editPlan(job.id, { ...plan, unassigned: [] }, 1), /遗漏/);
    plan.groups[0].sourceIds.pop();
    plan.unassigned.push({ sourceId: f.sources[1].id, reason: '先独立阅读，再决定是否综合' });
    const edited = f.queue.editPlan(job.id, plan, 1);
    assert.throws(() => f.queue.confirmPlan(job.id, 1), /已改变/);
    await f.reopen(); assert.equal(f.queue.get(job.id).planVersion, 2);
    const allPending: GroupingPlan = { groups: [], unassigned: f.sources.map(s => ({ sourceId: s.id, reason: '保留待整理' })) };
    const pending = f.queue.editPlan(job.id, allPending, edited.planVersion);
    const result = f.queue.confirmPlan(job.id, pending.planVersion, true);
    assert.deepEqual(result.children, []); assert.equal(f.calls, 5);
    for (const source of f.sources) assert.equal(f.queue.overview().states[source.id].status, 'pending');
  } finally { await f.cleanup(); }
});

for (const invalid of ['duplicate', 'omitted', 'foreign'] as const) test(`invalid model partition ${invalid} cannot move files or create notes`, async () => {
  const f = fixture();
  try {
    f.bad(invalid); const job = await f.plan();
    assert.equal(job.status, 'failed'); assert.match(job.error!, /重复、遗漏或超出/);
    assert.equal(f.library.stats().notes, 0);
    for (const source of f.sources) assert.equal(f.library.get(source.id).path, source.path);
  } finally { await f.cleanup(); }
});

test('partial classification and index failure preserve files and resume after a real reopen without duplicate children', async () => {
  const f = fixture();
  try {
    const job = await f.plan(); const second = job.plan!.groups.flatMap(g => g.sourceIds)[1];
    f.library.db.exec(`CREATE TRIGGER fail_classification BEFORE INSERT ON materials WHEN NEW.id='${second}' AND json_extract(NEW.meta, '$.category') <> '收件箱' BEGIN SELECT RAISE(ABORT, 'injected classification failure'); END;`);
    assert.throws(() => f.queue.confirmPlan(job.id, 1), /未完成/);
    const partial = f.queue.get(job.id);
    assert.equal(partial.classification!.steps.filter(s => s.done).length, 1);
    assert.equal(f.library.get(second).category, '收件箱'); assert.ok(existsSync(f.library.get(second).path));
    assert.throws(() => f.queue.editPlan(job.id, job.plan, 1), /已开始/);
    f.library.db.exec('DROP TRIGGER fail_classification');
    const file = join(f.root, '.system', 'knowledge-jobs.json');
    const interruptedStep = partial.classification!.steps.find(s => s.sourceId === second)!;
    const oldPath = f.library.get(second).path;
    await f.reopen(() => {
      const records = JSON.parse(readFileSync(file, 'utf8')); records[0].status = 'classifying'; writeFileSync(file, JSON.stringify(records));
      // Crash after directory rename but before metadata/index update: category and tags differ in phase.
      const target = join(f.root, 'materials', ...interruptedStep.after.category.split('/'), second);
      assert.ok(oldPath.startsWith(f.root) && target.startsWith(f.root));
      mkdirSync(dirname(target), { recursive: true }); renameSync(oldPath, target);
    });
    assert.match(f.queue.get(job.id).error!, /上次归类被中断/);
    const confirmed = f.queue.confirmPlan(job.id, 1); await f.queue.idle();
    assert.equal(confirmed.children!.length, 2);
    assert.equal(f.queue.confirmPlan(job.id, 1).children!.length, 2);
    assert.equal(f.queue.overview().jobs.filter(j => j.parentId === job.id).length, 2);
  } finally { await f.cleanup(); }
});

test('smart analysis reads the end of long sources before proposing a grouping', async () => {
  const f = fixture();
  try {
    f.sources[0] = f.library.captureText('开头证据。\n\n' + '需要完整读取的长文。'.repeat(1800) + '\n\n智能分析末尾标记XYZ', { title: 'AI长文' }).material;
    const job = await f.plan(); assert.equal(job.status, 'grouping', job.error);
    assert.ok(f.requests.some(prompt => prompt.includes('智能分析末尾标记XYZ')));
    assert.ok(f.calls > f.sources.length + 1);
  } finally { await f.cleanup(); }
});

test('a linked classification target is refused before any source moves', async () => {
  const f = fixture(); const other = fixture(); const link = join(f.root, 'materials', 'outside-link');
  try {
    const job = await f.plan(); const plan = structuredClone(job.plan!); plan.groups[0].category = 'outside-link';
    symlinkSync(other.root, link, process.platform === 'win32' ? 'junction' : 'dir');
    const edited = f.queue.editPlan(job.id, plan, 1);
    assert.throws(() => f.queue.confirmPlan(job.id, edited.planVersion), /符号链接/);
    for (const source of f.sources) assert.equal(f.library.get(source.id).path, source.path);
    assert.equal(f.queue.get(job.id).classification, undefined);
  } finally { if (existsSync(link)) unlinkSync(link); await f.cleanup(); await other.cleanup(); }
});

test('partially applied classification can be rolled back and discarded without changing source text or tags', async () => {
  const f = fixture();
  try {
    const job = await f.plan(); const second = job.plan!.groups.flatMap(g => g.sourceIds)[1];
    f.library.db.exec(`CREATE TRIGGER fail_classification BEFORE INSERT ON materials WHEN NEW.id='${second}' AND json_extract(NEW.meta, '$.category') <> '收件箱' BEGIN SELECT RAISE(ABORT, 'locked source'); END;`);
    assert.throws(() => f.queue.confirmPlan(job.id, 1), /未完成/);
    assert.throws(() => f.queue.discard(job.id), /先回退/);
    f.library.db.exec('DROP TRIGGER fail_classification');
    const rolled = f.queue.rollbackPlan(job.id); assert.equal(rolled.planVersion, 2); assert.equal(rolled.classification, undefined);
    for (const source of f.sources) {
      assert.equal(f.library.get(source.id).path, source.path);
      assert.deepEqual(f.library.get(source.id).tags, source.tags);
      assert.equal(f.library.get(source.id).content, source.content);
    }
    f.queue.discard(job.id); await f.reopen(); assert.equal(f.queue.get(job.id).status, 'discarded');
  } finally { await f.cleanup(); }
});

test('external metadata changes invalidate classification and disabling folder sync leaves originals untouched', async () => {
  const f = fixture();
  try {
    const job = await f.plan(); f.library.update(f.sources[0].id, { tags: ['用户新增'] });
    assert.throws(() => f.queue.confirmPlan(job.id, 1), /分类或标签已改变/);
    assert.equal(f.queue.get(job.id).classification, undefined);
    const result = f.queue.confirmPlan(job.id, 1, false); await f.queue.idle();
    assert.equal(result.children!.length, 2);
    assert.deepEqual(f.library.get(f.sources[0].id).tags, ['用户新增']);
    assert.equal(f.library.get(f.sources[0].id).category, '收件箱');
  } finally { await f.cleanup(); }
});

test('grouping HTTP confirmation enforces root, version and explicit user confirmation', async () => {
  const f = fixture(); const imports = new ImportQueue(f.library); let origin = '';
  const server = createServer(createHandler(f.library, imports, () => origin, undefined, f.queue));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (path: string, value: unknown) => fetch(origin + API_PATH + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Knowledge-Library': '1' }, body: JSON.stringify(value) });
  try {
    const job = await f.plan(); const path = `/knowledge/jobs/${job.id}/confirm-plan`;
    assert.equal((await post(path, { expectedRoot: f.root, version: 1 })).status, 400);
    assert.equal((await post(path, { expectedRoot: 'old', version: 1, confirmed: true })).status, 400);
    assert.equal((await post(path, { expectedRoot: f.root, version: 0, confirmed: true })).status, 400);
    assert.equal((await post(path, { expectedRoot: f.root, version: 1, confirmed: true, expectedModel: 'stale-model' })).status, 400);
    assert.equal((await post(path, { expectedRoot: f.root, version: 1, confirmed: true, applyClassification: false })).status, 200);
    await f.queue.idle();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await imports.close(); await f.cleanup(); }
});
