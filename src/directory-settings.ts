import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-config-editor';
import type {} from '@deepseek-ai/dsh-host-directory-picker';
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Library } from './core/library.js';

export type { DirectoryListing };
export interface DirectorySettings {
  status(): { canChange: boolean; picker: 'native' | 'browse' | null };
  pick(signal: AbortSignal): Promise<string | null>;
  list(path: string | undefined, signal: AbortSignal): Promise<DirectoryListing>;
  change(root: string, expectedRoot: string): Promise<string>;
}

export function createDirectorySettings(ctx: Context, library: Library): DirectorySettings {
  let changing = false;
  let picking = false;
  const editorEntry = () => {
    const editor = ctx.get('configEditor');
    const entry = editor?.entries().find(entry => entry.fiber === ctx.fiber);
    return editor && entry ? { editor, entry } : undefined;
  };
  const capability = () => ctx.get('directoryPicker')?.capability();
  return {
    status() {
      const kind = capability()?.kind;
      return { canChange: !!editorEntry(), picker: kind === 'native' || kind === 'browse' ? kind : null };
    },
    async pick(signal) {
      const picker = capability();
      if (picker?.kind !== 'native') throw new Error('当前环境不支持系统目录选择，请浏览目录或填写绝对路径');
      if (picking) throw new Error('目录选择窗口已打开');
      picking = true;
      try { return await picker.pick(signal); } finally { picking = false; }
    },
    async list(path, signal) {
      const picker = capability();
      if (picker?.kind !== 'browse') throw new Error('当前环境不支持目录浏览，请使用系统目录选择');
      return picker.list(path, signal);
    },
    async change(root, expectedRoot) {
      if (changing) throw new Error('正在切换资料库，请稍候');
      if (expectedRoot !== library.root) throw new Error('资料库目录已改变，请刷新设置后重试');
      if (!root.trim() || !isAbsolute(root) || (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(root))) throw new Error('请选择或填写完整的资料库绝对路径');
      const next = resolve(root);
      if (next === library.root) return library.root;
      const rel = relative(library.root, next);
      const back = relative(next, library.root);
      const inside = (value: string) => !!value && !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`);
      if (inside(rel) || inside(back)) throw new Error('新旧资料库不能互相包含，请选择独立目录');
      const target = editorEntry();
      if (!target) throw new Error('当前环境无法保存插件配置，请在 Harness 中修改资料库目录');
      changing = true;
      try {
        // Check write access, the index and the single-writer lock before reloading.
        const probe = new Library(next);
        probe.close();
        await target.editor.edit(target.entry, current => ({ ...current, root: next }));
        return next;
      } finally { changing = false; }
    },
  };
}
