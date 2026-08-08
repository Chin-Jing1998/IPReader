// 由 icon.svg 生成 icon.png（electron-builder 的输入）。
// 复用 quartz-kb 已有的 sharp，不为一张图标另加依赖。
//   用法：node build/make-icon.mjs   （在 desktop/ 下执行）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '..', '..', 'quartz-kb', 'package.json'));
const sharp = require('sharp');

const svg = readFileSync(join(HERE, 'icon.svg'));
const out = join(HERE, 'icon.png');
await sharp(svg, { density: 384 }).resize(1024, 1024).png({ compressionLevel: 9 }).toFile(out);
console.log('已生成', out);
