import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Library } from './core/library.js';
import { ImportQueue } from './core/jobs.js';
import { API_PATH, createHandler, serveAsset } from './http.js';
import { fetchPublicPage } from './core/fetch.js';

const root = resolve(process.env.KNOWLEDGE_LIBRARY_ROOT || join(homedir(), 'Documents', 'DSH-Knowledge-Library'));
const library = new Library(root);
const queue = new ImportQueue(library, (url, signal) => fetchPublicPage(url, signal, { allowProxyFakeIp: process.env.KNOWLEDGE_LIBRARY_ALLOW_FAKE_IP === '1' }));
const port = Number(process.env.PORT || 4317);
let origin = `http://127.0.0.1:${port}`;
const api = createHandler(library, queue, () => origin, undefined, { allowProxyFakeIp: process.env.KNOWLEDGE_LIBRARY_ALLOW_FAKE_IP === '1' });
const server = createServer((req, res) => {
  if (req.url?.startsWith(API_PATH)) void api(req, res);
  else serveAsset(req, res);
});
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`;
  console.log(`Knowledge Library ready: ${origin}\nLibrary: ${root}`);
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(); server.closeAllConnections();
  await queue.close(); library.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
server.on('error', error => { console.error(error.message); void shutdown(); process.exitCode = 1; });
