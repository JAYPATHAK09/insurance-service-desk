// Builds fixtures/renewal-agent/<case>/<name>.txt from <name>.pages.txt.
// Authoring format: pages are separated by a line "----- page break -----"; the built file uses a real form feed (\f),
// which is what the platform's text ingestion treats as a page boundary.
// Run: node fixtures/renewal-agent/build.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
let n = 0;
for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(root, dir.name))) {
    if (!f.endsWith('.pages.txt')) continue;
    const src = fs.readFileSync(path.join(root, dir.name, f), 'utf8').replace(/\r\n?/g, '\n');
    const pages = src.split(/\n?----- page break -----\n?/).map((p) => p.trim());
    fs.writeFileSync(path.join(root, dir.name, f.replace('.pages.txt', '.txt')), pages.join('\f') + '\n');
    n++;
  }
}
console.log(`built ${n} fixture file(s)`);
