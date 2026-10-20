import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_BYTES = 6 * 1024 * 1024;

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(lower) && !lower.startsWith('2001:db8:')
      && !lower.startsWith('2001:0:') && !lower.startsWith('2002:');
  }
  return false;
}

export function validateUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('请输入完整的 http 或 https 网页地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('仅支持不含账号密码的 http/https 地址');
  }
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('网页采集仅支持标准 HTTP/HTTPS 端口');
  url.hash = '';
  return url;
}

export interface FetchPolicy { allowProxyFakeIp?: boolean }
export function permittedAddress(hostname: string, address: string, policy: FetchPolicy): boolean {
  if (isPublicAddress(address)) return true;
  // An explicit deployment opt-in for Clash/Mihomo TUN fake DNS, not a general private-network exemption.
  return policy.allowProxyFakeIp === true && isIP(hostname) === 0
    && hostname.includes('.') && !/\.(localhost|local|internal|lan)$/i.test(hostname)
    && /^198\.(18|19)\.\d{1,3}\.\d{1,3}$/.test(address);
}
export async function fetchPublicPage(input: string, signal?: AbortSignal, policy: FetchPolicy = {}): Promise<{ html: string; url: string }> {
  let url = validateUrl(input);
  const timeout = AbortSignal.timeout(25_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let redirect = 0; redirect <= 4; redirect++) {
    combined.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(item => !permittedAddress(hostname, item.address, policy))) {
      if (addresses.some(item => /^198\.(18|19)\./.test(item.address))) throw new Error('检测到代理 fake-IP DNS。若本机使用 Clash/Mihomo TUN，请启用插件的 allowProxyFakeIp；否则请直接导入文本。');
      throw new Error('网页采集不访问本机、内网或保留地址，请直接导入文件或文本');
    }
    const address = addresses[0];
    const response = await new Promise<{ status: number; location?: string; contentType: string; bytes: Buffer }>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'GET', signal: combined, family: address.family,
        headers: { 'User-Agent': 'DSH-Knowledge-Library/0.1', Accept: 'text/html,text/plain;q=0.8', 'Accept-Encoding': 'identity' },
        // Pin the validated DNS result so a second resolution cannot reach an internal host.
        lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) { req.destroy(new Error('网页超过 6 MB，请下载后手动导入')); return; }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, contentType: String(res.headers['content-type'] ?? ''), bytes: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      url = validateUrl(new URL(response.location, url).href);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`网页返回 HTTP ${response.status}，请检查链接或改为手动导入`);
    if (!/text\/(html|plain)|application\/xhtml\+xml/i.test(response.contentType)) throw new Error('该地址不是可提取的网页，请下载文件后导入');
    const encoding = /charset=["']?([\w-]+)/i.exec(response.contentType)?.[1] || 'utf-8';
    let html: string;
    try { html = new TextDecoder(encoding).decode(response.bytes); } catch { throw new Error(`暂不支持网页编码 ${encoding}`); }
    if (response.contentType.includes('text/plain')) {
      html = `<html><body><article><p>${html.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('\n', '</p><p>')}</p></article></body></html>`;
    }
    return { html, url: url.href };
  }
  throw new Error('网页重定向次数过多');
}
