import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureFields, Citation, ImportJob, MaterialDetail, MaterialKind, SearchResult, Segment } from '../types.js';
import { Icon } from './icons.js';
import type { DirectoryListing } from '../directory-settings.js';

const API = '/knowledge-library/api';
const kinds: Record<MaterialKind, { label: string; icon: string }> = {
  web: { label: '网页', icon: 'web' }, text: { label: '文本', icon: 'file' }, file: { label: '文件', icon: 'file' },
  video: { label: '音视频', icon: 'video' }, transcript: { label: '字幕', icon: 'video' }, note: { label: '笔记', icon: 'note' },
};
type Stats = { total: number; ready: number; notes: number; inbox: number; root: string; warnings: string[]; categories: Array<{ name: string; count: number }>; collections: Array<{ name: string; count: number }>; tags: Array<{ name: string; count: number }> };
type Filter = { category?: string; collection?: string; kind?: string; tag?: string };
type Editor = { mode: 'capture' | 'note' | 'edit'; source?: MaterialDetail; segment?: Segment; initialType?: 'text'; sourceUrl?: string };
const time = (v: number) => `${String(Math.floor(v / 3600)).padStart(2, '0')}:${String(Math.floor(v / 60) % 60).padStart(2, '0')}:${String(Math.floor(v) % 60).padStart(2, '0')}`;
const date = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(value));
async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(API + path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Knowledge-Library': '1', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
  return data as T;
}
const post = <T,>(path: string, value: unknown, method = 'POST', signal?: AbortSignal) => api<T>(path, { method, body: JSON.stringify(value), signal });
function splitTags(value: string) { return value.split(/[,，]/).map(v => v.trim()).filter(Boolean); }

export function App() {
  const [stats, setStats] = useState<Stats>();
  const [items, setItems] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>({});
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<MaterialDetail>();
  const [anchor, setAnchor] = useState<string>();
  const [editor, setEditor] = useState<Editor>();
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [showJobs, setShowJobs] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [settingsFromJobs, setSettingsFromJobs] = useState(false);
  const [showNavigation, setShowNavigation] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [limit, setLimit] = useState(40);
  const searchRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  const notify = (message: string) => setToast(message);
  const chooseFilter = (next: Filter) => { setFilter(next); setLimit(40); setSelected(undefined); setAnchor(undefined); setDetail(undefined); setShowNavigation(false); };
  const refreshMeta = useCallback(async () => {
    const [s, j] = await Promise.all([api<Stats>('/stats'), api<ImportJob[]>('/jobs')]);
    setStats(s); setJobs(j);
  }, []);
  useEffect(() => { void refreshMeta().catch(e => setError(e.message)); }, [revision, refreshMeta]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams({ query, limit: String(limit) });
      for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
      api<{ items: SearchResult[]; total: number }>(`/materials?${params}`, { signal: controller.signal })
        .then(result => { setItems(result.items); setTotal(result.total); })
        .catch(e => { if (e.name !== 'AbortError') setError(e.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query ? 180 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, filter, revision, limit]);
  useEffect(() => {
    if (!selected) { setDetail(undefined); return; }
    const controller = new AbortController();
    setDetailLoading(true); setDetail(undefined);
    api<MaterialDetail>(`/materials/${selected}`, { signal: controller.signal })
      .then(setDetail).catch(e => { if (e.name !== 'AbortError') setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [selected, revision]);
  useEffect(() => {
    if (!detail || !anchor) return;
    const element = Array.from(detailRef.current?.querySelectorAll<HTMLElement>('[data-segment-id]') || []).find(el => el.dataset.segmentId === anchor);
    element?.scrollIntoView({ block: 'center' });
  }, [detail, anchor]);
  const pending = jobs.filter(j => ['queued', 'running'].includes(j.status)).length;
  useEffect(() => {
    if (!pending) return;
    const interval = setInterval(refresh, 2500);
    return () => clearInterval(interval);
  }, [pending, refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') { event.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); notify('引用已复制'); }
    catch { setError('剪贴板不可用，请从资料详情手动复制资料 ID'); }
  }
  const currentTitle = filter.category || filter.collection || (filter.tag ? `标签 · ${filter.tag}` : filter.kind === 'note' ? '知识笔记' : '全部资料');
  return <div className="kl-app">
    <main className="kl-workspace">
      <header className="kl-header"><h1>{currentTitle}</h1><div className="kl-header-actions"><button className="kl-secondary" onClick={() => setEditor({ mode: 'note' })}><Icon name="note" size={16} />写笔记</button><button className="kl-primary" onClick={() => setEditor({ mode: 'capture' })}><Icon name="plus" size={16} />收集资料</button></div></header>
      <div className="kl-navigation">
        <nav aria-label="资料导航">
          <button aria-pressed={!Object.values(filter).some(Boolean)} onClick={() => chooseFilter({})}>全部资料</button>
          <button aria-pressed={filter.category === '收件箱'} onClick={() => chooseFilter({ category: '收件箱' })}>收件箱</button>
          <button aria-pressed={filter.kind === 'note'} onClick={() => chooseFilter({ kind: 'note' })}>知识笔记</button>
        </nav>
        <button className="kl-directory-toggle" aria-expanded={showNavigation} aria-controls="kl-directory" onClick={() => setShowNavigation(v => !v)}><Icon name="folder" size={16} />分类与专题</button>
      </div>
      <div className="kl-toolbar"><label className="kl-search"><Icon name="search" size={19} /><input ref={searchRef} aria-label="搜索资料" placeholder="搜索正文、标题、标签…" value={query} onChange={e => { setQuery(e.target.value); setLimit(40); }} /><kbd>Ctrl K</kbd></label>
        <button aria-label={pending ? `采集任务，${pending} 项处理中` : '采集任务'} className={`kl-job-button ${pending ? 'has-jobs' : ''}`} onClick={() => setShowJobs(true)}><Icon name="clock" size={17} /><span>{pending ? `${pending} 项处理中` : '采集任务'}</span>{jobs.some(j => j.status === 'failed') && <i />}</button>
        <button className="kl-icon-button" aria-label="资料库设置" title="资料库设置" onClick={() => { setSettingsFromJobs(false); setShowInfo(true); }}><Icon name="settings" size={18} /></button>
      </div>
      {!!error && <div className="kl-error" role="alert"><span>{error}</span><button aria-label="关闭错误" onClick={() => setError('')}><Icon name="close" size={16} /></button></div>}
      <div className="kl-filterbar"><span><b>{total}</b> 份资料{query && ` · “${query}”`}</span><div><select aria-label="按类型筛选" value={filter.kind || ''} onChange={e => { setFilter({ ...filter, kind: e.target.value || undefined }); setLimit(40); }}><option value="">所有类型</option>{Object.entries(kinds).map(([value, kind]) => <option key={value} value={value}>{kind.label}</option>)}</select><span className="kl-sort-label">最近更新 ↓</span></div></div>
      <div className={`kl-body ${detail || detailLoading ? 'with-detail' : ''}`}>
        {showNavigation && <aside className="kl-nav" id="kl-directory" aria-label="分类与专题">
          <div className="kl-directory-title"><span>分类与专题</span><button className="kl-icon-button" aria-label="关闭分类导航" onClick={() => setShowNavigation(false)}><Icon name="close" size={16} /></button></div>
          <div className="kl-nav-section"><div className="kl-nav-label">分类</div>
            {stats?.categories.filter(c => c.name !== '收件箱').map(c => <button key={c.name} aria-pressed={filter.category === c.name} className="kl-nav-row" onClick={() => chooseFilter({ category: c.name })}><Icon name="folder" size={16} /><span title={c.name}>{c.name}</span><small>{c.count}</small></button>)}
            {!stats?.categories.some(c => c.name !== '收件箱') && <p className="kl-nav-hint">收集资料时添加分类</p>}
          </div>
          <div className="kl-nav-section"><div className="kl-nav-label">专题</div>
            {stats?.collections.map(c => <button key={c.name} aria-pressed={filter.collection === c.name} className="kl-nav-row" onClick={() => chooseFilter({ collection: c.name })}><span className="kl-collection-dot" /><span title={c.name}>{c.name}</span><small>{c.count}</small></button>)}
            {!stats?.collections.length && <p className="kl-nav-hint">收集资料时添加专题</p>}
          </div>
          {!!stats?.tags.length && <div className="kl-nav-section"><div className="kl-nav-label">标签</div><div className="kl-tag-cloud">{stats.tags.slice(0, 15).map(tag => <button aria-pressed={filter.tag === tag.name} key={tag.name} onClick={() => chooseFilter({ tag: tag.name })}>#{tag.name}</button>)}</div></div>}
          <div className="kl-nav-bottom"><span className="kl-live-dot" />保存在这台电脑</div>
        </aside>}
        <section className="kl-list" aria-label="资料列表" aria-busy={loading}>
          {loading && !items.length ? <div className="kl-empty"><span className="kl-spinner" />正在读取资料库…</div> : !items.length ? <div className="kl-empty">
            <Icon name="inbox" size={28} /><h2>{query || Object.values(filter).some(Boolean) ? '没有找到匹配的资料' : '还没有资料，收集的内容会显示在这里'}</h2>
            {query && <p>试试其他关键词，或切换分类。</p>}<button className="kl-secondary" onClick={() => query || Object.values(filter).some(Boolean) ? (setQuery(''), chooseFilter({})) : setEditor({ mode: 'capture' })}>{query || Object.values(filter).some(Boolean) ? '查看全部资料' : '收集第一份资料'}</button>
          </div> : items.map(item => <button className={`kl-item ${selected === item.id ? 'selected' : ''}`} key={item.id} onClick={() => { setAnchor(undefined); setSelected(item.id); }}>
            <div className="kl-item-top"><span className={`kl-type kl-type-${item.kind}`}><Icon name={kinds[item.kind].icon} size={15} />{kinds[item.kind].label}</span><time>{date(item.createdAt)}</time></div>
            <h2>{item.title}</h2><p>{item.excerpt || item.extraction}</p>
            <div className="kl-item-bottom"><span className="kl-category"><Icon name="folder" size={13} />{item.category}</span>{item.tags.slice(0, 2).map(tag => <span className="kl-chip" key={tag}>{tag}</span>)}{item.status === 'stored' && <span className="kl-stored">仅归档</span>}<Icon name="arrow" size={15} /></div>
          </button>)}
          {items.length < total && <button className="kl-load-more" onClick={() => setLimit(v => Math.min(100, v + 40))} disabled={limit >= 100}>{limit >= 100 ? '请缩小搜索范围（最多显示 100 条）' : '加载更多'}</button>}
        </section>
        {selected && <section className="kl-detail" aria-label="资料详情" ref={detailRef}>
          <div className="kl-detail-toolbar"><button className="kl-back" onClick={() => { setSelected(undefined); setDetail(undefined); }}><Icon name="close" size={18} /><span>关闭阅读</span></button>{detail && <div><button title="复制资料引用" aria-label="复制资料引用" onClick={() => void copy(`library://${detail.id}`)}><Icon name="copy" size={17} /></button><a title="导出 Markdown" aria-label="导出 Markdown" href={`${API}/materials/${detail.id}/export`}><Icon name="download" size={17} /></a><button onClick={() => setEditor({ mode: 'edit', source: detail })}>编辑信息</button></div>}</div>
          {detailLoading ? <div className="kl-empty"><span className="kl-spinner" />读取中…</div> : detail && <article>
            <div className="kl-detail-kicker"><span>{kinds[detail.kind].label}</span><span>{detail.category}</span></div><h2>{detail.title}</h2>
            <div className="kl-source">{detail.sourceUrl ? <a href={detail.sourceUrl} target="_blank" rel="noreferrer">{new URL(detail.sourceUrl).hostname}<Icon name="arrow" size={12} /></a> : <span>{detail.originalName || '本地收集'}</span>}<span>{new Date(detail.createdAt).toLocaleDateString('zh-CN')}</span>{detail.author && <span>{detail.author}</span>}</div>
            {!!detail.tags.length && <div className="kl-detail-tags">{detail.tags.map(t => <span className="kl-chip" key={t}>#{t}</span>)}</div>}
            {detail.sourceNote && <aside className="kl-source-note">{detail.sourceNote}</aside>}
            {detail.status === 'stored' && <div className="kl-notice"><Icon name="file" /><div><strong>原文件已安全归档</strong><p>{detail.extraction}</p></div></div>}
            <div className="kl-content">{detail.segments.map(segment => <div className={`kl-segment ${anchor === segment.id ? 'kl-cited' : ''}`} key={segment.id} id={segment.id} data-segment-id={segment.id}>
              <div className="kl-segment-line"><span>{segment.startSeconds !== undefined ? time(segment.startSeconds) : segment.id}</span><button title="摘录为笔记" aria-label={`摘录 ${segment.id} 为笔记`} onClick={() => setEditor({ mode: 'note', source: detail, segment })}><Icon name="note" size={14} /></button><button title="复制段落引用" aria-label={`复制 ${segment.id} 引用`} onClick={() => void copy(`library://${detail.id}/${segment.id}`)}><Icon name="copy" size={14} /></button></div>
              {/^#{1,6}\s/.test(segment.text) ? <h3>{segment.text.replace(/^#{1,6}\s+/, '')}</h3> : <p>{segment.text}</p>}
            </div>)}</div>
            {!!detail.citations.length && <div className="kl-references"><h3>来源引用</h3>{detail.citations.map((c, i) => <button key={i} aria-label={`查看引用 ${i + 1}`} onClick={() => { setAnchor(c.segmentId); setSelected(c.materialId); }}><Icon name="file" size={15} /><span>{c.materialId.slice(0, 15)}…{c.segmentId ? ` / ${c.segmentId}` : ''}</span><Icon name="arrow" size={14} /></button>)}</div>}
            <footer className="kl-detail-footer"><div><span className="kl-live-dot" />{detail.extraction}</div>{detail.originalFile && <a href={`${API}/materials/${detail.id}/original`}>下载原始文件<Icon name="download" size={14} /></a>}<code>{detail.id}</code></footer>
          </article>}
        </section>}
      </div>
    </main>
    {editor && <EditorDialog editor={editor} categories={stats?.categories.map(c => c.name) || []} onClose={() => setEditor(undefined)} onSaved={result => {
      setEditor(undefined); refresh();
      if (result.material) { chooseFilter({}); setQuery(''); setSelected(result.material.id); notify(result.duplicate ? '资料已存在，已打开原记录' : '已保存到本地资料库'); }
      else if (result.id) { setSelected(result.id); notify('资料信息已更新'); }
      else { setShowJobs(true); notify('网页已加入采集队列'); }
    }} />}
    {showJobs && <Dialog title="采集任务" description="网页在后台提取正文。关闭应用后，下次启动会恢复未完成任务。" onClose={() => setShowJobs(false)}>
      <div className="kl-jobs">{!jobs.length ? <p className="kl-muted">还没有采集任务。添加一个网页链接开始。</p> : jobs.map(job => <div className="kl-job" key={job.id}>
        <div><span className={`kl-job-status ${job.status}`}>{job.status === 'failed' && job.errorCode === 'PAGE_REQUIRES_BROWSER' ? '需浏览器验证' : ({ queued: '排队中', running: '提取中', completed: '已完成', failed: '失败' })[job.status]}</span><time>{date(job.createdAt)}</time></div>
        <strong>{job.url}</strong>{job.error && <p role={job.status === 'failed' ? 'alert' : undefined}>{job.error}</p>}
        <div className="kl-job-actions">
          {job.materialId && <button onClick={() => { setSelected(job.materialId); setShowJobs(false); refresh(); }}>查看资料 <Icon name="arrow" size={14} /></button>}
          {job.status === 'failed' && <>
            {/^https?:\/\//i.test(job.url) && <a href={job.url} target="_blank" rel="noopener noreferrer">打开原网页<Icon name="arrow" size={14} /></a>}
            <button onClick={() => { setShowJobs(false); setEditor({ mode: 'capture', initialType: 'text', sourceUrl: job.url }); }}>粘贴正文</button>
            {/fake-ip/i.test(job.error || '') && <button onClick={() => { setShowJobs(false); setSettingsFromJobs(true); setShowInfo(true); }}>代理兼容设置</button>}
            <button onClick={() => void post(`/jobs/${job.id}/retry`, {}).then(refresh).catch(e => setError(e.message))}>重新采集</button>
          </>}
        </div>
      </div>)}</div>
    </Dialog>}
    {showInfo && <SettingsDialog root={stats?.root || ''} warnings={stats?.warnings || []} onClose={() => { setShowInfo(false); if (settingsFromJobs) setShowJobs(true); setSettingsFromJobs(false); }} onChanged={() => {
      setSelected(undefined); setDetail(undefined); setAnchor(undefined); setItems([]); setQuery(''); chooseFilter({}); refresh(); notify('资料库目录已切换');
    }} onRebuilt={() => { refresh(); notify('索引已重建'); }} onProxySaved={enabled => { refresh(); notify(enabled ? '代理兼容已开启，可重新采集失败任务' : '代理兼容已关闭'); if (settingsFromJobs) { setShowInfo(false); setShowJobs(true); setSettingsFromJobs(false); } }} />}
    {toast && <div className="kl-toast" role="status"><Icon name="check" size={17} />{toast}</div>}
  </div>;
}

function SettingsDialog({ root, warnings, onClose, onChanged, onRebuilt, onProxySaved }: { root: string; warnings: string[]; onClose: () => void; onChanged: () => void; onRebuilt: () => void; onProxySaved: (enabled: boolean) => void }) {
  const [settings, setSettings] = useState<{ canChange: boolean; canChangeNetwork: boolean; picker: 'native' | 'browse' | null; allowProxyFakeIp: boolean }>();
  const [proxyMode, setProxyMode] = useState(false);
  const [target, setTarget] = useState(root);
  const [listing, setListing] = useState<DirectoryListing>();
  const [browsePath, setBrowsePath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController>();
  useEffect(() => { const abort = new AbortController(); void api('/settings', { signal: abort.signal }).then(data => { setSettings(data); setProxyMode(data.allowProxyFakeIp === true); }).catch(e => { if (!abort.signal.aborted) setError(e.message); }); return () => { abort.abort(); request.current?.abort(); }; }, []);
  useEffect(() => { setTarget(root); }, [root]);
  async function browse(path?: string) {
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setBusy(true); setError(''); setListing(undefined);
    try { const result = await post<DirectoryListing>('/directory/list', { path }, 'POST', abort.signal); setListing(result); setBrowsePath(result.path); }
    catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  async function pick() {
    if (settings?.picker === 'browse') { setBrowsing(true); setListing(undefined); setBrowsePath(target); await browse(target || undefined); return; }
    setBusy(true); setError(''); const abort = new AbortController(); request.current = abort;
    try { const result = await post<{ path: string | null }>('/directory/pick', {}, 'POST', abort.signal); if (result.path) setTarget(result.path); }
    catch (e) { if (!abort.signal.aborted) setError((e as Error).message); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  async function change() {
    setSaving(true); setError('');
    try { const result = await post<{ root: string }>('/settings/root', { root: target.trim(), expectedRoot: root }); setTarget(result.root); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  async function saveProxyMode() {
    if (!settings) return;
    setSaving(true); setError('');
    try {
      const result = await post<{ allowProxyFakeIp: boolean }>('/settings/network', { allowProxyFakeIp: proxyMode, expected: settings.allowProxyFakeIp, expectedRoot: root });
      setSettings({ ...settings, allowProxyFakeIp: result.allowProxyFakeIp }); setProxyMode(result.allowProxyFakeIp); onProxySaved(result.allowProxyFakeIp);
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  const changed = target.trim() && target.trim() !== root;
  return <Dialog title="你的资料，由你保管" description="内容以普通文件保存，索引可以重建。" onClose={() => { if (!saving) onClose(); }}>
    <div className="kl-info">
      {browsing ? <div className="kl-folder-browser" aria-label="选择资料库目录">
        <div className="kl-folder-heading"><strong>选择资料库目录</strong><button className="kl-secondary" disabled={busy} onClick={() => void browse()}>主目录</button></div>
        <form className="kl-folder-path" onSubmit={e => { e.preventDefault(); void browse(browsePath); }}><input aria-label="浏览目录路径" value={browsePath} onChange={e => setBrowsePath(e.target.value)} /><button className="kl-secondary" disabled={busy || !browsePath.trim()}>前往</button></form>
        <nav className="kl-folder-crumbs" aria-label="目录层级">{listing?.crumbs.map(c => <button key={c.path} disabled={busy} onClick={() => void browse(c.path)}>{c.name}<span>/</span></button>)}</nav>
        <div className="kl-folder-entries" aria-busy={busy}>{busy ? <p className="kl-muted">正在读取目录…</p> : listing && !listing.entries.length ? <p className="kl-muted">此目录没有子文件夹</p> : listing?.entries.map(entry => <button key={entry.path} onClick={() => void browse(entry.path)}><Icon name="folder" size={17} /><span>{entry.name}</span><Icon name="arrow" size={15} /></button>)}</div>
        {listing?.truncated && <p className="kl-muted">子目录较多，仅显示部分。可填写完整路径前往。</p>}
        <div className="kl-folder-actions"><button className="kl-secondary" onClick={() => { request.current?.abort(); setBusy(false); setBrowsing(false); setError(''); }}>取消选择</button><button className="kl-primary" disabled={busy || !listing} onClick={() => { setTarget(listing!.path); setBrowsing(false); setError(''); }}>选择此目录</button></div>
      </div> : <>
        <label htmlFor="kl-library-root">资料库目录</label>
        <div className="kl-root-field"><input id="kl-library-root" value={target} title={target} spellCheck={false} readOnly={!settings?.canChange} disabled={saving || busy} onChange={e => setTarget(e.target.value)} /><button className="kl-secondary" disabled={!settings?.canChange || !settings.picker || busy || saving} onClick={() => void pick()}><Icon name="folder" size={16} />{busy ? '选择中…' : '选择目录'}</button></div>
        {settings && !settings.canChange && <p className="kl-muted">请在 Harness 中选择和切换目录；独立预览可通过启动配置指定目录。</p>}
        {!!changed && <div className="kl-root-confirm"><p>切换后将读取新目录，并将后续资料保存到那里。原目录的资料会保留，不会自动搬迁。</p><div><button className="kl-secondary" disabled={saving || busy} onClick={() => { setTarget(root); setError(''); }}>取消修改</button><button className="kl-primary" disabled={saving || busy} onClick={() => void change()}>{saving ? '正在切换…' : '切换资料库'}</button></div></div>}
        <section className="kl-network-settings" aria-label="网页采集设置"><h3>网页采集</h3><label className="kl-proxy-option"><input type="checkbox" aria-describedby="kl-proxy-help" checked={proxyMode} disabled={!settings?.canChangeNetwork || saving || busy} onChange={e => { setProxyMode(e.target.checked); setError(''); }} /><span>Clash/Mihomo 代理兼容（fake-IP）</span></label><p id="kl-proxy-help">本机使用 Clash/Mihomo TUN 的 fake-IP DNS 时开启，允许通过代理采集解析到 198.18.* 或 198.19.* 的网站。本机及其他内网地址仍不允许访问。</p>{settings?.canChangeNetwork && !settings.canChange && <p className="kl-muted">此设置用于当前资料库的独立预览，保存后对后续采集生效。</p>}{settings && !settings.canChangeNetwork && <p className="kl-muted">当前环境无法保存采集设置。</p>}{settings?.canChangeNetwork && proxyMode !== settings.allowProxyFakeIp && <button className="kl-secondary" disabled={saving || busy} onClick={() => void saveProxyMode()}>{saving ? '正在保存…' : '保存采集设置'}</button>}</section>
        <p>每份资料保留原始文件、正文、元数据和引用段落。分类对应本地文件夹，插件卸载不会删除这些文件。</p><p>本版本可提取文章正文及字幕；音视频、PDF 等格式可以归档，自动转写和 OCR 尚未接入。</p>
        {warnings.map(w => <p role="alert" key={w}>{w}</p>)}
        <button className="kl-secondary" disabled={busy || saving} onClick={() => { setSaving(true); setError(''); void post('/rebuild', {}).then(onRebuilt).catch(e => setError(e.message)).finally(() => setSaving(false)); }}>从资料文件重建索引</button>
      </>}
      {error && <p className="kl-settings-error" role="alert">{error}</p>}
    </div>
  </Dialog>;
}

function Dialog({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => ref.current?.querySelector<HTMLElement>('input,textarea,button')?.focus(), 0);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select,a[href]') || []);
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="kl-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className="kl-dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}><header><div><h2>{title}</h2><p>{description}</p></div><button aria-label="关闭弹窗" onClick={onClose}><Icon name="close" /></button></header>{children}</div></div>;
}

function EditorDialog({ editor, categories, onClose, onSaved }: { editor: Editor; categories: string[]; onClose: () => void; onSaved: (result: any) => void }) {
  const editing = editor.mode === 'edit';
  const note = editor.mode === 'note';
  const source = editor.source;
  const [type, setType] = useState<'text' | 'url' | 'file'>(editor.initialType || 'url');
  const [sourceUrl, setSourceUrl] = useState(editor.sourceUrl || '');
  const [title, setTitle] = useState(editing ? source?.title || '' : note && source ? `${source.title} · 摘录` : '');
  const [content, setContent] = useState(editor.segment ? `> ${editor.segment.text}\n\n` : '');
  const [category, setCategory] = useState(editing ? source?.category || '收件箱' : note ? '知识笔记' : '收件箱');
  const [tags, setTags] = useState(editing ? source?.tags.join('，') || '' : '');
  const [collection, setCollection] = useState(source?.collection || '');
  const [sourceNote, setSourceNote] = useState(editing ? source?.sourceNote || '' : '');
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const citations: Citation[] = source && note ? [{ materialId: source.id, ...(editor.segment ? { segmentId: editor.segment.id } : {}) }] : [];
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const data: CaptureFields = { title, category, tags: splitTags(tags), collection, sourceNote };
      if (!editing && !note && type === 'text' && sourceUrl.trim()) data.sourceUrl = sourceUrl.trim();
      let result;
      if (editing) result = await post(`/materials/${source!.id}`, data, 'PATCH');
      else if (note) result = await post('/notes', { ...data, content, citations });
      else if (type === 'file') {
        if (!file) throw new Error('请选择一个文件');
        if (file.size > 64 * 1024 * 1024) throw new Error('文件超过 64 MB，请先拆分或导入字幕');
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(new Error('无法读取文件'));
          reader.readAsDataURL(file);
        });
        result = await post('/upload', { ...data, name: file.name, base64 });
      } else result = await post('/capture', { ...data, type, content });
      onSaved(result);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const changeType = (value: typeof type) => { setType(value); setContent(''); setError(''); };
  return <Dialog title={editing ? '整理资料' : note ? '写一份知识笔记' : '收集一份资料'} description={editing ? '分类会同步到本地文件夹，原文和引用保持不变。' : note ? '写下理解，也留下它的来源。' : '先收集，再慢慢整理。所有内容保存在你的电脑。'} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={submit} className="kl-editor">
      {!editing && !note && <div className="kl-tabs" role="tablist" aria-label="采集方式">{(['url', 'text', 'file'] as const).map(value => <button type="button" role="tab" aria-selected={type === value} className={type === value ? 'active' : ''} key={value} onClick={() => changeType(value)}><Icon name={value === 'url' ? 'web' : value === 'file' ? 'upload' : 'file'} size={17} />{value === 'url' ? '网页链接' : value === 'file' ? '本地文件' : '文本摘录'}</button>)}</div>}
      {!editing && !note && type === 'url' && <label>网页地址<input type="url" required placeholder="https://…" value={content} onChange={e => setContent(e.target.value)} /><small>支持可直接访问的文章网页。登录页或动态页面可复制正文导入。</small></label>}
      {!editing && !note && type === 'file' && <label className="kl-upload"><Icon name="upload" size={27} /><strong>{file?.name || '选择或拖入文件'}</strong><span>文本、HTML、SRT / VTT 字幕及其他文件 · 最大 64 MB</span><input aria-label="选择本地文件" type="file" onChange={e => setFile(e.target.files?.[0])} /><small>视频和 PDF 可归档，当前版本不会自动转写或 OCR。</small></label>}
      <label>标题{!editing && !note && <em>可选</em>}<input required={editing || note} value={title} onChange={e => setTitle(e.target.value)} placeholder={type === 'url' && !note ? '自动提取网页标题，也可以自己填写' : '给这份内容起个名字'} maxLength={300} /></label>
      {!editing && (note || type === 'text') && <label>{note ? '笔记内容' : '正文'}<textarea required rows={7} value={content} onChange={e => setContent(e.target.value)} placeholder={note ? '记录你的理解、结论与尚待验证的问题…' : '粘贴想保留的文字，支持 Markdown…'} /></label>}
      {!editing && !note && type === 'text' && <label>来源网页<em>可选</em><input type="url" aria-label="来源网页" placeholder="https://…" value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} /><small>保留原网页地址，方便回溯来源。</small></label>}
      {!!citations.length && <div className="kl-citation-preview"><Icon name="file" size={16} /><span>引用：{source!.title}{editor.segment ? ` / ${editor.segment.id}` : ''}</span></div>}
      <div className="kl-form-grid"><label>分类<input list="kl-categories" value={category} onChange={e => setCategory(e.target.value)} placeholder="例如 技术/AI" /><datalist id="kl-categories">{categories.map(c => <option value={c} key={c} />)}</datalist></label><label>专题<em>可选</em><input value={collection} onChange={e => setCollection(e.target.value)} placeholder="围绕一个问题组织资料" /></label></div>
      <label>标签<em>可选</em><input value={tags} onChange={e => setTags(e.target.value)} placeholder="用逗号分隔，例如：待读，RAG，实践" /></label>
      <label>来源备注<em>可选</em><input value={sourceNote} onChange={e => setSourceNote(e.target.value)} placeholder="为什么值得保存，或者它来自哪里" /></label>
      {error && <div className="kl-form-error" role="alert">{error}</div>}
      <footer><span><span className="kl-live-dot" />仅保存在本地</span><button type="button" className="kl-secondary" disabled={busy} onClick={onClose}>取消</button><button className="kl-primary" type="submit" disabled={busy}>{busy ? '保存中…' : editing ? '保存修改' : note ? '保存笔记' : type === 'url' ? '开始采集' : '保存资料'}{!busy && <Icon name="arrow" size={16} />}</button></footer>
    </form>
  </Dialog>;
}
