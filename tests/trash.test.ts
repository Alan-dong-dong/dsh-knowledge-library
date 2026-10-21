import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src/core/library.js';

const html = '<html><head><title>可恢复的网页资料</title></head><body><article><p>这份中文资料用于验证删除后的回收站、原始正文、文件归档和来源引用仍然完整保留。</p><p>恢复之后，应当使用相同的资料标识和段落引用，继续按原来的分类、标签与专题进行检索。</p></article></body></html>';

function fixture() {
  const prefix = join(tmpdir(), 'dsh-trash-test-');
  const root = mkdtempSync(prefix);
  let library = new Library(root);
  return {
    root,
    get library() { return library; },
    reopenWithoutIndex() { library.close(); unlinkSync(join(root, '.system', 'index.sqlite')); library = new Library(root); },
    cleanup() { library.close(); assert.ok(root.startsWith(prefix)); rmSync(root, { recursive: true, force: true }); },
  };
}

test('trash hides collection/search/stats while preserving files and references through index loss and restart', () => {
  const f = fixture();
  try {
    const source = f.library.captureHtml(html, 'https://example.com/article', { tags: ['待读'], collection: '专题' }).material;
    const original = f.library.original(source.id).bytes;
    const note = f.library.saveNote('保留来源的知识笔记。', [{ materialId: source.id, segmentId: source.segments[0].id }], { category: '知识笔记' }).material;
    const removed = f.library.trash(source.id);
    assert.ok(removed.deletedAt);
    assert.equal(f.library.trash(source.id).deletedAt, removed.deletedAt);
    assert.equal(f.library.search({ category: '收件箱' }).total, 0);
    assert.equal(f.library.search({ query: '中文资料' }).total, 0);
    assert.equal(f.library.stats().total, 1);
    assert.equal(f.library.stats().inbox, 0);
    assert.equal(f.library.stats().trashed, 1);
    assert.equal(f.library.stats().tags.length, 0);
    assert.equal(f.library.search({ trashed: true, tag: '待读', collection: '专题' }).items[0].id, source.id);
    assert.deepEqual(f.library.get(source.id).segments, source.segments);
    assert.deepEqual(f.library.original(source.id).bytes, original);
    assert.match(f.library.exportMarkdown(note.id), new RegExp(source.id));
    assert.throws(() => f.library.update(source.id, { title: '意外编辑' }), /先从回收站恢复/);
    f.reopenWithoutIndex();
    assert.equal(f.library.search({ query: '中文资料' }).total, 0);
    assert.equal(f.library.search({ trashed: true }).items[0].id, source.id);
    assert.match(f.library.exportMarkdown(note.id), /可恢复的网页资料/);
    const restored = f.library.restore(source.id);
    assert.equal(restored.deletedAt, undefined);
    assert.equal(restored.category, source.category);
    assert.deepEqual(restored.segments, source.segments);
    assert.equal(restored.contentHash, source.contentHash);
    assert.deepEqual(f.library.original(source.id).bytes, original);
    assert.equal(f.library.search({ category: '收件箱' }).items[0].id, source.id);
    assert.equal(f.library.stats().trashed, 0);
    assert.equal(f.library.restore(source.id).updatedAt, restored.updatedAt);
  } finally { f.cleanup(); }
});

test('collecting identical trashed content restores its original record instead of returning a hidden duplicate', () => {
  const f = fixture();
  try {
    const source = f.library.captureHtml(html, 'https://example.com/article', { category: '研究/技术' }).material;
    f.library.trash(source.id);
    const captured = f.library.captureHtml(html, 'https://example.com/article');
    assert.equal(captured.duplicate, true);
    assert.equal(captured.material.id, source.id);
    assert.equal(captured.material.deletedAt, undefined);
    assert.equal(captured.material.category, '研究/技术');
    assert.equal(f.library.stats().total, 1);
    assert.equal(f.library.stats().trashed, 0);
  } finally { f.cleanup(); }
});

test('index failures roll back trash/restore metadata and preserve the previous visible state', () => {
  const f = fixture();
  try {
    const item = f.library.captureText('事务失败不会删除这份资料。').material;
    for (const operation of ['trash', 'restore'] as const) {
      const before = readFileSync(join(item.path, 'metadata.json'), 'utf8');
      const visible = f.library.stats().total;
      f.library.db.exec("CREATE TRIGGER reject_change BEFORE INSERT ON materials BEGIN SELECT RAISE(ABORT, 'injected index failure'); END;");
      assert.throws(() => f.library[operation](item.id), /injected index failure/);
      assert.equal(readFileSync(join(item.path, 'metadata.json'), 'utf8'), before);
      assert.equal(f.library.stats().total, visible);
      f.library.db.exec('DROP TRIGGER reject_change');
      f.library[operation](item.id);
    }
    assert.equal(f.library.get(item.id).deletedAt, undefined);
    assert.throws(() => f.library.trash('r_unknown'), /资料不存在/);
    assert.throws(() => f.library.restore('../outside'), /资料不存在/);
  } finally { f.cleanup(); }
});
