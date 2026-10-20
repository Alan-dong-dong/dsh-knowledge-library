import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CaptureFields, ImportJob } from '../types.js';
import { atomicJson, Library } from './library.js';
import { fetchPublicPage, validateUrl } from './fetch.js';

export class ImportQueue {
  private jobs: ImportJob[];
  private file: string;
  private running = false;
  private stopped = false;
  private abort = new AbortController();
  private active?: Promise<void>;
  constructor(private library: Library, private fetchPage = fetchPublicPage) {
    this.file = join(library.root, '.system', 'jobs.json');
    this.jobs = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : [];
    if (!Array.isArray(this.jobs)) throw new Error('任务记录损坏，请备份并检查 .system/jobs.json');
    for (const job of this.jobs) if (job.status === 'running') {
      job.status = job.attempts >= 3 ? 'failed' : 'queued';
      job.error = '上次处理被中断，等待恢复';
    }
    this.persist();
    this.kick();
  }
  list() { return this.jobs.slice().reverse().slice(0, 100).map(({ fields: _fields, ...job }) => job); }
  add(url: string, fields: CaptureFields = {}): ImportJob {
    const normalized = validateUrl(url).href;
    const existing = this.jobs.find(j => j.url === normalized && ['queued', 'running'].includes(j.status));
    if (existing) return structuredClone(existing);
    if (this.jobs.filter(j => ['queued', 'running'].includes(j.status)).length >= 50) throw new Error('最多同时排队 50 个网页');
    const timestamp = new Date().toISOString();
    const job: ImportJob = { id: `job_${randomUUID()}`, url: normalized, fields, status: 'queued', createdAt: timestamp, updatedAt: timestamp, attempts: 0 };
    this.jobs.push(job); this.persist(); this.kick();
    return structuredClone(job);
  }
  retry(id: string) {
    const job = this.jobs.find(j => j.id === id);
    if (!job || job.status !== 'failed') throw new Error('只能重试失败的任务');
    job.status = 'queued'; job.error = undefined; job.attempts = 0;
    this.persist(); this.kick(); return structuredClone(job);
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
        try {
          const page = await this.fetchPage(job.url, this.abort.signal);
          if (this.stopped) break;
          const result = this.library.captureHtml(page.html, page.url, job.fields);
          job.materialId = result.material.id; job.status = 'completed'; job.error = undefined;
        } catch (error) {
          job.status = this.stopped ? 'queued' : 'failed';
          job.error = (error as Error).message;
        }
        job.updatedAt = new Date().toISOString(); this.persist();
      }
    }).finally(() => {
      for (const job of this.jobs) if (job.status === 'running') job.status = 'queued';
      this.persist(); this.running = false;
    });
  }
  async idle() { await this.active; }
  async close() { this.stopped = true; this.abort.abort(); await this.active; }
}
