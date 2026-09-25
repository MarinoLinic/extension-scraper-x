import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = join(root, 'assets', 'icons', 'icon.svg');
const svg = readFileSync(svgPath);

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch (e) {
  console.error('sharp is required to rasterize icons: npm i -D sharp\n' + e.message);
  process.exit(1);
}

for (const size of [16, 32, 48, 128]) {
  const out = join(root, 'assets', 'icons', `icon-${size}.png`);
  await sharp(svg, { density: 384 })
    .resize(size, size)
    .png()
    .toFile(out);
  console.log('wrote', out);
}
