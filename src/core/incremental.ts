import { createHash } from 'node:crypto';
import type { Library } from './library.js';
import type { KnowledgeDraft, MaterialDetail, Material, NoteIntegration } from '../types.js';

export const noteFingerprint = (note: MaterialDetail) => createHash('sha256').update(JSON.stringify([note.content, note.segments, note.title, note.category, note.tags, note.citations, note.revision, note.updatedAt, note.deletedAt, note.deletionId])).digest('hex');
const tokens = (text: string) => [...new Set((text.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]+/gu) || []).flatMap(term => /^[\p{Script=Han}]/u.test(term) ? Array.from({ length: Math.max(0, term.length - 1) }, (_, index) => term.slice(index, index + 2)) : [term]))].slice(0, 500);

/** Local lexical recall, followed by full-body model comparison; no silent body truncation. */
export function recallNotes(library: Library, draft: KnowledgeDraft, topic: string, sources: MaterialDetail[]) {
  const rows = library.db.prepare('SELECT id,meta,content FROM materials ORDER BY updated_at DESC').all() as Array<{id: string; meta: string; content: string}>;
  const query = tokens([topic, draft.title, ...draft.tags, ...sources.flatMap(s => [s.title, ...s.tags]), draft.content].join(' '));
  const notes = rows.map(row => ({ ...row, metadata: JSON.parse(row.meta) as Material })).filter(row => row.metadata.kind === 'note' && !row.metadata.deletedAt);
  const ranked = notes.map(row => {
    const title = `${row.metadata.title} ${row.metadata.tags.join(' ')}`.toLowerCase();
    const body = row.content.toLowerCase();
    return { ...row, score: query.reduce((sum, term) => sum + (title.includes(term) ? 4 : body.includes(term) ? 1 : 0), 0) };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score);
  let size = 0; let oversized = 0; const candidates: MaterialDetail[] = [];
  for (const row of ranked) {
    if (row.content.length > 50_000) { oversized++; continue; }
    if (candidates.length >= 5 || size + row.content.length > 60_000) continue;
    const note = library.get(row.id); candidates.push(note); size += note.content.length;
  }
  return { candidates, search: { scanned: notes.length, matched: ranked.length, compared: candidates.length, oversized } };
}

export function integrationValue(value: unknown, candidates: MaterialDetail[], search: NoteIntegration['search']): NoteIntegration {
  const data = value as Record<string, unknown>;
  const bounded = (v: unknown, max: number, label: string, empty = false) => {
    if (typeof v !== 'string' || v.length > max || (!empty && !v.trim())) throw new Error(`增量整理的${label}无效`);
    return v.trim();
  };
  const list = (v: unknown) => { if (!Array.isArray(v) || v.length > 12) throw new Error('增量对比列表格式无效'); return v.map(item => bounded(item, 1000, '对比说明')); };
  if (!data || !['new', 'append', 'duplicate'].includes(data.action as string)) throw new Error('增量整理建议格式无效');
  const recommendation = data.action as NoteIntegration['recommendation'];
  const target = recommendation === 'new' ? undefined : candidates.find(n => n.id === data.noteId);
  if (recommendation !== 'new' && !target) throw new Error('增量整理指定了未检索的笔记');
  const content = bounded(data.content, 50_000, '新增正文', recommendation !== 'append');
  if (recommendation !== 'append' && content) throw new Error('新建或重复建议不应包含追加正文');
  if (target && content && target.content.includes(content)) throw new Error('建议追加的正文已存在，请重新核对');
  return { recommendation, choice: recommendation, reason: bounded(data.reason, 2000, '建议理由'), overlaps: list(data.overlaps), additions: list(data.additions), conflicts: list(data.conflicts), content, search,
    ...(target ? { target: { id: target.id, title: target.title, category: target.category, revision: target.revision, fingerprint: noteFingerprint(target), content: target.content } } : {}) };
}
