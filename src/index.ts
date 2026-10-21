import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Library } from './core/library.js';
import { ImportQueue } from './core/jobs.js';
import { createTools } from './tools.js';
import { API_PATH, createHandler } from './http.js';
import { fetchPublicPage } from './core/fetch.js';
import { createDirectorySettings } from './directory-settings.js';
import { KnowledgeQueue } from './core/knowledge.js';
import { harnessKnowledgeModel } from './knowledge-model.js';

export const name = 'knowledge-library';
export const inject = ['tools'];
export interface Config { root: string; allowProxyFakeIp?: boolean }
export const Config = z.object({
  root: z.string().default(join(homedir(), 'Documents', 'DSH-Knowledge-Library')).description('资料库绝对路径；更改后重新加载插件。资料独立于聊天和插件安装目录。'),
  allowProxyFakeIp: z.boolean().default(false).description('仅在本机使用 Clash/Mihomo TUN fake-IP DNS 时启用。允许公网域名解析到 198.18.0.0/15，仍拒绝本机和其他内网地址。'),
});
export function apply(ctx: Context, config: Config) {
  const library = new Library(config.root);
  let queue: ImportQueue;
  let knowledge: KnowledgeQueue;
  try { knowledge = new KnowledgeQueue(library, harnessKnowledgeModel(ctx)); } catch (error) { library.close(); throw error; }
  try { queue = new ImportQueue(library, (url, signal) => fetchPublicPage(url, signal, { allowProxyFakeIp: config.allowProxyFakeIp })); } catch (error) { void knowledge.close(); library.close(); throw error; }
  ctx.effect(() => async () => { await Promise.all([queue.close(), knowledge.close()]); library.close(); });
  for (const tool of createTools(library, queue, knowledge)) ctx.tools.register(tool);
  ctx.inject(['webServer'], child => {
    child.effect(() => child.webServer.register({
      kind: 'prefix', path: API_PATH,
      handler: createHandler(library, queue, () => child.webServer.getOrigin(), createDirectorySettings(ctx, library, config), knowledge),
    }));
  });
  ctx.logger.info(`资料库已加载：${library.root}`);
}
