import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run with npm run pack:check after npm run build.');
await mkdir('release', { recursive: true });
const output = execFileSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', 'release'], { encoding: 'utf8' });
const [manifest] = JSON.parse(output);
assert.equal(manifest.name, pkg.name);
assert.equal(manifest.version, pkg.version);
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(pkg.dsh.client.platform, 'web');
assert.equal(basename(manifest.filename), manifest.filename);
const paths = new Set(manifest.files.map(file => file.path));
for (const path of paths) {
  assert.ok(/^(?:dist\/[^\\]+|README\.md|CHANGELOG\.md|LICENSE|cordis\.patch\.yml|package\.json)$/.test(path), `Unexpected release file: ${path}`);
  assert.ok(!/(?:^|\/)(?:\.env[^/]*|node_modules|\.test-runtime|\.research|test-results|materials|\.system)(?:\/|$)/.test(path), `Private state in release: ${path}`);
}
for (const path of ['README.md', 'CHANGELOG.md', 'LICENSE', 'cordis.patch.yml', 'package.json', 'dist/index.js', 'dist/client.js', 'dist/standalone.js', 'dist/public/index.html', 'dist/public/app.js', 'dist/public/app.css']) {
  assert.ok(paths.has(path), `Required runtime file missing: ${path}`);
}
for (const entry of Object.values(pkg.exports)) {
  for (const target of typeof entry === 'string' ? [entry] : Object.values(entry)) {
    assert.ok(paths.has(target.replace(/^\.\//, '')), `Export missing from package: ${target}`);
  }
}
const client = await readFile('dist/client.js', 'utf8');
assert.ok(client.includes('window.__ModuleLoader__.load('), 'Missing DSH lazy client factory.');
const archive = await readFile(join('release', manifest.filename));
const sha256 = createHash('sha256').update(archive).digest('hex');
await writeFile('release/SHA256SUMS', `${sha256}  ${manifest.filename}\n`);
await writeFile('release/package-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Verified ${manifest.filename}: ${paths.size} files, ${archive.length} bytes. SHA-256: ${sha256}`);
