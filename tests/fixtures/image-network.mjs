// Test-only public transport fixture. Production DNS/redirect validation still runs.
import dns from 'node:dns/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
if (process.env.IMAGE_NETWORK_FIXTURE !== '1') throw new Error('Explicit test fixture opt-in required');
const hostname = 'dsh-image-fixture.example';
const lookup = dns.lookup.bind(dns); const request = https.request.bind(https);
dns.lookup = async (host, ...args) => host === hostname ? [{ address: '93.184.216.34', family: 4 }] : lookup(host, ...args);
https.request = (url, options, callback) => {
  if (url.hostname !== hostname) return request(url, options, callback);
  const req = new EventEmitter(); let stopped = false;
  req.destroy = error => { if (!stopped) { stopped = true; queueMicrotask(() => req.emit('error', error || new Error('Aborted'))); } return req; };
  req.end = () => queueMicrotask(() => {
    if (stopped) return;
    const image = url.pathname.endsWith('.png');
    const body = image ? readFileSync(new URL('./page-knowledge.png', import.meta.url)) : Buffer.from('<html><head><title>网页图片识别测试</title></head><body><article><p>这是用于测试的网页正文，需要保留原始证据和引用。图片中的文字可以补充知识，所有识别结果均应结合原图核验后再复用。</p><img src="/first.png" alt="图1"><img src="/second.png" alt="图2"></article></body></html>');
    const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': image ? 'image/png' : 'text/html; charset=utf-8' } });
    callback(res); res.emit('data', body); res.emit('end');
  });
  options.signal?.addEventListener('abort', () => req.destroy(new Error('Aborted')), { once: true });
  return req;
};
syncBuiltinESMExports();
