import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticle } from '../src/core/extract.js';
import { readFileSync } from 'node:fs';
import { PageAccessError } from '../src/core/page-access.js';

const verification = readFileSync(new URL('./fixtures/wechat-verification.html', import.meta.url), 'utf8');

test('inert article parser preserves metadata, base-relative links and HTML fragments', () => {
  const paragraph = 'This article contains enough source content to remain available for later reading, extraction, citation and analysis.';
  const article = extractArticle(`<!doctype html><html><head><title>Source title</title><meta name="author" content="Source author"><base href="https://cdn.example.org/docs/"></head><body><article><p>${paragraph}</p><p><a href="guide">Guide</a></p><script>throw new Error('must not execute')</script></article></body></html>`, 'https://example.com/start');
  assert.equal(article.title, 'Source title');
  assert.equal(article.author, 'Source author');
  assert.ok(article.content.includes('https://cdn.example.org/docs/guide'));
  assert.ok(!article.content.includes('must not execute'));
  const fragment = extractArticle(`<article><h1>Fragment</h1><p>${paragraph}</p><a href="/reference">Reference</a></article>`, 'https://example.com/start');
  assert.ok(fragment.content.includes(paragraph));
  assert.ok(fragment.content.includes('https://example.com/reference'));
});

test('Wechat verification pages and explicit challenge URLs are rejected before readability extraction', () => {
  for (const url of ['https://mp.weixin.qq.com/s/test-article', 'https://import.invalid/']) {
    assert.throws(() => extractArticle(verification, url), (error: unknown) => error instanceof PageAccessError && error.code === 'PAGE_REQUIRES_BROWSER' && /尚未获取文章正文/.test(error.message));
  }
  assert.throws(() => extractArticle('<html><body>Verify</body></html>', 'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?test=1'), PageAccessError);
  const cloudflare = '<html><head><title>Just a moment...</title></head><body><form id="challenge-form">Verify you are human before continuing. This page requires browser verification.</form></body></html>';
  assert.throws(() => extractArticle(cloudflare, 'https://example.com/'), PageAccessError);
});

test('normal articles about environment errors and verification retain their real content', () => {
  const paragraph = '本文讨论微信网页提示“当前环境异常，完成验证后即可继续访问”的排查方法，说明网络环境与网页内容验证的区别，并建议用户保留原始资料来源。';
  const html = `<html><head><title>环境异常</title></head><body><h1>环境异常</h1><div id="js_content"><p>${paragraph.repeat(5)}</p><a href="https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?test=1">去验证的页面示例</a></div></body></html>`;
  const article = extractArticle(html, 'https://mp.weixin.qq.com/s/security-guide');
  assert.match(article.content, /保留原始资料来源/);
  const generic = extractArticle(`<html><head><title>Cloudflare challenge guide</title></head><body><article><p>${paragraph.repeat(5)}</p><form id="challenge-form">Example form</form></article></body></html>`, 'https://example.com/guide');
  assert.match(generic.content, /保留原始资料来源/);
});
