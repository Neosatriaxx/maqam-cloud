/* One-time migration helper for MAQAM -> Vercel refactor.
 * - backs up the two legacy HTML files into _legacy/
 * - extracts the inline <style> block into public/css/<name>.css
 * - extracts the inline <script> block into public/js/<name>.js (original client logic, for reference)
 * - rewrites the HTML files to reference the external css/js
 * Run: node scripts/migrate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const PUB = 'public';
const jobs = [
  { html: path.join(PUB, 'index.html'), name: 'index' },
  { html: path.join(PUB, 'admin.html'), name: 'admin' },
];

fs.mkdirSync('_legacy', { recursive: true });
fs.mkdirSync(path.join(PUB, 'css'), { recursive: true });
fs.mkdirSync(path.join(PUB, 'js'), { recursive: true });

for (const job of jobs) {
  const raw = fs.readFileSync(job.html, 'utf8');

  // backup original
  fs.copyFileSync(job.html, path.join('_legacy', job.name + '.legacy.html'));

  // extract <style>...</style>
  const styleM = raw.match(/<style>([\s\S]*?)<\/style>/);
  if (!styleM) throw new Error('style block not found in ' + job.html);
  fs.writeFileSync(path.join(PUB, 'css', job.name + '.css'), styleM[1].replace(/^\n/, '').replace(/\s*$/, '\n'));

  // extract the big inline script (the one that starts with 'use strict';)
  const scriptM = raw.match(/<script>\s*\n'use strict';([\s\S]*?)<\/script>\s*\n<\/body>/);
  if (!scriptM) throw new Error('inline script not found in ' + job.html);
  fs.writeFileSync(path.join('_legacy', job.name + '.legacy.js'), `'use strict';${scriptM[1]}`);

  // rewrite html: style -> link, script -> external
  let out = raw.replace(styleM[0], `<link rel="stylesheet" href="/css/${job.name}.css">`);
  out = out.replace(scriptM[0], `<script src="/js/${job.name}.js"></script>\n</body>`);
  fs.writeFileSync(job.html, out);

  console.log(`[ok] ${job.name}: css ${(styleM[1].length / 1024).toFixed(1)} KB, js ${(scriptM[1].length / 1024).toFixed(1)} KB extracted`);
}
console.log('Migration done. Originals kept in _legacy/.');
