import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Library } from '../src/core/library.js';
import { ImageCapture } from '../src/core/image-capture.js';
import { ImportQueue } from '../src/core/jobs.js';
import { KnowledgeQueue } from '../src/core/knowledge.js';
import { extractArticle } from '../src/core/extract.js';
import { inspectImage } from '../src/core/page-images.js';
import { harnessKnowledgeModel, previewKnowledgeModel, type KnowledgeModel, type ModelRequest } from '../src/knowledge-model.js';
import { createHandler, API_PATH } from '../src/http.js';

const png = readFileSync(new URL('./fixtures/page-knowledge.png', import.meta.url));
const html = (count = 2) => `<html><head><title>图片知识来源</title></head><body><div id="js_content"><p>这些原始文字必须完整保留，图片是补充的证据，图中文字应当与原文分开记录，便于核验来源与适用条件。</p>${Array.from({ length: count }, (_, i) => `<img data-src="https://example.com/${i}.png" alt="图${i + 1}"/>`).join('')}</div></body></html>`;
const url = 'https://mp.weixin.qq.com/s/image-fixture';
const answer = JSON.stringify({ text: '图中数据：识别率98%', description: '流程从采集到核验再到归纳。', uncertainty: '样本范围未注明', decorative: false });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-image-test-')); const library = new Library(root);
  const requests: ModelRequest[] = []; let fail = false; let downloads = 0;
  const model: KnowledgeModel = { status: () => ({ available: true, model: 'fixture' }), visionStatus: async () => ({ available: true, model: 'fixture' }), generate: async r => { requests.push(r); if (fail && r.prompt.includes('图2')) throw new Error('isolated vision failure'); return answer; } };
  const images = new ImageCapture(library, model, async input => { downloads++; return { bytes: png, contentType: 'image/png', url: input }; });
  const queue = new ImportQueue(library, async () => ({ html: html(), url }), images);
  return { root, library, images, queue, model, requests, get downloads() { return downloads; }, fail(value: boolean) { fail = value; }, async enable() { await images.save({ enabled: true, maxImages: 6 }, 0, root, 'fixture', true); }, async cleanup() { await queue.close(); library.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('body-only lazy images deduplicate, reject decorations, and image-only WeChat remains collectible', () => {
  const page = html(0).replace('</div>', '<img data-src="/chart.png#1"><img src="/chart.png#2"><img src="/avatar.png" class="avatar"><img src="/tiny.png" width="32"><img src="data:image/png;base64,xxx"><footer><img src="/footer.png"></footer></div>');
  assert.deepEqual(extractArticle(page, url).images.map(i => i.url), ['https://mp.weixin.qq.com/chart.png']);
  assert.equal(extractArticle('<html><body><div id="js_content"><img data-src="https://example.com/chart.png"></div></body></html>', url).images.length, 1);
  assert.throws(() => inspectImage(Buffer.from('<svg/>')), /PNG/);
  const huge = Buffer.from(png); huge.writeUInt32BE(30_000, 16); assert.throws(() => inspectImage(huge), /尺寸/);
  assert.throws(() => inspectImage(Buffer.alloc(6 * 1024 * 1024 + 1)), /6MB/);
  assert.deepEqual(inspectImage(png), { extension: 'png', mediaType: 'image/png', width: 640, height: 360 });
});

test('default OFF makes no image downloads or model calls; enabling requires root/version/model/cost confirmation', async () => {
  const f = fixture();
  try {
    assert.equal((await f.images.status()).enabled, false);
    f.queue.add(url); await f.queue.idle(); assert.equal(f.requests.length, 0); assert.equal(f.downloads, 0);
    await assert.rejects(f.images.save({ enabled: true, maxImages: 6 }, 0, 'old-root', 'fixture', true), /资料库/);
    await assert.rejects(f.images.save({ enabled: true, maxImages: 6 }, 0, f.root, 'fixture', false), /费用/);
    await assert.rejects(f.images.save({ enabled: true, maxImages: 6 }, 0, f.root, 'other', true), /模型/);
    await f.enable();
    await assert.rejects(f.images.save({ enabled: false, maxImages: 6 }, 0, f.root, '', false), /改变/);
    f.model.visionStatus = async () => ({ available: false });
    await f.images.save({ enabled: false, maxImages: 6 }, 1, f.root, '', false);
    assert.equal(f.images.options(), undefined);
  } finally { await f.cleanup(); }
});

test('automatic image capture preserves original paragraphs, isolates failures, caches originals and retries only failed images', async () => {
  const f = fixture();
  try {
    await f.enable(); f.fail(true); const job = f.queue.add(url); await f.queue.idle();
    const saved = f.queue.list()[0]; assert.equal(saved.status, 'completed'); assert.equal(saved.imageSummary?.completed, 1); assert.equal(saved.imageSummary?.failed, 1);
    const id = saved.materialId!; const detail = f.library.get(id); const content = readFileSync(join(detail.path, 'content.md'), 'utf8'); const segments = readFileSync(join(detail.path, 'segments.json'), 'utf8');
    assert.doesNotMatch(content, /识别率/); assert.equal(detail.segments[0].id, 'p0001'); assert.equal(detail.images?.length, 2);
    assert.match(detail.content, /图示解读（模型推断）/); assert.equal(f.library.search({ query: '识别率' }).total, 1);
    assert.equal(f.library.search({ query: '识别率' }).items[0].matches.some(s => s.id.startsWith('v_')), true);
    assert.deepEqual(f.library.pageImageFile(id, detail.images![1].id).bytes, png); assert.equal(f.downloads, 2);
    assert.equal(f.requests[0].images?.[0].mediaType, 'image/png'); assert.deepEqual(Buffer.from(f.requests[0].images![0].data), png);
    assert.ok(f.requests.every(request => !Object.hasOwn(request, 'maxTokens')), 'image recognition must inherit model defaults');
    const failed = detail.images!.filter(i => i.status === 'failed').map(i => i.id);
    await assert.rejects(f.queue.retryImages(job.id, 'fixture', []), /范围/);
    f.fail(false); await f.queue.retryImages(job.id, 'fixture', failed); await f.queue.idle();
    assert.equal(f.requests.length, 3); assert.equal(f.downloads, 2); assert.equal(f.queue.list()[0].imageSummary?.completed, 2);
    const stable = f.library.get(id).segments.filter(s => s.id.startsWith('v_')).map(s => s.id);
    f.library.update(id, { category: '研究/图片' }); f.library.trash(id); f.library.restore(id); f.library.rebuild();
    const moved = f.library.get(id); assert.deepEqual(moved.segments.filter(s => s.id.startsWith('v_')).map(s => s.id), stable);
    assert.equal(readFileSync(join(moved.path, 'content.md'), 'utf8'), content); assert.equal(readFileSync(join(moved.path, 'segments.json'), 'utf8'), segments);
    assert.match(f.library.exportMarkdown(id), /识别率98%/);
    f.library.saveNote('图片证据', [{ materialId: id, segmentId: stable[0] }], { title: '引用图片' });
    f.queue.add(url); await f.queue.idle(); assert.equal(f.requests.length, 3, 'duplicate captures must not rerun successful images');
    f.library.trash(id); const snap = f.library.trashSnapshot(); f.library.emptyTrash(snap.token); assert.equal(existsSync(moved.path), false);
  } finally { await f.cleanup(); }
});

test('image evidence feeds knowledge with stable citations; unfinished images prevent a model call', async () => {
  const f = fixture(); let knowledge: KnowledgeQueue | undefined;
  try {
    await f.enable(); const material = f.library.captureHtml(html(), url).material; f.images.initialize(material.id, html(), url, f.images.options()!);
    knowledge = new KnowledgeQueue(f.library, f.model); assert.throws(() => knowledge!.add([material.id]), /图片/); assert.equal(f.requests.length, 0);
    await f.images.run(material.id, new AbortController().signal, () => {});
    const segment = f.library.get(material.id).segments.find(s => s.text.includes('图中数据'))!;
    f.model.generate = async request => { assert.match(request.prompt, /识别率98%/); return JSON.stringify({ title: '图片知识', content: `图中数据需核实样本。 library://${material.id}/${segment.id}`, tags: [], citations: [{ materialId: material.id, segmentId: segment.id }] }); };
    const job = knowledge.add([material.id]); await knowledge.idle(); assert.equal(knowledge.get(job.id).status, 'draft', knowledge.get(job.id).error);
    const note = knowledge.confirm(job.id, 1); assert.equal(note.material.citations[0].segmentId, segment.id);
  } finally { await knowledge?.close(); await f.cleanup(); }
});

test('interrupted recognition restarts as manual retry without another paid call; canonical and derived files survive reopening', async () => {
  const f = fixture();
  try {
    await f.enable(); f.queue.add(url); await f.queue.idle(); const job = f.queue.list()[0]; const id = job.materialId!;
    const manifest = f.library.pageImages(id)!;
    // Simulate a process loss at the persisted request marker, independently of the collector.
    manifest.records[1].status = 'recognizing'; delete manifest.records[1].text; delete manifest.records[1].description;
    const { imageHash } = await import('../src/core/page-images.js'); writeFileSync(join(f.library.get(id).path, '.page-images.json'), JSON.stringify({ data: manifest, checksum: imageHash(JSON.stringify(manifest)) }));
    await f.queue.close(); f.library.close();
    writeFileSync(join(f.root, '.system/jobs.json'), JSON.stringify([{ ...job, fields: {}, status: 'running' }]));
    const library = new Library(f.root); const images = new ImageCapture(library, f.model); const queue = new ImportQueue(library, undefined, images);
    try { await queue.idle(); assert.equal(f.requests.length, 2); assert.equal(library.pageImages(id)!.records[1].status, 'failed'); assert.equal(queue.list()[0].status, 'completed'); assert.equal((await images.status()).enabled, true); assert.equal(library.search({ query: '识别率' }).total, 1); }
    finally { await queue.close(); library.close(); }
  } finally { await f.cleanup(); }
});

test('sidecar/index update rolls back after SQLite failure; existing successful evidence cannot be overwritten', async () => {
  const f = fixture();
  try {
    const material = f.library.captureHtml(html(1), url).material; const data = f.images.initialize(material.id, html(1), url, { model: 'fixture', maxImages: 1 });
    const file = join(material.path, '.page-images.json'); const before = readFileSync(file);
    f.library.db.exec("CREATE TRIGGER image_fail BEFORE INSERT ON materials BEGIN SELECT RAISE(FAIL,'image index failure'); END");
    data.records[0].status = 'failed'; assert.throws(() => f.library.savePageImages(material.id, data), /image index failure/); assert.deepEqual(readFileSync(file), before);
    f.library.db.exec('DROP TRIGGER image_fail'); await f.images.run(material.id, new AbortController().signal, () => {});
    const completed = f.library.pageImages(material.id)!; completed.records[0].text = 'silently changed'; assert.throws(() => f.library.savePageImages(material.id, completed), /不可改写/);
  } finally { await f.cleanup(); }
});

test('restart repairs an outer completed job whose image state could not finish, without inference', async () => {
  const f = fixture();
  try {
    await f.enable(); f.queue.add(url); await f.queue.idle(); const job = f.queue.list()[0]; const id = job.materialId!;
    // Model a failed image-state write after the outer job was completed.
    const manifest = f.library.pageImages(id)!; manifest.records[1].status = 'recognizing';
    const { imageHash } = await import('../src/core/page-images.js');
    writeFileSync(join(f.library.get(id).path, '.page-images.json'), JSON.stringify({ data: manifest, checksum: imageHash(JSON.stringify(manifest)) }));
    await f.queue.close(); f.library.close();
    const library = new Library(f.root); const images = new ImageCapture(library, f.model); const queue = new ImportQueue(library, undefined, images);
    try { await queue.idle(); assert.equal(f.requests.length, 2); assert.equal(queue.list()[0].status, 'completed'); assert.deepEqual(library.get(id).images!.map(image => image.status), ['completed','failed']); assert.equal(queue.list()[0].imageSummary?.failed, 1); }
    finally { await queue.close(); library.close(); }
  } finally { await f.cleanup(); }
});

test('restart recovers the body-save/manifest gap without starting recognition', async () => {
  const f = fixture();
  try {
    await f.enable(); const material = f.library.captureHtml(html(), url).material; const options = f.images.options();
    await f.queue.close(); f.library.close();
    const { randomUUID } = await import('node:crypto');
    writeFileSync(join(f.root, '.system/jobs.json'), JSON.stringify([{ id: `job_${randomUUID()}`, url, fields: {}, status: 'running', attempts: 1, imageCapture: options, materialId: material.id }]));
    const library = new Library(f.root); const images = new ImageCapture(library, f.model); const queue = new ImportQueue(library, undefined, images);
    try { await queue.idle(); assert.equal(f.requests.length, 0); assert.equal(queue.list()[0].status, 'completed'); assert.deepEqual(library.get(material.id).images!.map(image => image.status), ['failed','failed']); }
    finally { await queue.close(); library.close(); }
  } finally { await f.cleanup(); }
});

test('stopping image processing retains body and originals, rejects late model output and never starts remaining images', async () => {
  const f = fixture(); let release!: (value: string) => void; let started!: () => void;
  const entered = new Promise<void>(r => { started = r; });
  f.model.generate = async r => { f.requests.push(r); started(); return new Promise(resolve => { release = resolve; }); };
  try {
    await f.enable(); const job = f.queue.add(url); await entered;
    const id = f.queue.list()[0].materialId!; assert.equal(f.library.pageImages(id)!.records[0].status, 'recognizing');
    f.queue.cancelImages(job.id); release(answer); await f.queue.idle();
    assert.equal(f.requests.length, 1); assert.equal(f.downloads, 1); assert.equal(f.queue.list()[0].status, 'completed');
    assert.match(f.queue.list()[0].progress!, /已停止/); assert.doesNotMatch(f.library.get(id).content, /识别率/);
    assert.deepEqual(f.library.pageImages(id)!.records.map(i => [i.status, i.attempts]), [['failed', 1], ['failed', 0]]);
    assert.deepEqual(f.library.pageImageFile(id, f.library.get(id).images![0].id).bytes, png);
  } finally { await f.cleanup(); }
});

test('only the selected number of images is attempted, and each image stops at three explicit model attempts', async () => {
  const f = fixture();
  try {
    await f.images.save({ enabled: true, maxImages: 1 }, 0, f.root, 'fixture', true);
    f.model.generate = async request => { f.requests.push(request); throw new Error('persistent isolated failure'); };
    const job = f.queue.add(url); await f.queue.idle();
    const id = f.queue.list()[0].materialId!; assert.equal(f.downloads, 1); assert.equal(f.queue.list()[0].imageSummary?.skipped, 1);
    const imageId = f.library.get(id).images![0].id;
    for (let i = 0; i < 2; i++) { await f.queue.retryImages(job.id, 'fixture', [imageId]); await f.queue.idle(); }
    assert.equal(f.requests.length, 3); assert.equal(f.downloads, 1); assert.equal(f.library.get(id).images![0].attempts, 3);
    await assert.rejects(f.queue.retryImages(job.id, 'fixture', []), /3次/); assert.equal(f.requests.length, 3);
  } finally { await f.cleanup(); }
});

test('tiny rasters and non-raster responses never reach a model, while the full body remains usable', async () => {
  const f = fixture(); const tiny = Buffer.from(png); tiny.writeUInt32BE(32, 16);
  const images = new ImageCapture(f.library, f.model, async input => ({ url: input, contentType: 'image/png', bytes: input.endsWith('0.png') ? tiny : Buffer.from('<html>not an image</html>') }));
  try {
    const page = f.library.captureHtml(html(), url).material; images.initialize(page.id, html(), url, { model: 'fixture', maxImages: 2 });
    await images.run(page.id, new AbortController().signal, () => {});
    assert.deepEqual(f.library.get(page.id).images!.map(i => i.status), ['skipped', 'failed']); assert.equal(f.requests.length, 0); assert.equal(f.library.get(page.id).status, 'ready');
  } finally { images.close(); await f.cleanup(); }
});

test('image HTTP routes enforce consent, current root, same origin and serve verified local raster bytes', async () => {
  const f = fixture(); let origin = ''; const server = createServer(createHandler(f.library, f.queue, () => origin));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (path: string, value: any, headers = {}) => fetch(origin + API_PATH + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Knowledge-Library': '1', ...headers }, body: JSON.stringify(value) });
  try {
    assert.equal((await post('/settings/images', { settings: { enabled: true, maxImages: 1 }, version: 0, expectedRoot: f.root, expectedModel: 'fixture' })).status, 400);
    assert.equal((await post('/settings/images', {}, { Origin: 'https://evil.example' })).status, 403);
    await f.enable(); f.fail(true); f.queue.add(url); await f.queue.idle(); const job = f.queue.list()[0]; const image = f.library.get(job.materialId!).images![0];
    const response = await fetch(`${origin}${API_PATH}/materials/${job.materialId}/images/${image.id}`); assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    const retry = `/materials/${job.materialId}/images/retry`;
    assert.equal((await post(retry, { expectedRoot: f.root })).status, 400);
    assert.equal((await post(retry, { expectedRoot: 'old', confirmed: true })).status, 400);
    const ids = f.library.get(job.materialId!).images!.filter(i => i.status === 'failed').map(i => i.id);
    f.fail(false); assert.equal((await post(retry, { expectedRoot: f.root, confirmed: true, expectedModel: 'fixture', imageIds: ids })).status, 202); await f.queue.idle(); assert.equal(f.requests.length, 3);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await f.cleanup(); }
});

test('native Harness image blocks use saved attachments and reject text-only capability before sending', async () => {
  let vision = true; let calls = 0; const ref = { id: 'native-image-ref', mediaType: 'image/png' };
  const services = { llm: { listProviders: () => [{ id: 'test' }], resolveModelInfo: async () => ({ inputModalities: vision ? ['text', 'image'] : ['text'] }), async *stream(options: any) { calls++; assert.equal(Object.hasOwn(options, 'maxTokens'), false); assert.deepEqual(options.messages[0].content[1], { type: 'image', attachment: ref }); yield { type: 'block-end', block: { type: 'text', text: answer } }; yield { type: 'finish', reason: { kind: 'stop' } }; } }, agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'vision' }) }, attachments: { saveImages: async (images: any[]) => { assert.deepEqual(Buffer.from(images[0].data), png); return [ref]; } } };
  const model = harnessKnowledgeModel({ get: (name: keyof typeof services) => services[name] } as any);
  const request: ModelRequest = { system: '规则', prompt: '识图', expectedModel: 'test / vision', signal: new AbortController().signal, images: [{ data: png, mediaType: 'image/png' }] };
  assert.equal(await model.generate(request), answer); vision = false; await assert.rejects(model.generate(request), /图片输入能力/); assert.equal(calls, 1);
});

test('image preparation cannot silently change the model or reasoning before dispatch', async () => {
  let reasoningEffort = 'max'; let calls = 0;
  const services = {
    llm: { listProviders: () => [{ id: 'test' }], resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }), async *stream() { calls++; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'vision', reasoningEffort }) },
    attachments: { saveImages: async () => { reasoningEffort = 'low'; return [{ id: 'ref', mediaType: 'image/png' }]; } },
  };
  const model = harnessKnowledgeModel({ get: (name: keyof typeof services) => services[name] } as any);
  await assert.rejects(model.generate({ system: 'rules', prompt: 'read image', expectedModel: 'test / vision', signal: new AbortController().signal, images: [{ data: png, mediaType: 'image/png' }] }), /模型配置已改变/);
  assert.equal(calls, 0);
});

test('preview sends base64 image content over actual compatible HTTP after capability discovery', async () => {
  let calls = 0; const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); assert.equal(req.headers.authorization, 'Bearer isolated-key');
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'vision', input_modalities: ['text', 'image'] }] })); return; }
    calls++; const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(Object.hasOwn(body, 'max_tokens'), false); const image = body.messages[1].content[1]; assert.equal(image.type, 'image_url'); assert.equal(image.image_url.url, `data:image/png;base64,${png.toString('base64')}`);
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: answer } }] }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try { const model = previewKnowledgeModel({ KNOWLEDGE_LIBRARY_MODEL_API_KEY: 'isolated-key', KNOWLEDGE_LIBRARY_MODEL: 'vision', KNOWLEDGE_LIBRARY_MODEL_BASE_URL: `http://127.0.0.1:${(server.address() as any).port}/v1` }); assert.equal(await model.generate({ system: 'rules', prompt: 'read image', signal: new AbortController().signal, images: [{ data: png, mediaType: 'image/png' }] }), answer); assert.equal(calls, 1); }
  finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
