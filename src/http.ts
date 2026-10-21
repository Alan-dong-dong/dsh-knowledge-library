import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Library } from './core/library.js';
import type { ImportQueue } from './core/jobs.js';
import type { CaptureFields, Citation } from './types.js';
import type { DirectorySettings } from './directory-settings.js';

export const API_PATH = '/knowledge-library/api';
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, any>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('请求必须使用 application/json');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 90 * 1024 * 1024) throw new Error('请求体超过限制');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('请求内容必须是 JSON 对象');
  return data;
}
function fields(data: Record<string, any>): CaptureFields {
  for (const key of ['title', 'category', 'collection', 'sourceNote', 'sourceUrl']) {
    if (data[key] !== undefined && typeof data[key] !== 'string') throw new Error(`${key} 必须是字符串`);
  }
  if (data.tags !== undefined && (!Array.isArray(data.tags) || data.tags.some((tag: unknown) => typeof tag !== 'string'))) throw new Error('标签必须是字符串数组');
  return { title: data.title, category: data.category, collection: data.collection, tags: data.tags, sourceNote: data.sourceNote, sourceUrl: data.sourceUrl };
}
const localAddress = (address = '') => address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';

export function createHandler(library: Library, queue: ImportQueue, getOrigin: () => string, directories?: DirectorySettings) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const origin = getOrigin();
      if (!localAddress(req.socket.remoteAddress) || req.headers.host !== new URL(origin).host) {
        send(res, 403, { error: '资料库接口仅允许本机访问' }); return;
      }
      if (req.headers.origin && req.headers.origin !== origin) { send(res, 403, { error: '不允许跨站访问' }); return; }
      const url = new URL(req.url || '/', origin);
      const path = url.pathname.slice(API_PATH.length);
      if (req.method === 'GET') {
        if (path === '/settings') { send(res, 200, { root: library.root, ...(directories?.status() ?? { canChange: false, canChangeNetwork: false, picker: null, allowProxyFakeIp: false }) }); return; }
        if (path === '/stats') { send(res, 200, library.stats()); return; }
        if (path === '/trash') { send(res, 200, library.trashSnapshot()); return; }
        if (path === '/materials') {
          send(res, 200, library.search({ ...Object.fromEntries(url.searchParams), trashed: url.searchParams.get('trashed') === '1', limit: Number(url.searchParams.get('limit')) || 40, offset: Number(url.searchParams.get('offset')) || 0 })); return;
        }
        if (path === '/jobs') { send(res, 200, queue.list()); return; }
        const match = path.match(/^\/materials\/(r_[a-f0-9-]+)(?:\/(export|original))?$/);
        if (match) {
          if (match[2] === 'export') {
            res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${match[1]}.md"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            res.end(library.exportMarkdown(match[1])); return;
          }
          if (match[2] === 'original') {
            const original = library.original(match[1]);
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(original.name).replaceAll("'", '%27')}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
            res.end(original.bytes); return;
          }
          const item = library.get(match[1]);
          send(res, 200, { ...item, missingSources: item.citations.filter(c => !library.has(c.materialId)).map(c => c.materialId) }); return;
        }
      }
      if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
        if (req.headers['x-knowledge-library'] !== '1') { send(res, 403, { error: '缺少同源请求标记' }); return; }
        const data = await body(req);
        if (req.method === 'POST' && path === '/trash/empty') {
          if (data.expectedRoot !== library.root) throw new Error('资料库目录已改变，请刷新后再操作');
          if (data.confirmed !== true || typeof data.token !== 'string') throw new Error('请先确认永久清空回收站');
          send(res, 200, library.emptyTrash(data.token)); return;
        }
        if (req.method === 'POST' && ['/directory/pick', '/directory/list', '/settings/root', '/settings/network'].includes(path)) {
          if (!directories) throw new Error('请在 Harness 中修改资料库设置');
          if (path === '/settings/network') {
            if (typeof data.allowProxyFakeIp !== 'boolean' || typeof data.expected !== 'boolean' || typeof data.expectedRoot !== 'string') throw new Error('代理兼容设置必须是布尔值，并提供当前资料库目录');
            const allowProxyFakeIp = await directories.setProxyMode(data.allowProxyFakeIp, data.expected, data.expectedRoot);
            send(res, 200, { allowProxyFakeIp }); return;
          }
          if (path === '/settings/root') {
            if (typeof data.root !== 'string' || typeof data.expectedRoot !== 'string') throw new Error('资料库目录必须是字符串');
            const root = await directories.change(data.root, data.expectedRoot);
            send(res, 200, { root }); return;
          }
          const abort = new AbortController();
          const disconnected = () => abort.abort();
          res.once('close', disconnected);
          try {
            if (path === '/directory/pick') send(res, 200, { path: await directories.pick(abort.signal) });
            else {
              if (data.path !== undefined && typeof data.path !== 'string') throw new Error('目录路径必须是字符串');
              send(res, 200, await directories.list(data.path, abort.signal));
            }
          } finally { res.off('close', disconnected); }
          return;
        }
        if (req.method === 'POST' && path === '/capture') {
          const captureFields = fields(data);
          if (data.type === 'url' && typeof data.content === 'string') {
            send(res, 202, { job: queue.add(data.content, captureFields) }); return;
          }
          if (data.type !== 'text') throw new Error('请选择网页或文本');
          send(res, 201, library.captureText(data.content, captureFields)); return;
        }
        if (req.method === 'POST' && path === '/upload') {
          if (typeof data.name !== 'string' || typeof data.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64)) throw new Error('文件数据格式不正确');
          send(res, 201, library.importBytes(data.name, Buffer.from(data.base64, 'base64'), fields(data))); return;
        }
        if (req.method === 'POST' && path === '/notes') {
          if (typeof data.content !== 'string' || !Array.isArray(data.citations) || data.citations.some((c: any) => !c || typeof c.materialId !== 'string' || (c.segmentId !== undefined && typeof c.segmentId !== 'string'))) throw new Error('笔记内容或引用格式不正确');
          send(res, 201, library.saveNote(data.content, data.citations as Citation[], fields(data))); return;
        }
        const match = path.match(/^\/materials\/(r_[a-f0-9-]+)$/);
        if (req.method === 'PATCH' && match) { send(res, 200, library.update(match[1], fields(data))); return; }
        const restore = path.match(/^\/materials\/(r_[a-f0-9-]+)\/restore$/);
        if ((req.method === 'DELETE' && match) || (req.method === 'POST' && restore)) {
          if (data.expectedRoot !== library.root) throw new Error('资料库目录已改变，请刷新后再操作');
          send(res, 200, match ? library.trash(match[1]) : library.restore(restore![1])); return;
        }
        const retry = path.match(/^\/jobs\/(job_[a-f0-9-]+)\/retry$/);
        if (req.method === 'POST' && retry) { send(res, 200, queue.retry(retry[1])); return; }
        if (req.method === 'POST' && path === '/rebuild') { send(res, 200, library.rebuild()); return; }
      }
      send(res, 404, { error: '接口不存在' });
    } catch (error) {
      if (!res.headersSent) send(res, 400, { error: error instanceof Error ? error.message : '操作失败' });
      else res.end();
    }
  };
}

export function serveAsset(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url || '/', 'http://localhost').pathname;
  const names: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/app.css': ['app.css', 'text/css; charset=utf-8'],
  };
  const item = names[path];
  if (!item) { res.writeHead(404); res.end(); return; }
  try {
    const bytes = readFileSync(fileURLToPath(new URL(`../dist/public/${item[0]}`, import.meta.url)));
    res.writeHead(200, {
      'Content-Type': item[1], 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    }); res.end(bytes);
  } catch { res.writeHead(503); res.end('请先运行 npm run build'); }
}
