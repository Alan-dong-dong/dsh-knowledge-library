import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArticle } from '../src/core/extract.js';

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
