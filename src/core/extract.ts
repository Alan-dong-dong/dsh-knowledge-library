import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import type { Segment } from '../types.js';
import { assertArticleAccess } from './page-access.js';

const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
markdown.remove(['script', 'style', 'iframe', 'form', 'input', 'button']);

function parseDocument(html: string, url: string): Document {
  let { document } = parseHTML(html);
  if (document.documentElement?.localName !== 'html') {
    ({ document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`));
  }
  let baseURI = url;
  try { baseURI = new URL(document.querySelector('base[href]')?.getAttribute('href') || url, url).href; } catch { /* Keep the source URL for invalid base tags. */ }
  Object.defineProperties(document, { documentURI: { value: url }, baseURI: { value: baseURI } });
  return document as unknown as Document;
}

function extractWechatArticle(document: Document, url: string) {
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  const body = document.querySelector('#js_content');
  // Saved WeChat HTML has no HTTP source when imported as a local file.
  const savedWechat = host === 'import.invalid' && body?.classList.contains('rich_media_content')
    && document.querySelector('#activity-name.rich_media_title');
  if (host !== 'mp.weixin.qq.com' && !savedWechat) return null;
  if (!body || (body.textContent?.trim().length ?? 0) < 40) return null;
  // WeChat hides the entire body until its scripts run. Read the explicit article
  // container without running those scripts or discarding it as invisible text.
  return {
    title: document.querySelector('#activity-name')?.textContent?.trim()
      || document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim()
      || document.title,
    byline: document.querySelector('#js_author_name')?.textContent?.trim()
      || document.querySelector('#js_name')?.textContent?.trim()
      || document.querySelector('meta[name="author"]')?.getAttribute('content')?.trim(),
    content: body.innerHTML,
    textContent: body.textContent,
  };
}

function normalizeWechatCode(document: Document): void {
  for (const pre of Array.from(document.querySelectorAll('pre'))) {
    const lines = Array.from(pre.children).filter(node => node.localName === 'code');
    if (!lines.length || lines.length !== pre.children.length) continue;
    // WeChat uses one sibling <code> element per line; Turndown's standard
    // fenced-code rule only reads the first <code>. Merge before conversion.
    const code = document.createElement('code');
    code.className = lines[0].className;
    code.textContent = lines.map(line => {
      for (const br of Array.from(line.querySelectorAll('br'))) br.replaceWith('\n');
      return (line.textContent || '').replace(/\u00a0/g, ' ').replace(/\n$/, '');
    }).join('\n');
    const language = pre.getAttribute('data-lang');
    if (language && /^[\w+-]+$/.test(language)) code.className = `language-${language}`;
    pre.replaceChildren(code);
  }
}

export function extractArticle(html: string, url: string) {
  // Linkedom parses inert DOM only: no script execution, windows, or resource loading.
  // It also avoids the punycode/ dependency that DSH 0.2.1-rc.2 misroutes in packed profiles.
  const document = parseDocument(html, url);
  for (const node of Array.from(document.querySelectorAll('script,style,iframe'))) node.remove();
  assertArticleAccess(document, url);
  for (const node of Array.from(document.querySelectorAll('form'))) node.remove();
  const wechat = extractWechatArticle(document, url);
  const article = wechat || new Readability(document).parse();
  if (!article?.content || (article.textContent?.trim().length ?? 0) < 40) {
    throw new Error('未提取到有效正文。该网页可能需要登录或动态渲染，请复制正文或导入保存的 HTML。');
  }
  const baseUrl = wechat ? document.baseURI : url;
  const clean = parseDocument(`<!doctype html><html><head></head><body>${article.content}</body></html>`, baseUrl);
  if (wechat) normalizeWechatCode(clean);
  for (const anchor of Array.from(clean.querySelectorAll('a'))) {
    try {
      const href = new URL(anchor.getAttribute('href') ?? '', baseUrl);
      if (['http:', 'https:'].includes(href.protocol)) anchor.setAttribute('href', href.href);
      else anchor.removeAttribute('href');
    } catch { anchor.removeAttribute('href'); }
  }
  // Preserve image references; do not silently fetch third-party resources.
  for (const image of Array.from(clean.querySelectorAll('img'))) {
    try {
      const value = (wechat && image.getAttribute('data-src')) || image.getAttribute('src');
      if (!value?.trim()) { image.remove(); continue; }
      const src = new URL(value, baseUrl);
      if (['http:', 'https:'].includes(src.protocol)) image.setAttribute('src', src.href);
      else image.remove();
    } catch { image.remove(); }
  }
  return {
    title: article.title?.trim() || new URL(url).hostname,
    author: article.byline || undefined,
    extraction: wechat ? '微信正文容器提取' : 'Readability 正文提取',
    content: markdown.turndown(clean.body.innerHTML).trim(),
  };
}

function seconds(value: string): number {
  const parts = value.replace(',', '.').split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n) || n < 0)) throw new Error('字幕时间戳无效');
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}

export function parseSubtitles(input: string): Segment[] {
  const blocks = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const segments: Segment[] = [];
  for (const block of blocks) {
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/.test(block.trim())) continue;
    const lines = block.split('\n');
    const index = lines.findIndex(line => /-->/.test(line));
    if (index < 0) continue;
    const match = lines[index].match(/((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})/);
    if (!match) throw new Error('字幕时间戳格式不正确，请使用 SRT 或 WebVTT');
    const text = lines.slice(index + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    const startSeconds = seconds(match[1]);
    const endSeconds = seconds(match[2]);
    if (endSeconds < startSeconds) throw new Error('字幕结束时间早于开始时间');
    segments.push({ id: `p${String(segments.length + 1).padStart(4, '0')}`, text, startSeconds, endSeconds });
  }
  if (!segments.length) throw new Error('没有找到可读取的字幕，请检查文件是否为 SRT 或 WebVTT');
  return segments;
}

export function formatTime(value: number): string {
  const s = Math.floor(value);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function splitSegments(content: string): Segment[] {
  const chunks: string[] = [];
  for (const paragraph of content.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)) {
    // Bound each readable segment without assuming spaces exist in Chinese.
    for (let offset = 0; offset < paragraph.length; offset += 1600) chunks.push(paragraph.slice(offset, offset + 1600));
  }
  return chunks.map((text, index) => ({ id: `p${String(index + 1).padStart(4, '0')}`, text }));
}
