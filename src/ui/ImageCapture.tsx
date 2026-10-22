import React, { useEffect, useState } from 'react';
import type { ImageCaptureStatus, MaterialDetail } from '../types.js';
import { API, api, post } from './api.js';
import { Dialog } from './Dialog.js';

export function ImageSettings({ root }: { root: string }) {
  const [status, setStatus] = useState<ImageCaptureStatus>();
  const [enabled, setEnabled] = useState(false);
  const [limit, setLimit] = useState(6);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { const abort = new AbortController(); void api<ImageCaptureStatus>('/settings/images', { signal: abort.signal }).then(value => { setStatus(value); setEnabled(value.enabled); setLimit(value.maxImages); }).catch(e => { if (!abort.signal.aborted) setError(e.message); }); return () => abort.abort(); }, [root]);
  async function save() {
    if (!status || busy) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const value = await post<ImageCaptureStatus>('/settings/images', { settings: { enabled, maxImages: limit }, version: status.version, expectedRoot: root, expectedModel: status.currentModel, confirmed });
      setStatus(value); setEnabled(value.enabled); setLimit(value.maxImages); setConfirmed(false); setSaved(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const mismatch = status?.enabled && status.model !== status.currentModel;
  return <section className="kl-image-settings" aria-label="网页图片识别设置">
    <h3>正文图片识别</h3>
    <label className="kl-proxy-option"><input type="checkbox" checked={enabled} disabled={!status?.supported || busy} onChange={e => { setEnabled(e.target.checked); setConfirmed(false); setSaved(false); }} /><span>采集网页时自动识别正文图片</span></label>
    <p>开启后，后续网页的正文图片会自动发送给当前视觉模型，可能产生模型费用。原图与识别文字保存在本地，可搜索、引用和整理为知识笔记。</p>
    <p className="kl-image-model">当前模型：{status?.currentModel || '未配置'}{status?.model && <><br />已绑定模型：{status.model}</>}</p>
    {status?.reason && <p className="kl-muted">{status.reason}</p>}
    {mismatch && <p role="alert">模型已改变，原图片任务不会自动切换模型。请切回原模型，或确认新设置用于后续网页。</p>}
    <label className="kl-image-limit">每页最多识别图片数<input aria-label="每页最多识别图片数" type="number" min="1" max="10" value={limit} disabled={busy || !status?.supported} onChange={e => { setLimit(Number(e.target.value)); setConfirmed(false); setSaved(false); }} /></label>
    {enabled && <label className="kl-proxy-option"><input type="checkbox" checked={confirmed} disabled={busy || !status?.available} onChange={e => setConfirmed(e.target.checked)} /><span>确认使用 {status?.currentModel || '当前模型'}，每页最多 {limit} 张，允许后续采集自动发送图片并产生模型费用</span></label>}
    <button className="kl-secondary" disabled={busy || !status?.supported || !Number.isInteger(limit) || limit < 1 || limit > 10 || (enabled && (!status?.available || !confirmed))} onClick={() => void save()}>{busy ? '正在保存…' : '保存图片识别设置'}</button>
    {saved && <p role="status">已保存，对后续网页采集生效；已有资料可保留原样。</p>}
    {error && <p className="kl-form-error" role="alert">{error}</p>}
  </section>;
}

export function ImageCapturePolicy() {
  const [status, setStatus] = useState<ImageCaptureStatus>();
  useEffect(() => { const abort = new AbortController(); void api<ImageCaptureStatus>('/settings/images', { signal: abort.signal }).then(setStatus).catch(() => {}); return () => abort.abort(); }, []);
  return <div className="kl-image-policy">{!status ? '正在读取图片采集设置…' : status.enabled ? <>图片识别已开启：{status.model}，每页最多 {status.maxImages} 张。正文图片将发送给模型，可能产生费用。{(!status.available || status.model !== status.currentModel) && ' 当前模型不可用或与绑定模型不同，图片将保留为失败任务供核对。'}</> : '图片识别未开启。可在资料库设置中启用，自动保存原图并提取图中文字与图示含义。'}</div>;
}

const imageStates = { pending: '等待处理', downloading: '下载中', recognizing: '识别中', completed: '已识别', failed: '未完成', skipped: '已跳过' };
export const imagesPending = (detail: MaterialDetail) => detail.images?.some(image => ['pending', 'downloading', 'recognizing'].includes(image.status));
export function PageImages({ detail, onRetry, onJump }: { detail: MaterialDetail; onRetry: () => void; onJump: (id: string) => void }) {
  if (!detail.images?.length) return null;
  return <section className="kl-page-images" aria-label="正文图片"><div className="kl-image-heading"><h3>正文图片 · {detail.images.length}</h3>{!detail.deletedAt && !imagesPending(detail) && detail.images.some(image => image.status === 'failed' && image.attempts < 3) && <button className="kl-secondary" onClick={onRetry}>重试失败图片</button>}</div><p className="kl-muted">图片文字和图示解读已标注为模型输出，请结合原图核对。</p><div className="kl-image-grid">{detail.images.map((image, index) => <div className="kl-image-record" key={image.id}>
    {image.originalAvailable && <a href={`${API}/materials/${detail.id}/images/${image.id}`} target="_blank" rel="noreferrer" aria-label={`查看原图 ${index + 1}`}><img loading="lazy" src={`${API}/materials/${detail.id}/images/${image.id}`} alt={image.alt || `正文图片 ${index + 1}`} /></a>}
    <strong>图片 {index + 1} · {imageStates[image.status]}</strong><small>{image.model}</small>
    <a href={image.url} target="_blank" rel="noreferrer">来源图片</a>
    {image.error && <p>{image.error}</p>}{image.uncertainty && <p>待核实：{image.uncertainty}</p>}
    {image.segmentId && <button className="kl-secondary" onClick={() => onJump(image.segmentId!)}>查看识别文字</button>}
  </div>)}</div></section>;
}

export function ImageRetryDialog({ id, root, onClose, onStarted }: { id: string; root: string; onClose: () => void; onStarted: () => void }) {
  const [detail, setDetail] = useState<MaterialDetail>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const abort = new AbortController(); void api<MaterialDetail>(`/materials/${id}`, { signal: abort.signal }).then(setDetail).catch(e => { if (!abort.signal.aborted) setError(e.message); }); return () => abort.abort(); }, [id]);
  const eligible = detail?.images?.filter(image => image.status === 'failed' && image.attempts < 3) || [];
  async function retry() {
    if (!eligible.length || busy) return;
    setBusy(true); setError('');
    try { await post(`/materials/${id}/images/retry`, { expectedRoot: root, expectedModel: eligible[0].model, imageIds: eligible.map(image => image.id), confirmed: true }); onStarted(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <Dialog title="重试失败图片" description="将再次发送下列失败图片到原任务模型，可能产生费用。已成功图片不会重复识别。" onClose={() => { if (!busy) onClose(); }}><div className="kl-delete-dialog"><p>{detail ? `${detail.title} · ${eligible.length} 张可重试图片` : '正在核对图片…'}</p><p>模型：{eligible[0]?.model || '—'}。每张图片最多发起 3 次模型请求。</p><ul>{eligible.map(image => <li key={image.id}>{image.alt || image.url}（已请求 {image.attempts} 次）</li>)}</ul>{error && <p role="alert" className="kl-form-error">{error}</p>}<footer><button className="kl-secondary" disabled={busy} onClick={onClose}>取消</button><button className="kl-primary" disabled={busy || !eligible.length || !!detail && (!!detail.deletedAt || !!imagesPending(detail))} onClick={() => void retry()}>{busy ? '正在提交…' : `确认重试 ${eligible.length} 张图片`}</button></footer></div></Dialog>;
}
