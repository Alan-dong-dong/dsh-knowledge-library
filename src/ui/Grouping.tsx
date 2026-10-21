import React, { useState } from 'react';
import type { GroupingPlan, KnowledgeGroup, KnowledgeJob, KnowledgeOverview } from '../types.js';
import { post } from './api.js';
import { Icon } from './icons.js';

const splitTags = (value: string) => value.split(/[,，]/).map(t => t.trim()).filter(Boolean);
interface Props {
  root: string;
  job: KnowledgeJob;
  model: Pick<KnowledgeOverview, 'available' | 'model' | 'reason'>;
  onRefresh: () => void;
  onNotify: (message: string) => void;
  onOpenSource: (id: string, segmentId?: string) => void;
}
export function GroupingEditor({ root, job, model, onRefresh, onNotify, onOpenSource }: Props) {
  const [plan, setPlan] = useState<GroupingPlan>(job.plan!);
  const [version, setVersion] = useState(job.planVersion!);
  const [tagText, setTagText] = useState(Object.fromEntries(plan.groups.map(g => [g.id, g.tags.join('，')])));
  const [apply, setApply] = useState(job.classification?.apply ?? plan.applyClassification ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = !!job.classification;
  const groups = plan.groups.filter(g => g.sourceIds.length);
  function groupValue(id: string, change: Partial<KnowledgeGroup>) { setPlan(p => ({ ...p, groups: p.groups.map(g => g.id === id ? { ...g, ...change } : g) })); }
  function newGroup(sourceId?: string) {
    const source = job.sources.find(s => s.id === sourceId); const analysis = job.analyses?.find(a => a.sourceId === sourceId);
    const id = `group_${crypto.randomUUID()}`;
    const item: KnowledgeGroup = { id, title: analysis?.theme || source?.title || '新分组', reason: source ? '独立整理这份资料' : '请填写资料之间的具体关联', sourceIds: sourceId ? [sourceId] : [], category: analysis?.category || '收件箱', tags: analysis?.tags || [] };
    setTagText(values => ({ ...values, [id]: item.tags.join('，') }));
    setPlan(p => ({ ...p, groups: [...p.groups.map(g => ({ ...g, sourceIds: g.sourceIds.filter(s => s !== sourceId) })), item], unassigned: p.unassigned.filter(s => s.sourceId !== sourceId) }));
  }
  function assign(sourceId: string, target: string) {
    if (target === '__new__') { newGroup(sourceId); return; }
    const analysis = job.analyses?.find(a => a.sourceId === sourceId);
    setPlan(p => ({ ...p,
      groups: p.groups.map(g => ({ ...g, sourceIds: g.id === target ? [...g.sourceIds.filter(id => id !== sourceId), sourceId] : g.sourceIds.filter(id => id !== sourceId) })),
      unassigned: [...p.unassigned.filter(s => s.sourceId !== sourceId), ...(target ? [] : [{ sourceId, reason: analysis?.uncertainty || '暂留待整理，后续再判断关联' }])],
    }));
  }
  function removeGroup(id: string) {
    setPlan(p => ({ ...p, groups: p.groups.filter(g => g.id !== id), unassigned: [...p.unassigned, ...(p.groups.find(g => g.id === id)?.sourceIds || []).map(sourceId => ({ sourceId, reason: '已移出分组，保留待整理' }))] }));
  }
  async function save(confirm: boolean, openSource?: string) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      let currentVersion = version;
      if (!locked) {
        const value = { ...plan, applyClassification: apply, groups: groups.map(g => ({ ...g, tags: splitTags(tagText[g.id] || '') })) };
        const edited = await post<KnowledgeJob>(`/knowledge/jobs/${job.id}/plan`, { expectedRoot: root, version, plan: value }, 'PATCH');
        currentVersion = edited.planVersion!; setVersion(currentVersion);
      }
      if (confirm) {
        await post(`/knowledge/jobs/${job.id}/confirm-plan`, { expectedRoot: root, version: currentVersion, applyClassification: apply, expectedModel: model.model, confirmed: true });
        onNotify(`${groups.length} 组资料已提交生成草稿；${plan.unassigned.length} 份保留待整理`);
        onRefresh();
      } else if (openSource) onOpenSource(openSource);
      else { onNotify('分组方案已保存，来源分类尚未修改'); onRefresh(); }
    } catch (e) { setError((e as Error).message); if (confirm) onRefresh(); }
    finally { setBusy(false); }
  }
  async function rollback() {
    setBusy(true); setError('');
    try { await post(`/knowledge/jobs/${job.id}/rollback-plan`, { expectedRoot: root, confirmed: true }); onNotify('未完成的分类修改已回退'); onRefresh(); }
    catch (e) { setError((e as Error).message); onRefresh(); }
    finally { setBusy(false); }
  }
  return <div className="kl-grouping-editor">
    <div className="kl-grouping-summary"><b>{groups.length} 个分组</b><span>{plan.unassigned.length} 份待整理</span></div>
    <p className="kl-knowledge-model">先核对逐篇分析与分组理由。无关联的资料可独立成组，信息不足的资料可以留待整理。修改后请保存方案，再关闭窗口。</p>
    {job.error && <p role="alert" className="kl-form-error">{job.error}</p>}
    {locked && <div className="kl-grouping-recovery" role="status"><strong>上次归类尚未完成</strong><p>{job.classification!.steps.filter(s => s.done).length} / {job.classification!.steps.length} 份已完成{job.classification!.direction === 'rollback' ? '回退' : '归类'}。方案已锁定，可继续处理或回退已更改的分类。</p><button className="kl-secondary" disabled={busy} onClick={() => void rollback()}>{job.classification!.direction === 'rollback' ? '继续回退分类' : '回退已更改的分类'}</button></div>}
    <div className="kl-grouping-groups">{plan.groups.map((group, index) => <section className="kl-grouping-group" key={group.id} aria-label={`分组 ${index + 1}`}>
      <div className="kl-grouping-group-title"><span>分组 {index + 1} · {group.sourceIds.length} 份资料</span><button className="kl-icon-button kl-danger" aria-label={`删除分组 ${index + 1}`} disabled={busy || locked} onClick={() => removeGroup(group.id)}><Icon name="trash" size={15} /></button></div>
      <label>分组名称<input aria-label={`分组名称 ${index + 1}`} maxLength={200} value={group.title} disabled={busy || locked} onChange={e => groupValue(group.id, { title: e.target.value })} /></label>
      <p className="kl-grouping-reason">{group.reason}</p><details className="kl-grouping-settings"><summary>分类与分组设置 <span>{group.category}</span></summary><label>分组理由<textarea aria-label={`分组理由 ${index + 1}`} rows={2} maxLength={1200} value={group.reason} disabled={busy || locked} onChange={e => groupValue(group.id, { reason: e.target.value })} /></label><div className="kl-knowledge-fields"><label>来源分类<input aria-label={`来源分类 ${index + 1}`} value={group.category} maxLength={180} disabled={busy || locked} onChange={e => groupValue(group.id, { category: e.target.value })} /></label><label>分组标签<input aria-label={`分组标签 ${index + 1}`} value={tagText[group.id] || ''} disabled={busy || locked} onChange={e => setTagText(v => ({ ...v, [group.id]: e.target.value }))} /></label></div></details>
      <ul>{group.sourceIds.map(id => <li key={id}>{job.sources.find(s => s.id === id)?.title}</li>)}</ul>{!group.sourceIds.length && <p className="kl-muted">暂无资料，保存时会忽略空分组。</p>}
    </section>)}</div>
    <button className="kl-secondary" disabled={busy || locked || plan.groups.length >= 10} onClick={() => newGroup()}><Icon name="plus" size={14} />新增分组</button>
    <h3 className="kl-grouping-section-title">逐篇分析与成员调整</h3>
    {job.sources.map(source => {
      const analysis = job.analyses?.find(a => a.sourceId === source.id); const unassigned = plan.unassigned.find(s => s.sourceId === source.id);
      return <article className="kl-grouping-source" key={source.id} aria-label={`${source.title} 的分析`}>
        <div className="kl-grouping-source-title"><strong>{source.title}</strong><span className="kl-knowledge-badge">{analysis?.certainty === 'uncertain' ? '需核对' : '主题建议'}</span></div>
        <p>{analysis?.theme}</p>
        <label>所属分组<select aria-label={`所属分组 ${source.title}`} value={plan.groups.find(g => g.sourceIds.includes(source.id))?.id || ''} disabled={busy || locked} onChange={e => assign(source.id, e.target.value)}><option value="">保留待整理</option>{plan.groups.map(g => <option key={g.id} value={g.id}>{g.title || '未命名分组'}</option>)}<option value="__new__">单独成组</option></select></label>
        {unassigned && <label>待整理理由<input aria-label={`待整理理由 ${source.title}`} maxLength={1200} value={unassigned.reason} disabled={busy || locked} onChange={e => setPlan(p => ({ ...p, unassigned: p.unassigned.map(s => s.sourceId === source.id ? { ...s, reason: e.target.value } : s) }))} /></label>}
        <details><summary>分析详情与来源</summary><p>{analysis?.summary}</p><p>用途：{analysis?.usage}</p><p>概念：{analysis?.concepts.join('、')}</p><p>建议分类：{analysis?.category} · 标签：{analysis?.tags.join('、') || '无'}</p>{analysis?.uncertainty && <p>待核实：{analysis.uncertainty}</p>}<button className="kl-secondary" disabled={busy || locked} onClick={() => void save(false, source.id)}>保存方案并查看来源<Icon name="arrow" size={14} /></button></details>
      </article>;
    })}
    <label className="kl-grouping-sync"><input type="checkbox" aria-label="同步来源分类和标签" checked={apply} disabled={busy || locked} onChange={e => setApply(e.target.checked)} /><span>确认后同步来源分类和标签到本地目录</span></label>
    <p className="kl-knowledge-model">同步时会移动已分组资料的目录、保留原标签并添加分组标签；未分组资料保持待整理。关闭同步可只按组生成草稿。每组生成后仍需单独确认保存正式笔记。</p>
    <p className="kl-knowledge-model">生成草稿使用模型：{model.model || '尚未配置'}。{model.model !== job.model && `逐篇分析时使用的是 ${job.model || '未记录模型'}。`}确认后将继续向该模型发送各组正文。本次智能整理及其子任务合计最多 80 次模型请求（已使用 {job.modelCalls || 0} 次），可能产生调用费用。</p>
    {!!groups.length && !model.available && <p role="alert" className="kl-form-error">{model.reason || '请先配置生成模型'}</p>}
    {error && <p role="alert" className="kl-form-error">{error}</p>}
    <footer>{!locked && <button className="kl-secondary" disabled={busy} onClick={() => void save(false)}>保存分组方案</button>}<button className="kl-primary" disabled={busy || (!!groups.length && !model.available) || job.classification?.direction === 'rollback'} onClick={() => void save(true)}>{busy ? '正在处理…' : locked ? '继续归类并生成草稿' : groups.length ? `确认${apply ? '归类' : '分组'}并生成 ${groups.length} 份草稿` : '确认保留全部待整理'}</button></footer>
  </div>;
}
