import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const validId = (id: unknown): id is string => typeof id === 'string' && /^r_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export interface PurgeTicket { id: string; source: string; staged: string; manifest: string }

/** Durable, confirmed cleanup work. Only owned material directories are removable. */
export class PurgeStore {
  readonly directory: string;
  constructor(private root: string) { this.directory = join(root, '.system', 'purge'); }
  private contained(path: string): void {
    const rel = relative(this.root, resolve(path));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('清理路径超出资料库');
    let current = this.root;
    if (lstatSync(current).isSymbolicLink()) throw new Error('清理不支持符号链接');
    for (const part of rel.split(sep)) {
      current = join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) throw new Error('清理不支持符号链接'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private tree(path: string): void {
    this.contained(path);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error('清理不支持符号链接');
    if (info.isDirectory()) for (const entry of readdirSync(path)) this.tree(join(path, entry));
  }
  private ticket(id: string, source: string): PurgeTicket {
    if (!validId(id)) throw new Error('清理资料 ID 无效');
    source = resolve(source);
    const rel = relative(join(this.root, 'materials'), source);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || basename(source) !== id) throw new Error('清理目标不是资料目录');
    const ticket = { id, source, staged: join(this.directory, id), manifest: join(this.directory, `${id}.json`) };
    for (const path of [ticket.source, ticket.staged, ticket.manifest]) this.contained(path);
    return ticket;
  }
  validate(id: string, source: string): void { this.tree(this.ticket(id, source).source); }
  list(): PurgeTicket[] {
    this.contained(this.directory);
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter(name => name.endsWith('.json')).sort().map(name => {
      const manifest = join(this.directory, name); this.contained(manifest);
      const data = JSON.parse(readFileSync(manifest, 'utf8'));
      if (data.schemaVersion !== 1 || !validId(data.id) || name !== `${data.id}.json` || typeof data.source !== 'string' || isAbsolute(data.source)) throw new Error('待清理记录损坏');
      return this.ticket(data.id, resolve(this.root, data.source));
    });
  }
  stage(id: string, source: string): PurgeTicket {
    const ticket = this.ticket(id, source); this.tree(ticket.source);
    if (existsSync(ticket.staged)) throw new Error('该资料仍有待完成的文件清理');
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(ticket.manifest, JSON.stringify({ schemaVersion: 1, id, source: relative(this.root, source) }), { flag: 'wx' });
    try { renameSync(ticket.source, ticket.staged); }
    catch (error) { unlinkSync(ticket.manifest); throw error; }
    return ticket;
  }
  rollback(ticket: PurgeTicket): void {
    const checked = this.ticket(ticket.id, ticket.source);
    if (existsSync(checked.source)) throw new Error('原目录已有内容，无法回退文件清理');
    this.tree(checked.staged);
    renameSync(checked.staged, checked.source);
    unlinkSync(checked.manifest);
  }
  finish(ticket: PurgeTicket): void {
    const checked = this.ticket(ticket.id, ticket.source);
    if (existsSync(checked.source)) {
      if (existsSync(checked.staged)) throw new Error('清理目录与原目录冲突，文件已保留');
      // The process stopped before the move; no original file may be deleted.
      unlinkSync(checked.manifest); return;
    }
    if (existsSync(checked.staged)) {
      this.tree(checked.staged);
      // Both the absolute boundary and every descendant were checked above.
      rmSync(checked.staged, { recursive: true, maxRetries: 2, retryDelay: 50 });
    }
    unlinkSync(checked.manifest);
  }
}
