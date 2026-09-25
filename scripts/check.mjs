import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, extname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function fail(msg) { problems.push(msg); }
function ok(msg) { notes.push(msg); }

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const manifestRaw = readFileSync(join(root, 'manifest.json'), 'utf8');
let manifest;
try {
  manifest = JSON.parse(manifestRaw);
} catch (e) {
  fail('manifest.json is not valid JSON: ' + e.message);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (!manifest.minimum_chrome_version) fail('minimum_chrome_version missing');
if (!/^(1(1[6-9]|[2-9]\d)|[2-9]\d{2,})$/.test(manifest.minimum_chrome_version || '')) {
  notes.push('minimum_chrome_version = ' + manifest.minimum_chrome_version);
}

const referenced = new Set();
const addRef = (p, where) => {
  if (!p || typeof p !== 'string') return;
  if (/^https?:/i.test(p)) { fail(`remote resource referenced in ${where}: ${p}`); return; }
  referenced.add(p.replace(/^\//, ''));
};

for (const [size, p] of Object.entries(manifest.icons || {})) addRef(p, `icons.${size}`);
if (manifest.action) {
  addRef(manifest.action.default_popup, 'action.default_popup');
  for (const p of Object.values(manifest.action.default_icon || {})) addRef(p, 'action.default_icon');
}
if (manifest.background) addRef(manifest.background.service_worker, 'background.service_worker');
if (manifest.options_page) addRef(manifest.options_page, 'options_page');
for (const cs of manifest.content_scripts || []) {
  for (const p of cs.js || []) addRef(p, 'content_scripts.js');
  for (const p of cs.css || []) addRef(p, 'content_scripts.css');
}
for (const war of manifest.web_accessible_resources || []) {
  for (const p of war.resources || []) addRef(p, 'web_accessible_resources');
}

for (const p of referenced) {
  if (!existsSync(join(root, p))) fail('manifest references missing file: ' + p);
}
ok(`checked ${referenced.size} manifest file references`);

const htmlFiles = walk(join(root, 'src')).filter((p) => extname(p) === '.html');
for (const html of htmlFiles) {
  const rel = relative(root, html).replace(/\\/g, '/');
  const src = readFileSync(html, 'utf8');
  for (const m of src.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    const ref = m[1];
    if (/^(https?:|data:|mailto:)/i.test(ref)) {
      if (/^https?:/i.test(ref)) fail(`remote resource in ${rel}: ${ref}`);
      continue;
    }
    const resolved = join(dirname(html), ref);
    if (!existsSync(resolved)) fail(`broken local reference in ${rel}: ${ref}`);
  }
}
ok(`checked ${htmlFiles.length} html files for local references and remote scripts`);

const allowedPerms = new Set(['storage', 'unlimitedStorage', 'downloads', 'offscreen']);
for (const p of manifest.permissions || []) {
  if (!allowedPerms.has(p)) notes.push('unexpected permission: ' + p);
}
const hosts = manifest.host_permissions || [];
for (const h of hosts) {
  if (!/^https:\/\/(x|twitter)\.com\/\*$/.test(h)) fail('unexpected host permission: ' + h);
}
const optHosts = manifest.optional_host_permissions || [];
for (const h of optHosts) {
  if (h !== 'https://pbs.twimg.com/*') fail('unexpected optional host: ' + h);
}

const files = walk(root);
const pyFiles = files.filter((p) => extname(p).toLowerCase() === '.py');
if (pyFiles.length) fail('Python files present: ' + pyFiles.map((p) => relative(root, p)).join(', '));
ok(`scanned ${files.length} files — no Python present`);

const jsFiles = files.filter((p) => extname(p) === '.js' && !p.includes('vendor'));
const remotePatterns = [
  { re: /<script[^>]+src=["']https?:/i, name: 'remote <script src>' },
  { re: /import\s*\(\s*['"]https?:/i, name: 'dynamic import of remote code' },
  { re: /import\s+[^'"]*from\s*['"]https?:/i, name: 'static import of remote code' }
];
for (const f of jsFiles) {
  const rel = relative(root, f).replace(/\\/g, '/');
  const src = readFileSync(f, 'utf8');
  for (const { re, name } of remotePatterns) {
    if (re.test(src)) fail(`${name} in ${rel}`);
  }
}
if (!existsSync(join(root, 'src', 'vendor', 'fflate.min.js'))) fail('src/vendor/fflate.min.js missing');
if (!readdirSync(join(root, 'LICENSES')).length) fail('LICENSES/ is empty');

const messagesSrc = readFileSync(join(root, 'src', 'shared', 'messages.js'), 'utf8');
const REQUIRED_MSGS = [
  'GET_TAB_CONTEXT', 'START_RUN', 'PAUSE_RUN', 'RESUME_RUN', 'STOP_RUN',
  'UPSERT_POSTS', 'EXPORT_RUN', 'GET_RUN', 'LIST_RUNS', 'DELETE_RUN',
  'IMPORT_ARCHIVE', 'START_THREAD_QUEUE', 'PAUSE_THREAD_QUEUE'
];
for (const m of REQUIRED_MSGS) {
  if (!messagesSrc.includes(`'${m}'`)) fail('required message type missing from messages.js: ' + m);
}

const swSrc = readFileSync(join(root, 'src', 'background', 'service-worker.js'), 'utf8');
for (const m of REQUIRED_MSGS) {
  if (!swSrc.includes(`M.${m}`) && !swSrc.includes(`'${m}'`)) {
    fail('service worker does not handle: ' + m);
  }
}

for (const n of notes) console.log('  ·', n);
if (problems.length) {
  console.error('\nSTATIC CHECK FAILED:');
  for (const p of problems) console.error('  FAILED:', p);
  process.exit(1);
}
console.log('\nStatic check passed: manifest references, no Python, no remote code, required messages wired.');
