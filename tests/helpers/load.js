import '../../src/shared/util.js';
import '../../src/shared/messages.js';
import '../../src/shared/defaults.js';
import '../../src/shared/settings.js';
import '../../src/shared/post-model.js';
import '../../src/shared/filename.js';
import '../../src/shared/export-json.js';
import '../../src/shared/export-html.js';
import '../../src/shared/media-zip.js';
import '../../src/content/namespace.js';
import '../../src/content/source-detector.js';
import '../../src/content/extractor.js';
import '../../src/content/overlay.js';
import '../../src/content/scraper-controller.js';
import '../../src/background/database.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const XA = globalThis.XArchive;

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixture(name) {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

export function mountFixture(name) {
  document.body.innerHTML = fixture(name);
  return document;
}

export function unmountFixture() {
  document.body.innerHTML = '';
}
