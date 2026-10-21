import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, lstatSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { resolve, join, dirname, basename, extname, relative, isAbsolute } from 'node:path';
import type { CaptureFields, CaptureResult, Citation, EmptyTrashResult, Material, MaterialDetail, SearchOptions, SearchResult, Segment, TrashSnapshot } from '../types.js';
import { PurgeStore } from './purge.js';
import { extractArticle, formatTime, parseSubtitles, splitSegments } from './extract.js';
import { validateUrl } from './fetch.js';

export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_TEXT_CHARS = 2_000_000;
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const now = () => new Date().toISOString();
const cleanString = (value: unknown, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export function categoryName(value: unknown): string {
  const parts = cleanString(value, 180).split(/[\\/]/).filter(Boolean);
  if (parts.length > 5 || parts.some(p => p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) {
    throw new Error('分类最多 5 层，不能包含路径跳转、保留名称或特殊文件名字符');
  }
  return parts.join('/') || '收件箱';
}
export function atomicJson(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
  renameSync(tmp, path);
}

export class Library {
  readonly root: string;
  readonly db!: DatabaseSync;
  readonly warnings: string[] = [];
  private lockPath: string;
  private closed = false;
  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error('资料库目录必须是绝对路径');
    this.root = resolve(root);
    mkdirSync(join(this.root, '.system'), { recursive: true });
    mkdirSync(join(this.root, 'materials'), { recursive: true });
    this.lockPath = join(this.root, '.system', 'writer.lock');
    if (existsSync(this.lockPath)) {
      const previous = Number(readFileSync(this.lockPath, 'utf8'));
      if (!Number.isInteger(previous) || previous <= 0) throw new Error('资料库锁文件无效，请确认没有其他实例后移除 .system/writer.lock');
      let alive = false;
      try { process.kill(previous, 0); alive = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') alive = true; }
      if (alive) throw new Error('这个资料库已被另一实例打开，请关闭独立预览或另一个 Harness 实例');
      unlinkSync(this.lockPath);
    }
    const fd = openSync(this.lockPath, 'wx');
    writeFileSync(fd, String(process.pid)); closeSync(fd);
    try {
      this.db = new DatabaseSync(join(this.root, '.system', 'index.sqlite'));
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, path TEXT NOT NULL, meta TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS material_fts USING fts5(id UNINDEXED, title, content, tokenize='trigram');`);
      this.rebuild();
      this.warnings.push(...this.cleanupPendingPurge().map(error => `待清理文件：${error}`));
    } catch (error) {
      try { this.db!.close(); } catch {}
      unlinkSync(this.lockPath); throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    if (existsSync(this.lockPath) && readFileSync(this.lockPath, 'utf8') === String(process.pid)) unlinkSync(this.lockPath);
  }
  private assertContained(path: string): void {
    const rel = relative(this.root, resolve(path));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('路径超出资料库');
    let current = this.root;
    for (const part of rel.split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('资料库不支持符号链接目录');
    }
  }
  private index(meta: Material, path: string, content: string) {
    this.db.prepare('INSERT OR REPLACE INTO materials VALUES (?,?,?,?,?,?)').run(meta.id, path, JSON.stringify(meta), content, meta.contentHash, meta.updatedAt);
    this.db.prepare('DELETE FROM material_fts WHERE id=?').run(meta.id);
    this.db.prepare('INSERT INTO material_fts (id,title,content) VALUES (?,?,?)').run(meta.id, meta.title, content);
  }
  rebuild(): { indexed: number; warnings: string[] } {
    this.warnings.length = 0;
    const entries: Array<{ meta: Material; path: string; content: string }> = [];
    const visit = (directory: string, depth: number) => {
      if (depth > 7) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (!existsSync(join(path, 'metadata.json'))) { visit(path, depth + 1); continue; }
        try {
          this.assertContained(path);
          const meta = JSON.parse(readFileSync(join(path, 'metadata.json'), 'utf8')) as Material;
          if (meta.schemaVersion !== 1 || !/^r_[a-f0-9-]+$/.test(meta.id) || meta.id !== entry.name || !Array.isArray(meta.tags) || !Array.isArray(meta.citations)) throw new Error('元数据格式不正确');
          if (!['text','web','file','video','transcript','note'].includes(meta.kind)) throw new Error('未知资料类型');
          const content = readFileSync(join(path, 'content.md'), 'utf8');
          const segmentsRaw = readFileSync(join(path, 'segments.json'), 'utf8');
          const segments = JSON.parse(segmentsRaw);
          if (!Array.isArray(segments)) throw new Error('缺少可引用段落');
          if ((meta.textChecksum && hash(content) !== meta.textChecksum) || (meta.segmentsChecksum && hash(segmentsRaw) !== meta.segmentsChecksum)) {
            throw new Error('正文或引用段落被外部修改，请恢复原文件或将修改后的内容重新导入');
          }
          // The physical category remains recoverable after an interrupted move.
          meta.category = relative(join(this.root, 'materials'), dirname(path)).split('\\').join('/');
          entries.push({ meta, path, content });
        } catch (error) { this.warnings.push(`${entry.name}: ${(error as Error).message}`); }
      }
    };
    visit(join(this.root, 'materials'), 0);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM materials; DELETE FROM material_fts');
      for (const entry of entries) this.index(entry.meta, entry.path, entry.content);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { indexed: entries.length, warnings: [...this.warnings] };
  }
  private row(id: string) {
    const row = this.db.prepare('SELECT * FROM materials WHERE id=?').get(id) as { id: string; path: string; meta: string; content: string } | undefined;
    if (!row) throw new Error('资料不存在');
    this.assertContained(row.path);
    return row;
  }
  get(id: string): MaterialDetail {
    const row = this.row(id);
    return { ...JSON.parse(row.meta), content: row.content, segments: JSON.parse(readFileSync(join(row.path, 'segments.json'), 'utf8')), path: row.path };
  }
  has(id: string): boolean { return Boolean(this.db.prepare('SELECT id FROM materials WHERE id=?').get(id)); }
  original(id: string): { bytes: Buffer; name: string } {
    const item = this.get(id);
    if (!item.originalFile || basename(item.originalFile) !== item.originalFile) throw new Error('该资料没有原始附件');
    const path = join(item.path, item.originalFile);
    this.assertContained(path);
    return { bytes: readFileSync(path), name: item.originalName || item.originalFile };
  }
  private save(content: string, fields: CaptureFields, extra: Partial<Material> & { kind: Material['kind'] }, original?: { name: string; bytes: Buffer }, suppliedSegments?: Segment[]): CaptureResult {
    if (content.length > MAX_TEXT_CHARS) throw new Error('正文超过 200 万字符，请拆分后导入');
    const digest = hash(`${extra.kind}\0${original ? hash(original.bytes) : content}\0${fields.sourceUrl ?? ''}\0${JSON.stringify(extra.citations ?? [])}`);
    const duplicate = this.db.prepare('SELECT id FROM materials WHERE content_hash=? LIMIT 1').get(digest) as { id: string } | undefined;
    if (duplicate) return { material: this.get(duplicate.id).deletedAt ? this.restore(duplicate.id) : this.get(duplicate.id), duplicate: true };
    const category = categoryName(fields.category);
    const id = `r_${randomUUID()}`;
    const timestamp = now();
    const meta: Material = {
      schemaVersion: 1, id, title: cleanString(fields.title, 300) || content.split('\n').find(line => line.trim())?.replace(/^#+\s*/, '').slice(0, 100) || '未命名资料',
      status: 'ready', category, tags: this.tags(fields.tags),
      collection: cleanString(fields.collection), sourceNote: cleanString(fields.sourceNote, 2000),
      createdAt: timestamp, updatedAt: timestamp, contentHash: digest, revision: 1, citations: [],
      extraction: '原始文本', ...extra,
    };
    if (fields.sourceUrl) meta.sourceUrl = validateUrl(fields.sourceUrl).href;
    const path = join(this.root, 'materials', ...category.split('/'), id);
    this.assertContained(path);
    const stage = join(dirname(path), `.pending-${id}`);
    mkdirSync(stage, { recursive: true });
    if (original) {
      if (original.bytes.length > MAX_FILE_BYTES) throw new Error('文件超过 64 MB');
      const extension = extname(original.name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 16);
      meta.originalName = basename(original.name);
      meta.originalFile = `original${extension || '.bin'}`;
      writeFileSync(join(stage, meta.originalFile), original.bytes);
    }
    const segmentsJson = JSON.stringify(suppliedSegments ?? splitSegments(content), null, 2);
    meta.textChecksum = hash(content);
    meta.segmentsChecksum = hash(segmentsJson);
    writeFileSync(join(stage, 'content.md'), content, 'utf8');
    writeFileSync(join(stage, 'segments.json'), segmentsJson, 'utf8');
    atomicJson(join(stage, 'metadata.json'), meta);
    renameSync(stage, path); // A committed material always has all canonical files.
    this.db.exec('BEGIN IMMEDIATE');
    try { this.index(meta, path, content); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { material: this.get(id), duplicate: false };
  }
  private tags(values: unknown): string[] {
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.some(v => typeof v !== 'string')) throw new Error('标签必须是字符串数组');
    return [...new Set(values.map(v => cleanString(v, 40)).filter(Boolean))].slice(0, 30);
  }
  captureText(text: string, fields: CaptureFields = {}): CaptureResult {
    if (typeof text !== 'string' || !text.trim()) throw new Error('请填写要保存的正文');
    return this.save(text.trim(), fields, { kind: 'text' });
  }
  captureHtml(html: string, url: string, fields: CaptureFields = {}): CaptureResult {
    const source = validateUrl(url).href;
    const article = extractArticle(html, source);
    return this.save(article.content, { ...fields, title: fields.title || article.title, sourceUrl: source }, {
      kind: 'web', author: article.author, extraction: `${article.extraction}；图片保留远程引用，未离线下载`,
    }, { name: 'page.html', bytes: Buffer.from(html) });
  }
  importFile(path: string, fields: CaptureFields = {}): CaptureResult {
    if (!isAbsolute(path)) throw new Error('请输入文件的绝对路径');
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('仅支持不超过 64 MB 的普通文件');
    return this.importBytes(basename(path), readFileSync(path), fields);
  }
  importBytes(name: string, bytes: Buffer, fields: CaptureFields = {}): CaptureResult {
    if (bytes.length > MAX_FILE_BYTES || !bytes.length) throw new Error('文件不能为空，且不能超过 64 MB');
    const extension = extname(name).toLowerCase();
    const original = { name: basename(name), bytes };
    const data = { ...fields, title: fields.title || basename(name, extension) };
    if (['.vtt', '.srt'].includes(extension)) {
      const segments = parseSubtitles(this.decode(bytes));
      return this.save(segments.map(p => `[${formatTime(p.startSeconds!)}] ${p.text}`).join('\n\n'), data,
        { kind: 'transcript', extraction: '导入字幕；包含时间戳，未分析视频画面' }, original, segments);
    }
    if (['.html', '.htm'].includes(extension)) {
      const article = extractArticle(this.decode(bytes), fields.sourceUrl || 'https://import.invalid/');
      return this.save(article.content, { ...data, title: fields.title || article.title }, { kind: 'file', extraction: `本地 HTML：${article.extraction}；图片保留远程引用，未离线下载`, author: article.author }, original);
    }
    if (['.txt', '.md', '.markdown', '.csv', '.json', '.log'].includes(extension)) {
      return this.save(this.decode(bytes), data, { kind: 'file', extraction: 'UTF-8 文本导入' }, original);
    }
    const video = ['.mp4', '.mkv', '.mov', '.webm', '.mp3', '.wav', '.m4a', '.ogg'].includes(extension);
    return this.save('', data, {
      kind: video ? 'video' : 'file', status: 'stored',
      extraction: video ? '已保存原文件；尚未转写，也未分析画面。请另行导入 SRT/VTT 字幕并归入同一专题。' : '已保存原文件；此格式暂不支持正文提取。',
    }, original, []);
  }
  private decode(bytes: Buffer): string {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('文本编码不是 UTF-8，请转换编码后导入'); }
  }
  update(id: string, fields: CaptureFields): MaterialDetail {
    const item = this.get(id);
    if (item.deletedAt) throw new Error('请先从回收站恢复资料后再编辑');
    const { content, segments: _segments, path: oldPath, ...meta } = item;
    if (fields.title !== undefined) {
      if (!cleanString(fields.title)) throw new Error('标题不能为空');
      meta.title = cleanString(fields.title, 300);
    }
    if (fields.tags !== undefined) meta.tags = this.tags(fields.tags);
    if (fields.category !== undefined) meta.category = categoryName(fields.category);
    if (fields.collection !== undefined) meta.collection = cleanString(fields.collection);
    if (fields.sourceNote !== undefined) meta.sourceNote = cleanString(fields.sourceNote, 2000);
    meta.updatedAt = now();
    const path = join(this.root, 'materials', ...meta.category.split('/'), id);
    this.assertContained(path);
    if (path !== oldPath) { mkdirSync(dirname(path), { recursive: true }); renameSync(oldPath, path); }
    atomicJson(join(path, 'metadata.json'), meta);
    this.db.exec('BEGIN IMMEDIATE');
    try { this.index(meta, path, content); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(id);
  }
  trash(id: string): MaterialDetail { return this.setDeleted(id, true); }
  restore(id: string): MaterialDetail { return this.setDeleted(id, false); }
  private setDeleted(id: string, deleted: boolean): MaterialDetail {
    const item = this.get(id);
    if (Boolean(item.deletedAt) === deleted) return item;
    const { content, segments: _segments, path, ...previous } = item;
    const meta = { ...previous, updatedAt: now() };
    if (deleted) { meta.deletedAt = now(); meta.deletionId = randomUUID(); }
    else { delete meta.deletedAt; delete meta.deletionId; }
    // Keep the canonical files and stable IDs in place so existing citations
    // remain readable. The flag also survives rebuilding a lost SQLite index.
    this.db.exec('BEGIN IMMEDIATE');
    let written = false;
    try {
      atomicJson(join(path, 'metadata.json'), meta); written = true;
      this.index(meta, path, content);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (written) atomicJson(join(path, 'metadata.json'), previous);
      throw error;
    }
    return this.get(id);
  }
  private trashPlan() {
    const rows = this.db.prepare('SELECT id,path,meta FROM materials ORDER BY id').all() as Array<{ id: string; path: string; meta: string }>;
    const items = rows.map(row => ({ ...row, metadata: JSON.parse(row.meta) as Material })).filter(row => row.metadata.deletedAt);
    const pending = new PurgeStore(this.root).list();
    const token = hash(JSON.stringify({ items: items.map(row => [row.id, row.metadata.deletedAt, row.metadata.deletionId]), pending: pending.map(row => row.id) }));
    return { items, pending, token };
  }
  trashSnapshot(): TrashSnapshot {
    const plan = this.trashPlan(); return { count: plan.items.length, pending: plan.pending.length, token: plan.token };
  }
  private cleanupPendingPurge(): string[] {
    const store = new PurgeStore(this.root);
    const errors: string[] = [];
    try {
      for (const ticket of store.list()) {
        try { store.finish(ticket); }
        catch (error) { errors.push(`${ticket.id}：${(error as Error).message}`); }
      }
    } catch (error) { errors.push((error as Error).message); }
    return errors;
  }
  emptyTrash(expectedToken: string): EmptyTrashResult {
    const plan = this.trashPlan();
    if (typeof expectedToken !== 'string' || expectedToken !== plan.token) throw new Error('回收站内容已改变，请重新打开清空确认窗口');
    const store = new PurgeStore(this.root);
    // Preflight the entire confirmed scope before moving or removing anything.
    for (const item of plan.items) {
      const expected = join(this.root, 'materials', ...categoryName(item.metadata.category).split('/'), item.id);
      if (resolve(item.path) !== resolve(expected)) throw new Error('清理目标与资料目录不一致');
      store.validate(item.id, item.path);
    }
    const errors = this.cleanupPendingPurge();
    let deleted = 0;
    for (const item of plan.items) {
      try {
        const ticket = store.stage(item.id, item.path);
        let transaction = false;
        try {
          this.db.exec('BEGIN IMMEDIATE'); transaction = true;
          this.db.prepare('DELETE FROM material_fts WHERE id=?').run(item.id);
          this.db.prepare('DELETE FROM materials WHERE id=?').run(item.id);
          this.db.exec('COMMIT'); transaction = false;
        } catch (error) {
          if (transaction) this.db.exec('ROLLBACK');
          store.rollback(ticket); throw error;
        }
        deleted++;
        try { store.finish(ticket); }
        catch (error) { errors.push(`${item.id}：文件清理未完成，${(error as Error).message}`); }
      } catch (error) { errors.push(`${item.id}：${(error as Error).message}`); }
    }
    return { deleted, pending: store.list().length, errors };
  }
  saveNote(content: string, citations: Citation[], fields: CaptureFields): CaptureResult {
    if (!content?.trim()) throw new Error('笔记内容不能为空');
    if (!Array.isArray(citations) || citations.length > 200) throw new Error('引用必须是数组且最多 200 条');
    for (const citation of citations) {
      const source = this.get(citation.materialId);
      if (citation.segmentId && !source.segments.some(s => s.id === citation.segmentId)) throw new Error(`引用段落不存在：${citation.segmentId}`);
    }
    return this.save(content.trim(), fields, { kind: 'note', citations, extraction: '知识笔记；内容由用户或 Agent 提供，请结合引用核验' });
  }
  search(options: SearchOptions = {}): { items: SearchResult[]; total: number } {
    const query = cleanString(options.query, 500);
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 40));
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const rows = this.db.prepare('SELECT id,meta,content FROM materials ORDER BY updated_at DESC').all() as Array<{ id: string; meta: string; content: string }>;
    // Literal substring matching guarantees one- and two-character Chinese searches.
    // FTS narrows body/title candidates for longer terms; metadata is always searched too.
    let indexed: Set<string> | undefined;
    if (terms.length === 1 && [...terms[0]].length >= 3) {
      indexed = new Set((this.db.prepare('SELECT id FROM material_fts WHERE material_fts MATCH ?').all(`"${terms[0].replaceAll('"', '""')}"`) as Array<{ id: string }>).map(row => row.id));
    }
    const matched = rows.filter(row => {
      const meta = JSON.parse(row.meta) as Material;
      if (Boolean(meta.deletedAt) !== (options.trashed === true)) return false;
      if (options.category && meta.category !== options.category && !meta.category.startsWith(`${options.category}/`)) return false;
      if (options.kind && meta.kind !== options.kind) return false;
      if (options.tag && !meta.tags.includes(options.tag)) return false;
      if (options.collection && meta.collection !== options.collection) return false;
      const metadataText = `${meta.title}\n${meta.category}\n${meta.tags.join(' ')}\n${meta.collection}\n${meta.sourceNote}`.toLocaleLowerCase();
      if (!terms.length) return true;
      const haystack = metadataText + '\n' + row.content.toLocaleLowerCase();
      // FTS is an optimization hint only; punctuation and Unicode never change correctness.
      return indexed?.has(row.id) || terms.every(term => haystack.includes(term));
    });
    return {
      total: matched.length,
      items: matched.slice(offset, offset + limit).map(row => {
        const item = this.get(row.id);
        const { content, segments, path: _path, ...meta } = item;
        const matches = terms.length ? segments.filter(p => terms.some(t => p.text.toLocaleLowerCase().includes(t))).slice(0, 3) : [];
        return { ...meta, excerpt: (matches[0]?.text ?? content).slice(0, 240), matches: matches.map(p => ({ ...p, text: p.text.slice(0, 600), citation: `library://${item.id}/${p.id}` })) };
      }),
    };
  }
  stats() {
    const rows = this.db.prepare('SELECT meta FROM materials').all() as Array<{ meta: string }>;
    const all = rows.map(row => JSON.parse(row.meta) as Material);
    const materials = all.filter(item => !item.deletedAt);
    const count = (select: (m: Material) => string[]) => {
      const map = new Map<string, number>();
      for (const m of materials) for (const key of select(m)) if (key) map.set(key, (map.get(key) || 0) + 1);
      return [...map].sort((a, b) => a[0].localeCompare(b[0], 'zh')).map(([name, count]) => ({ name, count }));
    };
    let purgePending = 0;
    try { purgePending = new PurgeStore(this.root).list().length; } catch { /* Clearing reports invalid cleanup records without breaking normal reading. */ }
    return { total: materials.length, trashed: all.length - materials.length, canEmptyTrash: true, purgePending, ready: materials.filter(m => m.status === 'ready').length, notes: materials.filter(m => m.kind === 'note').length,
      inbox: materials.filter(m => m.category === '收件箱').length, categories: count(m => [m.category]),
      tags: count(m => m.tags), collections: count(m => [m.collection]), root: this.root, warnings: [...this.warnings] };
  }
  exportMarkdown(id: string): string {
    const item = this.get(id);
    const header = JSON.stringify({ id: item.id, title: item.title, category: item.category, tags: item.tags, collection: item.collection, sourceUrl: item.sourceUrl, createdAt: item.createdAt, revision: item.revision }, null, 2);
    const references = item.citations.map(c => {
      if (!this.has(c.materialId)) return `- 来源已永久删除 — library://${c.materialId}${c.segmentId ? `/${c.segmentId}` : ''}`;
      const source = this.get(c.materialId);
      const segment = c.segmentId ? source.segments.find(p => p.id === c.segmentId) : undefined;
      return `- ${source.title} — library://${source.id}${c.segmentId ? `/${c.segmentId}` : ''}${segment?.startSeconds !== undefined ? ` (${formatTime(segment.startSeconds)})` : ''}${source.sourceUrl ? ` — ${source.sourceUrl}` : ''}`;
    }).join('\n');
    return `---\n${header}\n---\n\n# ${item.title}\n\n${item.content}${references ? `\n\n## 来源\n\n${references}` : ''}\n`;
  }
}
