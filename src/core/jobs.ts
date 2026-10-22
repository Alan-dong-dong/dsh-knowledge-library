import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CaptureFields, ImportJob } from '../types.js';
import { atomicJson, Library } from './library.js';
import { fetchPublicPage, validateUrl } from './fetch.js';
import { PageAccessError } from './page-access.js';
import type { ImageCapture } from './image-capture.js';

export class ImportQueue {
  private jobs: ImportJob[];
  private file: string;
  private running = false;
  private stopped = false;
  private abort = new AbortController();
  private active?: Promise<void>;
  private imageAbort?: AbortController;
  private activeJob?: string;
  private retrying = new Set<string>();
  constructor(private library: Library, private fetchPage = fetchPublicPage, readonly imageCapture?: ImageCapture) {
    this.file = join(library.root, '.system', 'jobs.json');
    this.jobs = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : [];
    if (!Array.isArray(this.jobs)) throw new Error('任务记录损坏，请备份并检查 .system/jobs.json');
    for (const job of this.jobs) {
      let unfinishedImages = false;
      if (job.materialId && job.imageCapture && library.has(job.materialId) && imageCapture) {
        // Recover even if a storage error completed the outer job before the image
        // state could be written, or the process stopped immediately after body save.
        if (!library.pageImages(job.materialId) && ['queued','running'].includes(job.status)) {
          const page = library.get(job.materialId);
          imageCapture.initialize(job.materialId, library.original(job.materialId).bytes.toString('utf8'), page.sourceUrl || job.url, job.imageCapture);
        }
        unfinishedImages = !!library.pageImages(job.materialId)?.records.some(image => ['pending','downloading','recognizing'].includes(image.status));
      }
      if (job.materialId && job.imageCapture && (['queued','running'].includes(job.status) || unfinishedImages)) {
        if (library.has(job.materialId)) { imageCapture?.interrupt(job.materialId); job.imageSummary = imageCapture?.summary(job.materialId); }
        job.status = 'completed'; job.progress = '正文已保存，图片处理被中断'; job.error = '图片需主动重试，未自动重复模型请求';
      } else if (job.status === 'running') { job.status = job.attempts >= 3 ? 'failed' : 'queued'; job.error = '上次处理被中断，等待恢复'; }
    }
    this.persist();
    this.kick();
  }
  list() { return this.jobs.slice().reverse().slice(0, 100).map(({ fields: _fields, ...job }) => job); }
  add(url: string, fields: CaptureFields = {}): ImportJob {
    if (this.stopped) throw new Error('网页采集服务已关闭');
    const normalized = validateUrl(url).href;
    const existing = this.jobs.find(j => j.url === normalized && ['queued', 'running'].includes(j.status));
    if (existing) return structuredClone(existing);
    if (this.jobs.filter(j => ['queued', 'running'].includes(j.status)).length >= 50) throw new Error('最多同时排队 50 个网页');
    const timestamp = new Date().toISOString();
    const job: ImportJob = { id: `job_${randomUUID()}`, url: normalized, fields, status: 'queued', createdAt: timestamp, updatedAt: timestamp, attempts: 0, imageCapture: this.imageCapture?.options() };
    this.jobs.push(job); this.persist(); this.kick();
    return structuredClone(job);
  }
  retry(id: string) {
    const job = this.jobs.find(j => j.id === id);
    if (!job || job.status !== 'failed') throw new Error('只能重试失败的任务');
    job.status = 'queued'; job.error = undefined; job.errorCode = undefined; job.attempts = 0;
    this.persist(); this.kick(); return structuredClone(job);
  }
  async retryImages(id: string, expectedModel: unknown, expectedIds: unknown) {
    const job = this.jobs.find(j => j.id === id);
    if (!job?.materialId || !job.imageCapture || !this.imageCapture || job.status !== 'completed' || this.retrying.has(id)) throw new Error('图片任务尚未结束或正在重试');
    this.retrying.add(id);
    try {
      const data = this.library.pageImages(job.materialId);
      const eligible = data?.records.filter(image => image.status === 'failed' && image.attempts < 3).map(image => image.id).sort();
      if (!Array.isArray(expectedIds) || JSON.stringify([...expectedIds].sort()) !== JSON.stringify(eligible)) throw new Error('失败图片已改变，请重新确认重试范围');
      await this.imageCapture.prepareRetry(job.materialId, expectedModel);
      job.status = 'queued'; job.progress = '等待重试失败图片'; delete job.error; this.persist(); this.kick(); return structuredClone(job);
    } finally { this.retrying.delete(id); }
  }
  retryImagesForMaterial(materialId: string, expectedModel: unknown, expectedIds: unknown) {
    const job = this.jobs.slice().reverse().find(job => job.materialId === materialId && job.imageCapture);
    if (!job) throw new Error('未找到该网页的图片任务');
    return this.retryImages(job.id, expectedModel, expectedIds);
  }
  cancelImages(id: string) {
    const job = this.jobs.find(j => j.id === id);
    if (!job?.materialId || !job.imageCapture || !['queued','running'].includes(job.status)) throw new Error('当前没有可停止的图片处理');
    if (this.activeJob === id) this.imageAbort?.abort();
    else { this.imageCapture?.interrupt(job.materialId); job.imageSummary = this.imageCapture?.summary(job.materialId); job.status = 'completed'; }
    job.progress = '正文已保存，图片处理已停止'; this.persist(); return structuredClone(job);
  }
  private persist() { atomicJson(this.file, this.jobs); }
  private kick() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.active = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      while (!this.stopped) {
        const job = this.jobs.find(j => j.status === 'queued');
        if (!job) break;
        job.status = 'running'; job.attempts++; job.updatedAt = new Date().toISOString(); this.persist();
        this.activeJob = job.id;
        try {
          if (!job.materialId) {
            const page = await this.fetchPage(job.url, this.abort.signal);
            if (this.stopped) break;
            const result = this.library.captureHtml(page.html, page.url, job.fields);
            job.materialId = result.material.id; job.progress = '网页正文已保存'; this.persist();
            if (job.imageCapture && this.imageCapture) this.imageCapture.initialize(job.materialId, page.html, page.url, job.imageCapture);
          }
          if (job.imageCapture && this.imageCapture) {
            this.imageAbort = new AbortController();
            await this.imageCapture.run(job.materialId, AbortSignal.any([this.abort.signal, this.imageAbort.signal]), message => { job.progress = message; job.imageSummary = this.imageCapture!.summary(job.materialId!); this.persist(); });
            job.imageSummary = this.imageCapture.summary(job.materialId);
          }
          job.status = 'completed'; job.error = job.imageSummary?.failed ? `${job.imageSummary.failed} 张图片未完成，可核对后重试；正文已保留` : undefined; job.errorCode = undefined;
          job.progress = this.imageAbort?.signal.aborted || this.abort.signal.aborted ? '正文已保存，图片处理已停止' : job.imageCapture ? '采集已完成，正文与已识别图片文字保存在本地' : '网页正文已保存';
        } catch (error) {
          job.status = job.materialId ? 'completed' : this.stopped ? 'queued' : 'failed';
          job.error = (error as Error).message;
          job.errorCode = error instanceof PageAccessError ? error.code : undefined;
        }
        job.updatedAt = new Date().toISOString(); this.persist(); this.imageAbort = undefined; this.activeJob = undefined;
      }
    }).finally(() => {
      for (const job of this.jobs) if (job.status === 'running') job.status = 'queued';
      this.persist(); this.running = false;
    });
  }
  async idle() { await this.active; }
  async close() { this.stopped = true; this.imageCapture?.close(); this.abort.abort(); await this.active; }
}
