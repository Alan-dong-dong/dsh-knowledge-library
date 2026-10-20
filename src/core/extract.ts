import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import type { Segment } from '../types.js';

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

export function extractArticle(html: string, url: string) {
  // Linkedom parses inert DOM only: no script execution, windows, or resource loading.
  // It also avoids the punycode/ dependency that DSH 0.2.1-rc.2 misroutes in packed profiles.
  const document = parseDocument(html, url);
  for (const node of Array.from(document.querySelectorAll('script,style,iframe,form'))) node.remove();
  const article = new Readability(document).parse();
  if (!article?.content || (article.textContent?.trim().length ?? 0) < 40) {
    throw new Error('未提取到有效正文。该网页可能需要登录或动态渲染，请复制正文或导入保存的 HTML。');
  }
  const clean = parseDocument(`<!doctype html><html><head></head><body>${article.content}</body></html>`, url);
  for (const anchor of Array.from(clean.querySelectorAll('a'))) {
    try {
      const href = new URL(anchor.getAttribute('href') ?? '', url);
      if (['http:', 'https:'].includes(href.protocol)) anchor.setAttribute('href', href.href);
      else anchor.removeAttribute('href');
    } catch { anchor.removeAttribute('href'); }
  }
  // Preserve image references; do not silently fetch third-party resources.
  for (const image of Array.from(clean.querySelectorAll('img'))) {
    try {
      const src = new URL(image.getAttribute('src') ?? '', url);
      if (['http:', 'https:'].includes(src.protocol)) image.setAttribute('src', src.href);
      else image.remove();
    } catch { image.remove(); }
  }
  return {
    title: article.title?.trim() || new URL(url).hostname,
    author: article.byline || undefined,
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
