import { createHash } from 'node:crypto';
import type { PageImageManifest, Segment } from '../types.js';
import { splitSegments } from './extract.js';

export const imageHash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const imageFilePattern = /^img_[a-f0-9-]{36}\.(png|jpg|webp|gif)$/;
export function validateImageManifest(value: unknown): PageImageManifest {
  const data = value as PageImageManifest;
  if (!data || data.schemaVersion !== 1 || typeof data.model !== 'string' || !data.model || data.model.length > 300 || !Number.isInteger(data.limit) || data.limit < 1 || data.limit > 10 || !Number.isInteger(data.excluded) || data.excluded < 0 || !Array.isArray(data.records) || data.records.length > data.limit) throw new Error('网页图片记录损坏');
  const seen = new Set<string>();
  for (const record of data.records) {
    if (!record || !/^img_[a-f0-9-]{36}$/.test(record.id) || seen.has(record.id) || typeof record.url !== 'string' || record.url.length > 8192 || !/^https?:\/\//.test(record.url) || typeof record.alt !== 'string' || record.alt.length > 500 || !['pending','downloading','recognizing','completed','failed','skipped'].includes(record.status) || !Number.isInteger(record.attempts) || record.attempts < 0 || record.attempts > 3) throw new Error('网页图片条目损坏');
    seen.add(record.id);
    if (record.fileName !== undefined && (!imageFilePattern.test(record.fileName) || !record.fileName.startsWith(record.id + '.') || !/^[a-f0-9]{64}$/.test(record.checksum || '') || !['image/png','image/jpeg','image/webp','image/gif'].includes(record.mediaType || ''))) throw new Error('网页原图记录无效');
    for (const [key, max] of [['text',8000],['description',3000],['uncertainty',1000],['error',2000]] as const) if (record[key] !== undefined && (typeof record[key] !== 'string' || record[key]!.length > max)) throw new Error('图片识别文字记录无效');
    if (record.status === 'completed' && (!record.fileName || (!record.text?.trim() && !record.description?.trim()))) throw new Error('图片识别结果不完整');
  }
  return data;
}
export function imageSupplement(data?: PageImageManifest): { text: string; segments: Segment[] } {
  const sections: string[] = []; const segments: Segment[] = [];
  for (const [index, image] of (data?.records || []).entries()) {
    if (image.status !== 'completed') continue;
    const section = `## 图片 ${index + 1} 识别补充（模型输出，请核对）\n\n来源图片：${image.url}\n模型：${data!.model}${image.alt ? `\n原图说明：${image.alt}` : ''}\n\n${image.text ? `### 图中文字\n${image.text}\n\n` : ''}${image.description ? `### 图示解读（模型推断）\n${image.description}\n\n` : ''}${image.uncertainty ? `### 不确定与待核实\n${image.uncertainty}` : '请结合原图核验文字、数字与适用条件。'}`;
    sections.push(section);
    segments.push(...splitSegments(section).map((segment, i) => ({ ...segment, id: `v_${image.id.slice(4).replaceAll('-', '')}_${i + 1}` })));
  }
  return { text: sections.join('\n\n'), segments };
}

/** Sniff raster bytes and dimensions without decoding scripts or unbounded compressed content. */
export function inspectImage(bytes: Buffer) {
  if (!bytes.length || bytes.length > 6 * 1024 * 1024) throw new Error('图片不能为空且最多6MB');
  let type: 'png' | 'jpg' | 'gif' | 'webp' | undefined; let width = 0; let height = 0;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16) === 'IHDR') { type = 'png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
  else if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii',0,6))) { type = 'gif'; width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); }
  else if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset++] !== 255) continue;
      const marker = bytes[offset++]; if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xff || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4,0xc8,0xcc].includes(marker)) { type = 'jpg'; height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break; }
      offset += length;
    }
  } else if (bytes.length >= 30 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') {
    const chunk = bytes.toString('ascii',12,16);
    if (chunk === 'VP8X') { width = bytes.readUIntLE(24,3) + 1; height = bytes.readUIntLE(27,3) + 1; }
    else if (chunk === 'VP8 ' && bytes.subarray(23,26).equals(Buffer.from([157,1,42]))) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    else if (chunk === 'VP8L' && bytes[20] === 0x2f) { const packed = bytes.readUInt32LE(21); width = (packed & 0x3fff) + 1; height = ((packed >>> 14) & 0x3fff) + 1; }
    if (width && height) type = 'webp';
  }
  if (!type || !width || !height) throw new Error('不是有效的PNG、JPEG、WebP或GIF图片（不支持SVG/HTML）');
  if (width > 20_000 || height > 20_000 || width * height > 24_000_000) throw new Error('图片尺寸超过限制（最长边2万像素、总计2400万像素）');
  return { extension: type, mediaType: `image/${type === 'jpg' ? 'jpeg' : type}` as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', width, height };
}
