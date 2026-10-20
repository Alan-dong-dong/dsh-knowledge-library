import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Library } from '../src/core/library.js';
import { ImportQueue } from '../src/core/jobs.js';
import { API_PATH, createHandler } from '../src/http.js';

test('HTTP UI API persists captures, validates notes, updates metadata and rejects cross-site writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-http-test-'));
  const library = new Library(root);
  const queue = new ImportQueue(library);
  let origin = '';
  const server = createServer(createHandler(library, queue, () => origin));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = (path: string, payload: unknown, method = 'POST') => fetch(origin + API_PATH + path, { method, headers: { 'Content-Type': 'application/json', 'X-Knowledge-Library': '1' }, body: JSON.stringify(payload) });
  try {
    const response = await request('/capture', { type: 'text', content: '从界面保存的中文资料。', title: '界面资料', category: '收件箱' });
    assert.equal(response.status, 201);
    const saved = await response.json() as any;
    assert.equal((await (await fetch(origin + API_PATH + '/materials?query=中文')).json() as any).total, 1);
    assert.equal((await request(`/materials/${saved.material.id}`, { category: '研究', tags: ['待整理'] }, 'PATCH')).status, 200);
    const note = await request('/notes', { content: '带来源的结论', title: '结论', citations: [{ materialId: saved.material.id, segmentId: 'p0001' }] });
    assert.equal(note.status, 201);
    assert.equal((await request('/notes', { content: '坏引用', citations: [{ materialId: saved.material.id, segmentId: 'missing' }] })).status, 400);
    assert.equal((await request('/upload', { name: 'a.srt', base64: Buffer.from('1\n00:00:01,000 --> 00:00:03,000\n字幕内容\n').toString('base64') })).status, 201);
    assert.equal((await fetch(origin + API_PATH + '/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(origin + API_PATH + '/stats', { headers: { Origin: 'https://attacker.example' } })).status, 403);
    // Node fetch normalizes Host; raw HTTP independently exercises the rebinding fence.
    const hostileHost = await new Promise<number>(resolve => {
      const req = httpRequest(origin + API_PATH + '/stats', { headers: { Host: 'attacker.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.end();
    });
    assert.equal(hostileHost, 403);
    assert.equal((await request('/capture', { type: 'text', content: '' })).status, 400);
    assert.equal((await (await fetch(origin + API_PATH + '/settings')).json() as any).canChange, false);
    assert.equal((await request('/settings/root', { root: join(root, 'other'), expectedRoot: root })).status, 400);
    assert.equal((await (await fetch(origin + API_PATH + `/materials/${saved.material.id}/export`)).text()).includes('中文资料'), true);
  } finally {
    await queue.close(); library.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
