import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import * as plugin from '../src/index.js';

test('native Cordis plugin registers typed DSH tools, unloads cleanly and reopens the same library', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-test-'));
  const ctx = new Context();
  const prompt = ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await prompt.await();
  const runtime = ctx.plugin(ToolRuntime, { mode: 'native' });
  await runtime.await();
  let libraryPlugin = ctx.plugin(plugin, { root });
  const exec = { signal: new AbortController().signal } as ToolRunContext;
  try {
    await libraryPlugin.await();
    const tool = ctx.tools.get('library_capture');
    assert.ok(tool);
    await assert.rejects(tool.execute({ type: 'wrong', content: 'x' }, exec), /type|enum/);
    const saved = await tool.execute({ type: 'text', content: '插件通过原生工具保存的知识资料。', title: '原生工具验证', category: '测试' }, exec) as any;
    assert.equal(saved.status, 'ready');
    const read = await ctx.tools.get('library_read')!.execute({ id: saved.id }, exec) as any;
    assert.equal(read.segments[0].citation, `library://${saved.id}/p0001`);
    assert.equal(read.segments[0].text, '插件通过原生工具保存的知识资料。');
    await libraryPlugin.dispose();
    assert.equal(ctx.tools.get('library_capture'), undefined);
    libraryPlugin = ctx.plugin(plugin, { root });
    await libraryPlugin.await();
    const search = await ctx.tools.get('library_search')!.execute({ query: '知识' }, exec) as any;
    assert.equal(search.items[0].id, saved.id);
    const note = await ctx.tools.get('library_save_note')!.execute({ content: '测试结论', title: '测试笔记', citations: [{ materialId: saved.id, segmentId: 'p0001' }] }, exec) as any;
    assert.equal(note.kind, 'note');
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(ctx.tools.get('library_read')!.execute({ id: saved.id }, { signal: aborted.signal } as ToolRunContext));
  } finally {
    await libraryPlugin.dispose(); await runtime.dispose(); await prompt.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
