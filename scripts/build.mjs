import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
await mkdir('dist/public', { recursive: true });
const css = await readFile('src/ui/style.css', 'utf8');
await writeFile('dist/public/app.css', css);
await writeFile('dist/public/index.html', '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>拾页 · 本地资料库</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
await build({ entryPoints: ['src/ui/main.tsx'], outfile: 'dist/public/app.js', bundle: true, format: 'iife', minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
const client = await build({
  entryPoints: ['src/client.tsx'], bundle: true, format: 'cjs', platform: 'browser', write: false,
  external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
});
await writeFile('dist/client.js', `window.__ModuleLoader__.load({id:"dsh-knowledge-library",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`);
console.log('Built host plugin, DSH lazy client bundle and standalone preview.');
