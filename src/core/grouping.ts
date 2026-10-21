import { randomUUID } from 'node:crypto';
import { categoryName } from './library.js';
import type { GroupingPlan, MaterialDetail, SourceAnalysis } from '../types.js';

const text = (value: unknown, max: number, label: string, empty = false): string => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error(`${label}格式不正确`);
  return value.trim();
};
export function groupingTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error('建议标签最多12个');
  return [...new Set(value.map(v => text(v, 40, '标签')).filter(Boolean))];
}
export function parseModelJson(output: string): unknown {
  try { return JSON.parse(output.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '')); }
  catch { throw new Error('模型没有返回有效的整理格式，请重试'); }
}
export function sourceAnalysis(value: unknown, source: MaterialDetail): SourceAnalysis {
  const data = value as SourceAnalysis;
  if (!data || data.sourceId !== source.id || !['clear', 'uncertain'].includes(data.certainty)) throw new Error('逐篇分析的来源或确定性无效');
  if (!Array.isArray(data.citations) || !data.citations.length || data.citations.length > 20 || data.citations.some(c => c?.materialId !== source.id || !source.segments.some(s => s.id === c.segmentId))) throw new Error('逐篇分析包含无效来源引用');
  const concepts = groupingTags(data.concepts);
  const summary = text(data.summary, 2500, '资料概要');
  if (/library:\/\//.test(summary)) throw new Error('逐篇概要请使用独立引用列表，不在概要编写链接');
  return { sourceId: source.id, theme: text(data.theme, 200, '主题'), summary, concepts, usage: text(data.usage, 800, '用途'), category: categoryName(text(data.category, 180, '建议分类')), tags: groupingTags(data.tags), certainty: data.certainty, uncertainty: text(data.uncertainty, 800, '待核实说明', data.certainty === 'clear'), citations: data.citations.map(c => ({ materialId: c.materialId, segmentId: c.segmentId })) };
}
/** A plan is a complete partition: every selected source occurs exactly once. */
export function groupingPlan(value: unknown, sourceIds: string[], analyses: SourceAnalysis[], fromModel = false): GroupingPlan {
  const data = value as GroupingPlan;
  if (!data || !Array.isArray(data.groups) || !Array.isArray(data.unassigned) || data.groups.length > sourceIds.length || data.unassigned.length > sourceIds.length) throw new Error('分组方案格式不正确');
  const seen = new Set<string>(); const groupIds = new Set<string>();
  const accept = (id: unknown) => {
    if (typeof id !== 'string' || !sourceIds.includes(id) || seen.has(id)) throw new Error('分组资料重复、遗漏或超出所选范围');
    seen.add(id); return id;
  };
  const groups = data.groups.map(group => {
    if (!group || !Array.isArray(group.sourceIds) || !group.sourceIds.length) throw new Error('每个分组必须包含资料');
    const id = fromModel ? `group_${randomUUID()}` : group.id;
    if (typeof id !== 'string' || !/^group_[a-f0-9-]{36}$/.test(id) || groupIds.has(id)) throw new Error('分组ID无效或重复');
    groupIds.add(id);
    return { id, title: text(group.title, 200, '分组名称'), reason: text(group.reason, 1200, '分组理由'), sourceIds: group.sourceIds.map(accept), category: categoryName(text(group.category, 180, '来源分类')), tags: groupingTags(group.tags) };
  });
  const unassigned = data.unassigned.map(item => { if (!item) throw new Error('待整理项无效'); return { sourceId: accept(item.sourceId), reason: text(item.reason, 1200, '待整理理由') }; });
  if (seen.size !== sourceIds.length) throw new Error('分组资料重复、遗漏或超出所选范围');
  if (fromModel) {
    // Uncertain evidence stays pending until a human deliberately assigns it.
    for (const analysis of analyses.filter(a => a.certainty === 'uncertain')) {
      for (const group of groups) group.sourceIds = group.sourceIds.filter(id => id !== analysis.sourceId);
      if (!unassigned.some(item => item.sourceId === analysis.sourceId)) unassigned.push({ sourceId: analysis.sourceId, reason: analysis.uncertainty || '资料信息不足，需进一步核实' });
    }
  }
  if (data.applyClassification !== undefined && typeof data.applyClassification !== 'boolean') throw new Error('同步分类选项无效');
  return { groups: groups.filter(group => group.sourceIds.length), unassigned, applyClassification: fromModel ? true : data.applyClassification ?? true };
}
