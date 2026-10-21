import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_BYTES = 6 * 1024 * 1024;
const MAX_RETRIES = 2;
const TRANSIENT_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_STREAM_PREMATURE_CLOSE']);

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

function networkError(error: unknown, retries: number): unknown {
  const code = errorCode(error);
  if (TRANSIENT_ERRORS.has(code)) {
    const reason = code === 'EAI_AGAIN' ? '网页域名暂时无法解析' : '网页连接中断或无法建立';
    return new Error(`${reason}，已自动重试 ${retries} 次仍未成功。请检查网络或代理后重新采集，也可以打开原网页复制正文。`, { cause: error });
  }
  if (code === 'ENOTFOUND') return new Error('网页域名解析失败，请检查网址、网络或代理设置。', { cause: error });
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(code)) {
    return new Error('网页 HTTPS 证书校验失败，请检查系统时间、网络代理或站点证书后重试。', { cause: error });
  }
  if (code === 'EPROTO' || /^ERR_(?:TLS|SSL)_/.test(code)) {
    return new Error('无法与网页建立安全的 HTTPS 连接，请检查网络、代理或站点的 TLS 配置。', { cause: error });
  }
  return error;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
    operation.then(value => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

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
  const normalized = hostname.replace(/\.$/, '');
  return policy.allowProxyFakeIp === true && isIP(address) === 4 && isIP(normalized) === 0
    && normalized.includes('.') && !/\.(localhost|local|internal|lan)$/i.test(normalized)
    && /^198\.(18|19)\.\d{1,3}\.\d{1,3}$/.test(address);
}
async function fetchPageOnce(input: string, signal: AbortSignal, policy: FetchPolicy): Promise<{ html: string; url: string }> {
  let url = validateUrl(input);
  for (let redirect = 0; redirect <= 4; redirect++) {
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await abortable(lookup(hostname, { all: true }), signal);
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(item => !permittedAddress(hostname, item.address, policy))) {
      if (addresses.some(item => /^198\.(18|19)\./.test(item.address))) throw new Error('检测到代理 fake-IP DNS。若本机使用 Clash/Mihomo TUN，请在资料库设置中启用“代理兼容”，然后重新采集；否则请复制正文导入。');
      throw new Error('网页采集不访问本机、内网或保留地址，请直接导入文件或文本');
    }
    const address = addresses[0];
    const response = await new Promise<{ status: number; location?: string; contentType: string; bytes: Buffer }>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'GET', signal, family: address.family, agent: false,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DSH-Knowledge-Library/0.1)', Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', 'Accept-Encoding': 'identity' },
        // Pin the validated DNS result so a second resolution cannot reach an internal host.
        lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            const error = new Error('网页超过 6 MB，请下载后手动导入');
            reject(error); req.destroy(error); return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, contentType: String(res.headers['content-type'] ?? ''), bytes: Buffer.concat(chunks) }));
        res.on('aborted', () => reject(Object.assign(new Error('网页响应在传输完成前断开'), { code: 'ECONNRESET' })));
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

export async function fetchPublicPage(input: string, signal?: AbortSignal, policy: FetchPolicy = {}): Promise<{ html: string; url: string }> {
  const timeout = AbortSignal.timeout(25_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const snapshot = { allowProxyFakeIp: policy.allowProxyFakeIp === true };
  let retries = 0;
  try {
    for (;;) {
      combined.throwIfAborted();
      try { return await fetchPageOnce(input, combined, snapshot); }
      catch (error) {
        combined.throwIfAborted();
        if (!TRANSIENT_ERRORS.has(errorCode(error)) || retries >= MAX_RETRIES) throw error;
        // Retry a fresh GET from the original URL, rechecking every DNS result and
        // redirect. DNS, requests and backoff all share the same 25-second limit.
        await delay(350 * 2 ** retries + Math.floor(Math.random() * 150), undefined, { signal: combined });
        retries++;
      }
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) throw new Error('网页连接超时，请检查网络或代理后重试，也可以复制正文导入。', { cause: error });
    throw networkError(error, retries);
  }
}
