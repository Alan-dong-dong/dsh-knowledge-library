import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { type LookupAddress } from 'node:dns';
import https, { type RequestOptions } from 'node:https';
import { type ClientRequest, type IncomingMessage } from 'node:http';
import timers from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fetchPublicPage } from '../src/core/fetch.js';
import { extractArticle } from '../src/core/extract.js';
import { PageAccessError } from '../src/core/page-access.js';

const publicAddress = { address: '93.184.216.34', family: 4 };
const article = '<html><head><title>Network recovery</title></head><body><article><p>This complete article is returned after a temporary network interruption and is available for reading and citation.</p></article></body></html>';
const disconnected = () => Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' });

interface Step {
  error?: Error;
  status?: number;
  location?: string;
  chunks?: Buffer[];
  pending?: boolean;
  incomplete?: boolean;
}

function network(t: TestContext, steps: Step[], overrides: {
  resolve?: (attempt: number) => Promise<LookupAddress[]>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<unknown>;
} = {}) {
  const trace = { lookups: [] as string[], requests: [] as { url: string; options: RequestOptions }[], waits: [] as number[], destroyed: 0 };
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(dns, 'lookup', (async (hostname: string) => {
    trace.lookups.push(hostname);
    return overrides.resolve ? overrides.resolve(trace.lookups.length) : [publicAddress];
  }) as typeof dns.lookup);
  t.mock.method(timers, 'setTimeout', (async (ms: number, _value: unknown, options: { signal: AbortSignal }) => {
    trace.waits.push(ms);
    return overrides.sleep?.(ms, options.signal);
  }) as typeof timers.setTimeout);
  t.mock.method(https, 'request', ((url: URL, options: RequestOptions, onResponse: (res: IncomingMessage) => void) => {
    const step = steps[trace.requests.length];
    trace.requests.push({ url: url.href, options });
    assert.ok(step, 'Unexpected extra network request');
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): ClientRequest };
    let destroyed = false;
    const signal = options.signal!;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => req.destroy(Object.assign(new Error('Aborted'), { code: 'ABORT_ERR' }));
    req.destroy = (error = disconnected()) => {
      if (!destroyed) {
        destroyed = true; trace.destroyed++; cleanup();
        queueMicrotask(() => req.emit('error', error));
      }
      return req as unknown as ClientRequest;
    };
    signal.addEventListener('abort', onAbort, { once: true });
    req.end = () => queueMicrotask(() => {
      if (destroyed || step.pending) return;
      if (step.error) { cleanup(); req.emit('error', step.error); return; }
      const res = Object.assign(new EventEmitter(), {
        statusCode: step.status || 200,
        headers: { 'content-type': 'text/html; charset=utf-8', location: step.location },
      });
      onResponse(res as unknown as IncomingMessage);
      for (const chunk of step.chunks || [Buffer.from(article)]) {
        if (destroyed) return;
        res.emit('data', chunk);
      }
      if (destroyed) return;
      cleanup();
      if (step.incomplete) { res.emit('aborted'); res.emit('error', disconnected()); }
      else res.emit('end');
    });
    return req as unknown as ClientRequest;
  }) as typeof https.request);
  syncBuiltinESMExports();
  return trace;
}

test('a TLS socket reset recovers with a fresh request and freshly validated, pinned DNS', async t => {
  const trace = network(t, [{ error: disconnected() }, {}], {
    resolve: async attempt => [{ ...publicAddress, address: attempt === 1 ? '93.184.216.34' : '93.184.216.35' }],
  });
  const page = await fetchPublicPage('https://example.com/article');
  assert.match(extractArticle(page.html, page.url).content, /complete article/);
  assert.equal(trace.requests.length, 2);
  assert.equal(trace.lookups.length, 2);
  assert.equal(trace.waits.length, 1);
  for (const [index, call] of trace.requests.entries()) {
    assert.equal(call.options.agent, false);
    assert.notEqual(call.options.rejectUnauthorized, false);
    const pinned = await new Promise<string>((resolve, reject) => {
      call.options.lookup!('example.com', {}, (error, address) => error ? reject(error) : resolve(address as string));
    });
    assert.equal(pinned, index === 0 ? '93.184.216.34' : '93.184.216.35');
  }
});

test('persistent socket failure stops after two retries and explains the failure in Chinese', async t => {
  const trace = network(t, Array.from({ length: 3 }, () => ({ error: disconnected() })));
  await assert.rejects(fetchPublicPage('https://example.com/article'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /连接中断.*自动重试 2 次/);
    assert.equal((error.cause as NodeJS.ErrnoException).code, 'ECONNRESET');
    assert.doesNotMatch(error.message, /Client network socket/);
    return true;
  });
  assert.equal(trace.requests.length, 3);
  assert.equal(trace.lookups.length, 3);
  assert.equal(trace.waits.length, 2);
  assert.ok(trace.waits[1] > trace.waits[0]);
});

test('temporary DNS failure retries, but a new private DNS result prevents the second connection', async t => {
  await t.test('temporary DNS recovery', async t => {
    const trace = network(t, [{}], {
      resolve: async attempt => {
        if (attempt === 1) throw Object.assign(new Error('DNS busy'), { code: 'EAI_AGAIN' });
        return [publicAddress];
      },
    });
    await fetchPublicPage('https://example.com/article');
    assert.equal(trace.lookups.length, 2);
    assert.equal(trace.requests.length, 1);
  });
  await t.test('an in-flight request retains its proxy opt-in across retries', async t => {
    const policy = { allowProxyFakeIp: true };
    const trace = network(t, [{ error: disconnected() }, {}], {
      resolve: async () => [{ address: '198.18.1.25', family: 4 }],
      sleep: async () => { policy.allowProxyFakeIp = false; },
    });
    await fetchPublicPage('https://example.com/article', undefined, policy);
    await assert.rejects(fetchPublicPage('https://example.com/article', undefined, policy), /代理 fake-IP/);
    assert.equal(trace.requests.length, 2);
    assert.equal(trace.lookups.length, 3);
  });
  await t.test('DNS cannot become private between attempts', async t => {
    const trace = network(t, [{ error: disconnected() }], {
      resolve: async attempt => attempt === 1 ? [publicAddress] : [{ address: '127.0.0.1', family: 4 }],
    });
    await assert.rejects(fetchPublicPage('https://example.com/article'), /内网/);
    assert.equal(trace.lookups.length, 2);
    assert.equal(trace.requests.length, 1);
  });
});

test('permanent TLS, certificate and HTTP errors are not retried', async t => {
  for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN', 'EPROTO']) {
    await t.test(code, async t => {
      const trace = network(t, [{ error: Object.assign(new Error('TLS failed'), { code }) }]);
      await assert.rejects(fetchPublicPage('https://example.com/article'), /HTTPS|证书/);
      assert.equal(trace.requests.length, 1);
      assert.equal(trace.waits.length, 0);
    });
  }
  await t.test('HTTP 429 is not a socket retry', async t => {
    const trace = network(t, [{ status: 429 }]);
    await assert.rejects(fetchPublicPage('https://example.com/article'), /HTTP 429/);
    assert.equal(trace.requests.length, 1);
    assert.equal(trace.waits.length, 0);
  });
  await t.test('nonexistent domain has a useful error', async t => {
    const trace = network(t, [], { resolve: async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); } });
    await assert.rejects(fetchPublicPage('https://example.com/article'), /域名解析失败/);
    assert.equal(trace.lookups.length, 1);
    assert.equal(trace.waits.length, 0);
  });
});

test('cancellation stops DNS, an active connection and retry backoff without issuing a new request', async t => {
  for (const phase of ['dns', 'request', 'backoff', 'before-start']) {
    await t.test(phase, async t => {
      const controller = new AbortController();
      const reason = new Error('User cancelled capture');
      const trace = network(t, [{ pending: phase === 'request', error: phase === 'backoff' ? disconnected() : undefined }], {
        resolve: phase === 'dns' ? async () => new Promise(() => {}) : undefined,
        sleep: async () => { controller.abort(reason); throw reason; },
      });
      if (phase === 'before-start') controller.abort(reason);
      const pending = fetchPublicPage('https://example.com/article', controller.signal);
      if (phase !== 'backoff' && phase !== 'before-start') {
        await new Promise<void>(resolve => setImmediate(resolve));
        controller.abort(reason);
      }
      await assert.rejects(pending, error => error === reason);
      assert.equal(trace.requests.length, phase === 'dns' || phase === 'before-start' ? 0 : 1);
      assert.equal(trace.waits.length, phase === 'backoff' ? 1 : 0);
    });
  }
});

test('one overall deadline covers DNS, an active request and the retry wait', async t => {
  for (const phase of ['dns', 'request', 'backoff']) {
    await t.test(phase, async t => {
      const deadline = new AbortController();
      const expire = () => deadline.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
      let deadlines = 0;
      const trace = network(t, [{ pending: phase === 'request', error: phase === 'backoff' ? disconnected() : undefined }], {
        resolve: phase === 'dns' ? async () => new Promise(() => {}) : undefined,
        sleep: async () => { expire(); deadline.signal.throwIfAborted(); },
      });
      t.mock.method(AbortSignal, 'timeout', ms => { deadlines++; assert.equal(ms, 25_000); return deadline.signal; });
      const pending = fetchPublicPage('https://example.com/article');
      if (phase !== 'backoff') {
        await new Promise<void>(resolve => setImmediate(resolve));
        expire();
      }
      await assert.rejects(pending, /网页连接超时/);
      assert.equal(deadlines, 1);
      assert.equal(trace.requests.length, phase === 'dns' ? 0 : 1);
      assert.equal(trace.waits.length, phase === 'backoff' ? 1 : 0);
    });
  }
});

test('redirects cannot access private addresses, and a retry restarts validation from the original URL', async t => {
  await t.test('private redirect is blocked', async t => {
    const trace = network(t, [{ status: 302, location: 'https://127.0.0.1/private' }], {
      resolve: async attempt => attempt === 1 ? [publicAddress] : [{ address: '127.0.0.1', family: 4 }],
    });
    await assert.rejects(fetchPublicPage('https://example.com/article'), /内网/);
    assert.equal(trace.requests.length, 1);
    assert.equal(trace.waits.length, 0);
  });
  await t.test('redirected connection reset restarts at the original URL', async t => {
    const trace = network(t, [{ status: 302, location: 'https://cdn.example.com/article' }, { error: disconnected() }, {}]);
    const page = await fetchPublicPage('https://example.com/article');
    assert.equal(page.url, 'https://example.com/article');
    assert.deepEqual(trace.requests.map(call => call.url), ['https://example.com/article', 'https://cdn.example.com/article', 'https://example.com/article']);
    assert.equal(trace.lookups.length, 3);
  });
});

test('partial response is discarded and retried; oversized responses are rejected without retry', async t => {
  await t.test('incomplete article is replaced by a complete response', async t => {
    const trace = network(t, [{ chunks: [Buffer.from('partial document')], incomplete: true }, {}]);
    const page = await fetchPublicPage('https://example.com/article');
    assert.equal(page.html, article);
    assert.equal(trace.requests.length, 2);
  });
  await t.test('6 MB limit remains enforced', async t => {
    const trace = network(t, [{ chunks: [Buffer.alloc(6 * 1024 * 1024 + 1)] }]);
    await assert.rejects(fetchPublicPage('https://example.com/article'), /超过 6 MB/);
    assert.equal(trace.requests.length, 1);
    assert.equal(trace.waits.length, 0);
    assert.equal(trace.destroyed, 1);
  });
});

test('a real verification response still fails extraction without automatic network retries', async t => {
  const verification = readFileSync(new URL('./fixtures/wechat-verification.html', import.meta.url));
  const trace = network(t, [{ chunks: [verification] }]);
  const page = await fetchPublicPage('https://mp.weixin.qq.com/s/example');
  assert.throws(() => extractArticle(page.html, page.url), PageAccessError);
  assert.equal(trace.requests.length, 1);
  assert.equal(trace.waits.length, 0);
});
