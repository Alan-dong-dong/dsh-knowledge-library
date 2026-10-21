import React, { useEffect, useState } from 'react';
import type { KnowledgeDraft, KnowledgeJob, KnowledgeOverview, KnowledgeState, MaterialDetail } from '../types.js';
import { api, post } from './api.js';
import { Dialog } from './Dialog.js';
import { Icon } from './icons.js';

const stateLabels = { pending: '待整理', running: '整理中', draft: '待确认', completed: '已整理', failed: '整理失败' };
const jobLabels: Record<KnowledgeJob['status'], string> = { queued: '排队中', running: '整理中', draft: '待确认', completed: '已保存', failed: '失败', cancelled: '已取消', discarded: '已舍弃' };
export function KnowledgeBadge({ state }: { state?: KnowledgeState }) {
  return <span className={`kl-knowledge-badge ${state?.status || 'pending'}`}>{stateLabels[state?.status || 'pending']}</span>;
}

export function StartKnowledgeDialog({ root, sourceIds, model, onClose, onCreated }: { root: string; sourceIds: string[]; model: KnowledgeOverview; onClose: () => void; onCreated: (job: KnowledgeJob) => void }) {
  const [sources, setSources] = useState<MaterialDetail[]>();
  const [topic, setTopic] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all(sourceIds.map(id => api<MaterialDetail>(`/materials/${id}`, { signal: abort.signal }))).then(setSources).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [sourceIds]);
  const characters = sources?.reduce((sum, source) => sum + source.content.length, 0) || 0;
  const invalidSource = sources?.some(s => s.deletedAt || s.kind === 'note' || s.status !== 'ready');
  async function start(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { onCreated(await post<KnowledgeJob>('/knowledge/jobs', { expectedRoot: root, sourceIds, topic })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Dialog title="生成知识笔记" description="先提炼资料，再由你确认。原始资料与来源引用会保留。" onClose={() => { if (!busy) onClose(); }}>
    <form className="kl-knowledge-form" onSubmit={event => void start(event)}>
      <div className="kl-knowledge-summary"><b>{sourceIds.length} 份来源资料</b><span>{characters.toLocaleString()} 字</span></div>
      <ul className="kl-knowledge-source-list">{sources?.map(s => <li key={s.id}><Icon name="file" size={14} /><span>{s.title}</span></li>)}</ul>
      <label>整理主题<input aria-label="整理主题" value={topic} onChange={e => setTopic(e.target.value)} maxLength={300} placeholder="例如：Harness 如何提高 Agent 的可靠性" /><small>留空时围绕资料本身整理；多篇资料会比较共识、差异和矛盾。</small></label>
      <p className="kl-muted">将提炼核心观点、关键概念、可复用方法、适用条件与局限、待验证问题，并标注来源段落。</p>
      {model.available ? <p className="kl-knowledge-model">使用模型：{model.model}。点击开始后会向该模型发送所选正文，可能产生调用费用。长文会分段提炼，最多 21 次模型请求；单次最多 10 份、正文总量 10 万字。</p> : <div><p role="alert" className="kl-form-error">{model.reason}</p><a className="kl-knowledge-help" href="https://github.com/Alan-dong-dong/dsh-knowledge-library#将资料整理为知识笔记" target="_blank" rel="noreferrer">查看模型配置说明 <Icon name="arrow" size={12} /></a></div>}
      {characters > 100_000 && <p role="alert" className="kl-form-error">正文超过 10 万字，请减少选择后分批整理。</p>}
      {invalidSource && <p role="alert" className="kl-form-error">部分资料已删除、仅归档或属于知识笔记，请重新选择。</p>}
      {error && <p role="alert" className="kl-form-error">{error}</p>}
      <footer><button type="button" className="kl-secondary" disabled={busy} onClick={onClose}>取消</button><button className="kl-primary" disabled={busy || !sources || !model.available || characters > 100_000 || invalidSource}>{busy ? '正在提交…' : '开始整理'}</button></footer>
    </form>
  </Dialog>;
}

interface JobsProps {
  root: string;
  jobId?: string;
  overview: KnowledgeOverview;
  onClose: () => void;
  onRefresh: () => void;
  onRegenerate: (ids: string[]) => void;
  onOpenSource: (id: string, segmentId?: string) => void;
  onSaved: (id: string) => void;
  onNotify: (message: string) => void;
}
export function KnowledgeJobsDialog(props: JobsProps) {
  const { root, overview, onClose, onRefresh, onRegenerate, onOpenSource, onSaved, onNotify } = props;
  const [selected, setSelected] = useState(props.jobId);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const job = overview.jobs.find(j => j.id === selected);
  async function action(name: 'cancel' | 'discard') {
    if (!job) return;
    setBusy(true); setError('');
    try { await post(`/knowledge/jobs/${job.id}/${name}`, { expectedRoot: root }); onRefresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Dialog title={job?.status === 'draft' ? '确认知识笔记' : '知识整理'} description="整理任务与草稿保存在本地。确认保存后，笔记会出现在知识笔记中。" onClose={() => { if (!busy) onClose(); }}>
    <div className="kl-knowledge-jobs">
      {!!selected && <button className="kl-knowledge-back" onClick={() => { setSelected(undefined); setError(''); }}>← 全部整理任务</button>}
      {!overview.supported && <p role="alert" className="kl-form-error">{overview.reason}</p>}
      {error && <p role="alert" className="kl-form-error">{error}</p>}
      {!selected ? <>{!overview.jobs.length ? <div className="kl-knowledge-empty"><Icon name="note" size={26} /><p>还没有整理任务</p><small>打开一份资料点击“生成知识笔记”，或在列表中选择“批量整理”。</small></div> : overview.jobs.map(item => <button key={item.id} className="kl-knowledge-job" onClick={() => { setSelected(item.id); setError(''); }}><div><strong>{item.topic || item.sources.map(s => s.title).join('、')}</strong><span className={`kl-knowledge-badge ${item.status}`}>{jobLabels[item.status]}</span></div><p>{item.sourceIds.length} 份来源 · {new Date(item.updatedAt).toLocaleString('zh-CN')}</p>{item.error && <small>{item.error}</small>}</button>)}</> : !job ? <p className="kl-muted">正在读取整理任务…</p> : <>
        <div className="kl-knowledge-job-heading"><strong>{job.topic || job.sources.map(s => s.title).join('、')}</strong><span className={`kl-knowledge-badge ${job.status}`}>{jobLabels[job.status]}</span></div>
        {job.status === 'draft' && job.draft ? <DraftEditor key={`${job.id}:${job.draftVersion}`} root={root} job={job} onRefresh={onRefresh} onOpenSource={onOpenSource} onSaved={onSaved} onNotify={onNotify} /> : <>
          <p className="kl-knowledge-progress" role="status">{['queued', 'running'].includes(job.status) && <span className="kl-spinner" />}{job.progress}</p>
          {job.error && <p role="alert" className="kl-form-error">{job.error}</p>}
          {job.model && <p className="kl-muted">模型：{job.model}</p>}
          {job.status === 'completed' && job.noteId && (job.sourceIds.some(id => overview.states[id]?.noteIds.includes(job.noteId!)) ? <button className="kl-primary" onClick={() => onOpenSource(job.noteId!)}>打开知识笔记</button> : <p className="kl-muted">关联笔记已移入回收站或永久删除，可恢复笔记或重新整理。</p>)}
        </>}
        <div className="kl-knowledge-actions">{['queued', 'running'].includes(job.status) && <button className="kl-secondary" disabled={busy} onClick={() => void action('cancel')}>取消整理</button>}{['draft', 'failed'].includes(job.status) && <button className="kl-secondary kl-danger" disabled={busy} onClick={() => void action('discard')}>舍弃{job.status === 'draft' ? '草稿' : '任务'}</button>}{['failed', 'cancelled', 'discarded', 'completed'].includes(job.status) && <button className="kl-secondary" onClick={() => onRegenerate(job.sourceIds)}>重新整理</button>}</div>
      </>}
    </div>
  </Dialog>;
}

function DraftEditor({ root, job, onRefresh, onOpenSource, onSaved, onNotify }: { root: string; job: KnowledgeJob; onRefresh: () => void; onOpenSource: JobsProps['onOpenSource']; onSaved: JobsProps['onSaved']; onNotify: JobsProps['onNotify'] }) {
  const [draft, setDraft] = useState<KnowledgeDraft>(job.draft!);
  const [version, setVersion] = useState(job.draftVersion);
  const [tags, setTags] = useState(draft.tags.join('，'));
  const [category, setCategory] = useState(draft.category || '知识笔记');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(confirm: boolean, source?: { id: string; segment?: string }) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const edited = await post<KnowledgeJob>(`/knowledge/jobs/${job.id}`, { expectedRoot: root, version, draft: { ...draft, category, tags: tags.split(/[,，]/).map(t => t.trim()).filter(Boolean) } }, 'PATCH');
      setVersion(edited.draftVersion);
      if (confirm) {
        const result = await post<{ material: MaterialDetail }>(`/knowledge/jobs/${job.id}/confirm`, { expectedRoot: root, version: edited.draftVersion, category, confirmed: true });
        onSaved(result.material.id);
      } else if (source) onOpenSource(source.id, source.segment);
      else { onNotify('草稿已保存，尚未生成正式笔记'); onRefresh(); }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <form className="kl-knowledge-draft" onSubmit={e => { e.preventDefault(); void save(true); }}>
    <p className="kl-knowledge-model">这是模型生成的草稿，请核对理解与证据。修改后请保存草稿，再关闭窗口。</p>
    <label>笔记标题<input aria-label="笔记标题" required maxLength={300} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
    <label>笔记正文<textarea aria-label="笔记正文" required rows={14} maxLength={50_000} value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })} /></label>
    <div className="kl-knowledge-fields"><label>笔记分类<input aria-label="笔记分类" value={category} onChange={e => setCategory(e.target.value)} maxLength={180} /></label><label>标签<input aria-label="笔记标签" value={tags} onChange={e => setTags(e.target.value)} placeholder="逗号分隔" /></label></div>
    <details className="kl-knowledge-citations"><summary>{draft.citations.length} 条来源引用</summary><p>查看来源前会先保存当前草稿。</p>{draft.citations.map((citation, index) => <button type="button" key={index} disabled={busy} onClick={() => void save(false, { id: citation.materialId, segment: citation.segmentId })}><Icon name="file" size={14} /><span>{job.sources.find(s => s.id === citation.materialId)?.title} / {citation.segmentId}</span><Icon name="arrow" size={14} /></button>)}</details>
    {error && <p role="alert" className="kl-form-error">{error}</p>}
    <footer><button type="button" className="kl-secondary" disabled={busy} onClick={() => void save(false)}>保存草稿</button><button className="kl-primary" disabled={busy}>{busy ? '正在保存…' : '确认保存笔记'}</button></footer>
  </form>;
}
