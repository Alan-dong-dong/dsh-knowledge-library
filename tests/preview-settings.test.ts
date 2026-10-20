import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Library } from '../src/core/library.js';
import { createPreviewSettings } from '../src/preview-settings.js';

test('preview proxy settings persist, override startup defaults and apply only to future policy snapshots', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-preview-settings-'));
  const library = new Library(temp);
  try {
    let settings = createPreviewSettings(library);
    assert.deepEqual(settings.status(), { canChange: false, canChangeNetwork: true, picker: null, allowProxyFakeIp: false });
    const inFlightPolicy = settings.fetchPolicy();
    await settings.setProxyMode(true, false, library.root);
    assert.equal(settings.fetchPolicy().allowProxyFakeIp, true);
    assert.equal(inFlightPolicy.allowProxyFakeIp, false, 'an existing request must retain its policy');
    settings = createPreviewSettings(library, { allowProxyFakeIp: false });
    assert.equal(settings.status().allowProxyFakeIp, true);
    await assert.rejects(settings.setProxyMode(false, true, 'stale-root'), /已改变/);
    await assert.rejects(settings.setProxyMode(false, false, library.root), /已改变/);
    await settings.setProxyMode(false, true, library.root);
    settings = createPreviewSettings(library, { allowProxyFakeIp: true });
    assert.equal(settings.status().allowProxyFakeIp, false, 'saved settings take precedence over startup defaults');
    await assert.rejects(settings.change(join(temp, 'other'), library.root), /启动配置/);
    await assert.rejects(settings.pick(new AbortController().signal), /启动配置/);
    // Force an actual filesystem replacement error, rather than mocking persistence.
    const file = join(library.root, '.system', 'preview-settings.json');
    renameSync(file, file + '.backup');
    mkdirSync(file);
    await assert.rejects(settings.setProxyMode(true, false, library.root), /保存失败/);
    assert.equal(settings.status().allowProxyFakeIp, false);
    assert.equal(settings.fetchPolicy().allowProxyFakeIp, false);
  } finally { library.close(); rmSync(temp, { recursive: true, force: true }); }
});

test('preview settings use the first-launch default and reject damaged configuration', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-preview-default-'));
  const library = new Library(temp);
  try {
    assert.equal(createPreviewSettings(library, { allowProxyFakeIp: true }).status().allowProxyFakeIp, true);
    const file = join(library.root, '.system', 'preview-settings.json');
    writeFileSync(file, '{broken json');
    assert.throws(() => createPreviewSettings(library), /读取失败/);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, allowProxyFakeIp: 'true' }));
    assert.throws(() => createPreviewSettings(library), /格式不正确/);
  } finally { library.close(); rmSync(temp, { recursive: true, force: true }); }
});
