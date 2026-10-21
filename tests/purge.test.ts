import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { Library } from '../src/core/library.js';
import { PurgeStore } from '../src/core/purge.js';

function fixture() {
  const prefix = join(tmpdir(), 'dsh-purge-test-');
  const root = mkdtempSync(prefix);
  let library = new Library(root);
  return { root, get library() { return library; }, reopen() { library.close(); library = new Library(root); }, cleanup() { library.close(); assert.ok(root.startsWith(prefix)); rmSync(root, { recursive: true, force: true }); } };
}

test('empty trash removes canonical files and index, keeps active notes, and cannot resurrect after restart/rebuild', () => {
  const f = fixture();
  try {
    const source = f.library.importBytes('source.md', Buffer.from('永久清空应移除这份原文件和正文。')).material;
    const keep = f.library.captureText('活动资料始终保留。').material;
    const note = f.library.saveNote('笔记正文始终保留。', [{ materialId: source.id, segmentId: 'p0001' }], { category: '笔记' }).material;
    f.library.trash(source.id);
    assert.equal(f.library.trashSnapshot().count, 1);
    const result = f.library.emptyTrash(f.library.trashSnapshot().token);
    assert.deepEqual(result, { deleted: 1, pending: 0, errors: [] });
    assert.equal(existsSync(source.path), false);
    assert.equal(f.library.has(source.id), false);
    assert.throws(() => f.library.restore(source.id), /资料不存在/);
    assert.equal(f.library.get(keep.id).content, keep.content);
    assert.match(f.library.exportMarkdown(note.id), /笔记正文始终保留/);
    assert.match(f.library.exportMarkdown(note.id), /来源已永久删除/);
    assert.equal(f.library.search({ trashed: true }).total, 0);
    f.library.rebuild(); f.reopen();
    assert.equal(f.library.has(source.id), false);
    assert.equal(f.library.stats().total, 2);
    assert.equal(f.library.stats().trashed, 0);
    assert.deepEqual(f.library.emptyTrash(f.library.trashSnapshot().token), { deleted: 0, pending: 0, errors: [] });
    const newRecord = f.library.importBytes('source.md', Buffer.from('永久清空应移除这份原文件和正文。')).material;
    assert.notEqual(newRecord.id, source.id);
  } finally { f.cleanup(); }
});

test('confirmation becomes invalid after a restore/redelete or new trash item; no files are removed', () => {
  const f = fixture();
  try {
    const source = f.library.captureText('快照验证一。').material;
    f.library.trash(source.id);
    const before = f.library.trashSnapshot();
    f.library.restore(source.id); f.library.trash(source.id);
    assert.throws(() => f.library.emptyTrash(before.token), /内容已改变/);
    const current = f.library.trashSnapshot();
    const another = f.library.captureText('快照验证二。').material; f.library.trash(another.id);
    assert.throws(() => f.library.emptyTrash(current.token), /内容已改变/);
    assert.ok(existsSync(source.path)); assert.ok(existsSync(another.path));
  } finally { f.cleanup(); }
});

test('index failure restores the full directory and leaves the item restorable', () => {
  const f = fixture();
  try {
    const source = f.library.importBytes('original.txt', Buffer.from('索引失败时原文件保持完整。')).material;
    f.library.trash(source.id);
    const bytes = f.library.original(source.id).bytes;
    f.library.db.exec("CREATE TRIGGER reject_purge BEFORE DELETE ON materials BEGIN SELECT RAISE(ABORT, 'injected purge failure'); END;");
    const result = f.library.emptyTrash(f.library.trashSnapshot().token);
    assert.equal(result.deleted, 0); assert.equal(result.pending, 0); assert.match(result.errors[0], /injected purge failure/);
    assert.deepEqual(f.library.original(source.id).bytes, bytes);
    assert.equal(f.library.search({ trashed: true }).total, 1);
    f.library.db.exec('DROP TRIGGER reject_purge');
    assert.equal(f.library.restore(source.id).id, source.id);
  } finally { f.cleanup(); }
});

test('file removal failure remains retryable even after partial removal; restart completes confirmed cleanup', t => {
  const f = fixture();
  try {
    const source = f.library.captureText('文件占用失败验证。').material; f.library.trash(source.id);
    t.mock.method(fs, 'rmSync', ((path: string) => {
      const content = join(path, 'content.md'); if (existsSync(content)) unlinkSync(content);
      throw Object.assign(new Error('injected file lock'), { code: 'EBUSY' });
    }) as typeof fs.rmSync); syncBuiltinESMExports();
    const result = f.library.emptyTrash(f.library.trashSnapshot().token);
    assert.equal(result.deleted, 1); assert.equal(result.pending, 1); assert.match(result.errors[0], /文件清理未完成/);
    assert.equal(f.library.has(source.id), false);
    const ticket = new PurgeStore(f.root).list()[0]; assert.ok(existsSync(ticket.staged));
    assert.equal(existsSync(join(ticket.staged, 'content.md')), false);
    t.mock.restoreAll(); syncBuiltinESMExports();
    f.reopen();
    assert.equal(new PurgeStore(f.root).list().length, 0);
    assert.equal(existsSync(ticket.staged), false);
    assert.equal(f.library.has(source.id), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); f.cleanup(); }
});

test('restart handles interruption before and after the confirmed directory move', () => {
  const f = fixture();
  try {
    const beforeMove = f.library.captureText('尚未移动的资料。').material; f.library.trash(beforeMove.id);
    const store = new PurgeStore(f.root); mkdirSync(store.directory, { recursive: true });
    writeFileSync(join(store.directory, `${beforeMove.id}.json`), JSON.stringify({ schemaVersion: 1, id: beforeMove.id, source: relative(f.root, beforeMove.path) }));
    f.reopen();
    assert.ok(f.library.get(beforeMove.id).deletedAt);
    const afterMove = f.library.captureText('已确认移动的资料。').material; f.library.trash(afterMove.id);
    const ticket = store.stage(afterMove.id, afterMove.path);
    f.reopen();
    assert.equal(f.library.has(afterMove.id), false);
    assert.equal(existsSync(ticket.staged), false);
    assert.ok(f.library.has(beforeMove.id));
  } finally { f.cleanup(); }
});

test('path tampering and a junction inside a material cannot delete unrelated files', () => {
  const f = fixture();
  const other = fixture();
  let link: string | undefined;
  try {
    const source = f.library.captureText('受路径保护的回收站资料。').material; f.library.trash(source.id);
    const active = f.library.captureText('活动资料不得删除。').material;
    f.library.db.prepare('UPDATE materials SET path=? WHERE id=?').run(active.path, source.id);
    assert.throws(() => f.library.emptyTrash(f.library.trashSnapshot().token), /目录不一致/);
    f.library.db.prepare('UPDATE materials SET path=? WHERE id=?').run(source.path, source.id);
    link = join(source.path, 'outside');
    symlinkSync(other.root, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.library.emptyTrash(f.library.trashSnapshot().token), /符号链接/);
    assert.ok(existsSync(join(other.root, '.system', 'index.sqlite')));
    assert.ok(existsSync(active.path)); assert.ok(existsSync(source.path));
  } finally { if (link && existsSync(link)) unlinkSync(link); f.cleanup(); other.cleanup(); }
});
