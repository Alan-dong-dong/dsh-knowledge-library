import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library, categoryName } from '../src/core/library.js';
import { ImportQueue } from '../src/core/jobs.js';
import { isPublicAddress, fetchPublicPage, permittedAddress } from '../src/core/fetch.js';
import { parseSubtitles } from '../src/core/extract.js';

const article = '<html><head><title>混合检索实践</title></head><body><article><h1>混合检索实践</h1><p>混合检索将关键词检索和语义检索结合，在查询包含专有名词、产品型号、技术术语时保留精确匹配。</p><p>召回之后可以使用重排模型，把更符合用户意图的结果放在前面，最终保留每条结论的原文出处。</p><script>window.injected=true</script></article></body></html>';
const verification = readFileSync(new URL('./fixtures/wechat-verification.html', import.meta.url), 'utf8');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-library-test-'));
  const library = new Library(root);
  return { root, library, cleanup: () => { library.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('Chinese retrieval, physical classification, deduplication and persistence survive reopening and index loss', () => {
  const f = fixture();
  try {
    const first = f.library.captureText('混合检索让关键词与语义互补。\n\n需要用真实查询验证召回质量。', { title: '检索实践', tags: ['RAG'], category: '技术/AI', collection: '检索调研' });
    assert.equal(first.duplicate, false);
    assert.ok(existsSync(join(f.root, 'materials', '技术', 'AI', first.material.id, 'content.md')));
    assert.equal(f.library.captureText(first.material.content).duplicate, true);
    assert.equal(f.library.search({ query: '检索' }).total, 1);
    assert.equal(f.library.search({ query: '关键词' }).items[0].matches[0].id, 'p0001');
    assert.equal(f.library.search({ query: '" OR 1=1' }).total, 0);
    assert.equal(f.library.search({ collection: '其他' }).total, 0);
    f.library.update(first.material.id, { category: '研究/方法', tags: ['已读'], title: '新的标题' });
    assert.equal(f.library.get(first.material.id).segments[0].text, '混合检索让关键词与语义互补。');
    assert.ok(existsSync(join(f.root, 'materials', '研究', '方法', first.material.id)));
    f.library.close();
    rmSync(join(f.root, '.system', 'index.sqlite'));
    const reopened = new Library(f.root);
    try {
      assert.equal(reopened.get(first.material.id).title, '新的标题');
      assert.equal(reopened.search({ query: '语义', tag: '已读' }).total, 1);
      assert.equal(reopened.stats().total, 1);
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('web article preserves source and raw HTML without executing scripts', () => {
  const f = fixture();
  try {
    const saved = f.library.captureHtml(article, 'https://example.com/retrieval');
    assert.equal(saved.material.kind, 'web');
    assert.equal(saved.material.sourceUrl, 'https://example.com/retrieval');
    assert.match(saved.material.content, /重排模型/);
    assert.doesNotMatch(saved.material.content, /window.injected/);
    assert.match(f.library.original(saved.material.id).bytes.toString(), /window.injected/);
    assert.ok(saved.material.segments.length > 0);
  } finally { f.cleanup(); }
});

test('verification pages never become materials; the failure persists and retry can later save the real article', async () => {
  const f = fixture();
  let queue: ImportQueue | undefined;
  let verified = false;
  const source = 'https://mp.weixin.qq.com/s/test-article';
  const fetchPage = async () => ({ html: verified ? article : verification, url: source });
  try {
    assert.throws(() => f.library.captureHtml(verification, source, { title: 'User supplied title' }), /验证页面/);
    assert.throws(() => f.library.importBytes('saved-page.html', Buffer.from(verification)), /验证页面/);
    assert.equal(f.library.stats().total, 0);
    queue = new ImportQueue(f.library, fetchPage);
    const job = queue.add(source);
    await queue.idle();
    assert.equal(queue.list()[0].status, 'failed');
    assert.equal(queue.list()[0].errorCode, 'PAGE_REQUIRES_BROWSER');
    assert.equal(queue.list()[0].materialId, undefined);
    assert.equal(f.library.stats().total, 0);
    await queue.close();
    queue = new ImportQueue(f.library, fetchPage);
    assert.equal(queue.list()[0].errorCode, 'PAGE_REQUIRES_BROWSER');
    verified = true;
    queue.retry(job.id);
    assert.equal(queue.list()[0].errorCode, undefined);
    await queue.idle();
    assert.equal(queue.list()[0].status, 'completed');
    assert.equal(queue.list()[0].error, undefined);
    assert.equal(queue.list()[0].errorCode, undefined);
    assert.equal(f.library.stats().total, 1);
    assert.match(f.library.get(queue.list()[0].materialId!).content, /混合检索/);
  } finally { await queue?.close(); f.cleanup(); }
});

test('subtitle timestamps and note citations roundtrip; missing citations fail', () => {
  const f = fixture();
  try {
    const subtitle = 'WEBVTT\n\n00:00:12.000 --> 00:00:16.500\n关键词用于精确匹配。\n\n00:01:01.000 --> 00:01:04.000\n语义检索用于理解意图。';
    const saved = f.library.importBytes('讲解.vtt', Buffer.from(subtitle), { collection: '视频课程' });
    assert.equal(saved.material.segments[1].startSeconds, 61);
    assert.equal(saved.material.kind, 'transcript');
    const note = f.library.saveNote('关键词适用于精确匹配。', [{ materialId: saved.material.id, segmentId: 'p0001' }], { title: '检索结论', category: '知识' });
    assert.match(f.library.exportMarkdown(note.material.id), /00:00:12/);
    assert.match(f.library.exportMarkdown(note.material.id), /library:\/\/r_/);
    assert.throws(() => f.library.saveNote('虚构引用', [{ materialId: saved.material.id, segmentId: 'p9999' }], {}), /不存在/);
    assert.throws(() => parseSubtitles('not a subtitle'), /没有找到/);
  } finally { f.cleanup(); }
});

test('binary media is copied and marked unprocessed, never fabricated as transcribed', () => {
  const f = fixture();
  try {
    const saved = f.library.importBytes('讲座.mp4', Buffer.from([0, 0, 0, 1, 10, 20]));
    assert.equal(saved.material.status, 'stored');
    assert.equal(saved.material.kind, 'video');
    assert.deepEqual(saved.material.segments, []);
    assert.equal(saved.material.content, '');
    assert.deepEqual(f.library.original(saved.material.id).bytes, Buffer.from([0, 0, 0, 1, 10, 20]));
  } finally { f.cleanup(); }
});

test('reject traversal, invalid encoding, duplicate writers and unsafe network addresses', async () => {
  const f = fixture();
  try {
    assert.throws(() => categoryName('../escape'), /分类/);
    assert.throws(() => categoryName('技术/CON'), /分类/);
    assert.throws(() => new Library(f.root), /另一实例/);
    assert.throws(() => f.library.importBytes('a.txt', Buffer.from([0xff, 0xfe])), /UTF-8/);
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1']) assert.equal(isPublicAddress(address), false, address);
    assert.equal(isPublicAddress('8.8.8.8'), true);
    assert.equal(permittedAddress('example.com', '198.18.0.1', {}), false);
    assert.equal(permittedAddress('example.com', '198.18.0.1', { allowProxyFakeIp: true }), true);
    assert.equal(permittedAddress('198.18.0.1', '198.18.0.1', { allowProxyFakeIp: true }), false);
    assert.equal(permittedAddress('router.local', '198.18.0.1', { allowProxyFakeIp: true }), false);
    assert.equal(permittedAddress('example.com', '192.168.0.1', { allowProxyFakeIp: true }), false);
    assert.equal(permittedAddress('example.com', '198.19.255.254', { allowProxyFakeIp: true }), true);
    assert.equal(permittedAddress('example.com', '198.18.999.1', { allowProxyFakeIp: true }), false);
    for (const name of ['router.local.', 'server.internal.', 'service.lan.', 'app.localhost.']) assert.equal(permittedAddress(name, '198.18.0.1', { allowProxyFakeIp: true }), false, name);
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '169.254.169.254', '::1', 'fc00::1']) assert.equal(permittedAddress('example.com', address, { allowProxyFakeIp: true }), false, address);
    await assert.rejects(fetchPublicPage('http://127.0.0.1'), /内网/);
  } finally { f.cleanup(); }
});

test('index rebuild flags external content changes instead of silently changing cited evidence', () => {
  const f = fixture();
  try {
    const item = f.library.captureText('不可静默改写的原始证据。').material;
    writeFileSync(join(item.path, 'content.md'), '被修改的内容');
    const rebuilt = f.library.rebuild();
    assert.equal(rebuilt.indexed, 0);
    assert.match(rebuilt.warnings[0], /外部修改/);
  } finally { f.cleanup(); }
});

test('durable web jobs resume after interruption and failed imports can be retried', async () => {
  const f = fixture();
  let queue: ImportQueue | undefined;
  try {
    writeFileSync(join(f.root, '.system', 'jobs.json'), JSON.stringify([{ id: 'job_recovery', url: 'https://example.com', fields: {}, status: 'running', attempts: 1, createdAt: new Date().toISOString() }]));
    let fail = false;
    queue = new ImportQueue(f.library, async (url) => {
      if (fail) throw new Error('simulated network outage');
      return { html: article, url };
    });
    await queue.idle();
    assert.equal(queue.list()[0].status, 'completed');
    assert.equal(f.library.stats().total, 1);
    fail = true;
    const job = queue.add('https://example.org');
    await queue.idle();
    assert.equal(queue.list()[0].status, 'failed');
    fail = false;
    queue.retry(job.id);
    await queue.idle();
    assert.equal(queue.list()[0].status, 'completed');
    assert.equal(JSON.parse(readFileSync(join(f.root, '.system', 'jobs.json'), 'utf8'))[1].status, 'completed');
  } finally { await queue?.close(); f.cleanup(); }
});
