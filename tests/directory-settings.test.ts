import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import { Library } from '../src/core/library.js';
import { createDirectorySettings } from '../src/directory-settings.js';

test('directory switching validates before persistence, preserves the source and propagates reload failures', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-root-test-'));
  const library = new Library(join(temp, 'source'));
  const occupied = new Library(join(temp, 'occupied'));
  const fiber = {};
  const entry = { fiber, options: { id: 'knowledge-library' } };
  let config = { root: library.root, allowProxyFakeIp: true };
  let writes = 0;
  let fail = false;
  const editor = {
    entries: () => [entry],
    edit: async (_entry: unknown, change: (current: typeof config) => typeof config) => {
      writes++;
      if (fail) throw new Error('reload rejected');
      config = change(config);
    },
  };
  const ctx = { fiber, get: (name: string) => name === 'configEditor' ? editor : undefined } as unknown as Context;
  const settings = createDirectorySettings(ctx, library);
  const next = join(temp, 'next');
  try {
    const saved = library.captureText('旧目录资料在切换失败后仍可读取。', { title: '旧资料' }).material;
    assert.equal(settings.status().canChange, true);
    await assert.rejects(settings.change('relative/path', library.root), /绝对路径/);
    await assert.rejects(settings.change(join(library.root, 'child'), library.root), /互相包含/);
    await assert.rejects(settings.change(temp, library.root), /互相包含/);
    await assert.rejects(settings.change(next, 'stale-root'), /已改变/);
    await assert.rejects(settings.change(occupied.root, library.root), /另一实例/);
    const file = join(temp, 'file'); writeFileSync(file, 'not a directory');
    await assert.rejects(settings.change(file, library.root));
    assert.equal(writes, 0);
    assert.equal(library.get(saved.id).title, '旧资料');
    fail = true;
    await assert.rejects(settings.change(next, library.root), /reload rejected/);
    assert.equal(config.root, library.root);
    assert.equal(library.get(saved.id).title, '旧资料');
    const reusable = new Library(next); reusable.close();
    fail = false;
    await settings.change(next, library.root);
    assert.equal(config.root, next);
    assert.equal(config.allowProxyFakeIp, true);
    const target = new Library(next); assert.equal(target.stats().total, 0); target.close();
    assert.equal(library.get(saved.id).title, '旧资料');
    await settings.change(library.root, library.root);
    assert.equal(writes, 2);
  } finally { occupied.close(); library.close(); rmSync(temp, { recursive: true, force: true }); }
});

test('host chooser cancellation is read-only, prevents duplicate dialogs and passes browsing through', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-picker-test-'));
  const library = new Library(temp);
  let done!: (path: string | null) => void;
  let picker: any = { kind: 'native', pick: () => new Promise(resolve => { done = resolve; }) };
  const ctx = { get: (name: string) => name === 'directoryPicker' ? { capability: () => picker } : undefined } as unknown as Context;
  const settings = createDirectorySettings(ctx, library);
  try {
    assert.deepEqual(settings.status(), { canChange: false, picker: 'native' });
    const pending = settings.pick(new AbortController().signal);
    await assert.rejects(settings.pick(new AbortController().signal), /已打开/);
    done(null); assert.equal(await pending, null);
    const listing = { path: temp, home: temp, crumbs: [], entries: [], truncated: false };
    picker = { kind: 'browse', list: async () => listing };
    assert.equal(await settings.list(temp, new AbortController().signal), listing);
    await assert.rejects(settings.pick(new AbortController().signal), /不支持/);
    await assert.rejects(settings.change(join(temp, '..', 'elsewhere'), temp), /无法保存/);
  } finally { library.close(); rmSync(temp, { recursive: true, force: true }); }
});
