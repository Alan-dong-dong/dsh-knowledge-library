import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DirectorySettings } from './directory-settings.js';
import { atomicJson, type Library } from './core/library.js';
import type { FetchPolicy } from './core/fetch.js';

export function createPreviewSettings(library: Library, defaults: FetchPolicy = {}): DirectorySettings & { fetchPolicy(): FetchPolicy } {
  const file = join(library.root, '.system', 'preview-settings.json');
  let allowProxyFakeIp = defaults.allowProxyFakeIp === true;
  if (existsSync(file)) {
    let stored;
    try { stored = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Error('独立预览设置读取失败，请检查 .system/preview-settings.json'); }
    if (stored?.schemaVersion !== 1 || typeof stored.allowProxyFakeIp !== 'boolean') throw new Error('独立预览设置格式不正确，请检查 .system/preview-settings.json');
    allowProxyFakeIp = stored.allowProxyFakeIp;
  }
  const unsupported = async (): Promise<never> => { throw new Error('独立预览请通过启动配置指定资料库目录'); };
  return {
    status: () => ({ canChange: false, canChangeNetwork: true, picker: null, allowProxyFakeIp }),
    // Each request keeps its own policy even if settings change during a redirect.
    fetchPolicy: () => ({ allowProxyFakeIp }),
    pick: unsupported,
    list: unsupported,
    change: unsupported,
    async setProxyMode(enabled, expected, expectedRoot) {
      if (expectedRoot !== library.root || expected !== allowProxyFakeIp) throw new Error('资料库设置已改变，请重新打开设置后重试');
      if (enabled === allowProxyFakeIp) return enabled;
      try { atomicJson(file, { schemaVersion: 1, allowProxyFakeIp: enabled }); }
      catch { throw new Error('采集设置保存失败，请检查资料库目录的写入权限；原设置未改变'); }
      allowProxyFakeIp = enabled;
      return enabled;
    },
  };
}
