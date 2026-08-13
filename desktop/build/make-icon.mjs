// 生成 PatentReader 的应用图标：build/icon.svg（可查看的源）与 build/icon.png（打包输入）。
//   用法：node build/make-icon.mjs          （在 desktop/ 下执行，生成方案 A：浅色底图谱网络）
//         node build/make-icon.mjs --dark   （生成方案 B：深蓝底图谱网络，输出 icon-dark.svg/png）
//
// 为什么用脚本而非手写 SVG：Apple 的图标轮廓不是普通圆角矩形，而是**连续曲率**的
// squircle（超椭圆）。SVG 的 rx 圆角在角部有曲率突变，与系统内置图标并排时一眼可辨。
// 超椭圆没有简洁的贝塞尔表达，用参数方程采样成路径最准确。
//
// 设计说明（2026-08-09 由「书法 P」改为「知识图谱网络」）：
//   项目核心特色是图谱总览页——6 个彩色节点取自图谱页 8 类分类色板
//   （红·专利法 / 橙·实施细则 / 绿·侵权判定 / 靛·术语 / 紫·答复OA / 中心亮青·机械撰写），
//   连线构成知识网络，一眼传达「PatentReader + 图谱导航」的产品属性。
//   布局上下对称（上二下二、左中一、中心一），重心居中；节点用偏上径向渐变模拟受光，
//   不加额外高光层避免小尺寸渲染瑕疵；连线分核心/外环两层透明度制造层次。
//
// 复用 quartz-kb 已有的 sharp 做 SVG→PNG，不为一张图标另加依赖。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, '..', '..', 'quartz-kb', 'package.json'));
const sharp = require('sharp');

/**
 * 超椭圆（squircle）路径：|x/a|^n + |y/a|^n = 1。
 * n=5 接近 macOS Big Sur 起沿用的图标轮廓；n=2 退化为圆，n→∞ 趋近方形。
 */
function squircle(cx, cy, half, n = 5, steps = 512) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const x = cx + half * Math.sign(ct) * Math.abs(ct) ** (2 / n);
    const y = cy + half * Math.sign(st) * Math.abs(st) ** (2 / n);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

// macOS 图标模板：1024 画布，图形占 824 居中（四周各留 100 的透明边，
// 系统在 Dock 中会为其补投影，故此处不自带外阴影）。
const CANVAS = 1024;
const C = CANVAS / 2;
const HALF = 412;

// 图谱色板（与图谱总览页图例一致）
const PALETTE = ['#d1495b', '#e07b39', '#b8860b', '#4c9f70', '#2a9d8f', '#4381c1', '#8e6bbf', '#3f51b5'];

// 节点布局：中心 + 5 外围（上下对称、重心居中）
const NODES = [
  { x: 512, y: 528, r: 86, color: '#2a9d8f' },  // 中心：亮青（项目色板·机械撰写），双底色下均高对比
  { x: 340, y: 336, r: 56, color: '#d1495b' },  // 专利法（左上）
  { x: 684, y: 336, r: 52, color: '#e07b39' },  // 实施细则（右上）
  { x: 340, y: 716, r: 54, color: '#4c9f70' },  // 侵权判定（左下）
  { x: 684, y: 716, r: 58, color: '#3f51b5' },  // 术语（右下，靛蓝避免与中心青撞色）
  { x: 258, y: 528, r: 48, color: '#8e6bbf' },  // 答复OA（左中）
];

// 连线（中心辐射 + 外环）
const LINKS = [
  [0, 1], [0, 2], [0, 3], [0, 4], [0, 5],
  [1, 2], [1, 5], [5, 3], [3, 4],
];

// 节点渐变：偏上径向渐变模拟受光（顶部亮、边缘暗），不加额外高光层
function nodeGrad(color) {
  return `<radialGradient id="g-${color.slice(1)}" cx="0.38" cy="0.32" r="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.98"/>
      <stop offset="0.6" stop-color="${color}" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0.78"/>
    </radialGradient>`;
}

function nodeCircle(n, strokeW = 0) {
  return `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="url(#g-${n.color.slice(1)})"${strokeW ? ` stroke="#ffffff" stroke-width="${strokeW}"` : ''}/>`;
}

function linksSVG(stroke, coreOpacity, outerOpacity) {
  return LINKS.map(([a, b]) => {
    const na = NODES[a], nb = NODES[b];
    const isCore = a === 0 || b === 0;
    return `<line x1="${na.x}" y1="${na.y}" x2="${nb.x}" y2="${nb.y}" stroke="${stroke}" stroke-width="26" stroke-linecap="round" opacity="${isCore ? coreOpacity : outerOpacity}"/>`;
  }).join('\n    ');
}

// ---------- 方案 A：浅色底 ----------
function schemeA() {
  const body = squircle(C, C, HALF);
  const inner = squircle(C, C, HALF - 2.5);
  const grads = PALETTE.map((c) => nodeGrad(c)).join('\n    ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}">
  <defs>
    <!-- 底：近白。浅底把注意力全部让给中央符号，也让图标在深浅两种 Dock
         背景下都清晰。极轻的自上而下渐变提供厚度，避免"一张纸"的观感。 -->
    <linearGradient id="bodyA" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.6" stop-color="#fbfcfd"/>
      <stop offset="1" stop-color="#f1f4f7"/>
    </linearGradient>
    <!-- 边缘：浅底图标必须有一圈极淡的描边，否则贴在白色窗口上会"融掉" -->
    <linearGradient id="edgeA" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#c9d2da" stop-opacity="0.75"/>
    </linearGradient>
    ${grads}
  </defs>
  <path d="${body}" fill="url(#bodyA)"/>
  <path d="${inner}" fill="none" stroke="url(#edgeA)" stroke-width="3"/>
  ${linksSVG('#73879c', 0.7, 0.45)}
  ${NODES.map((n) => nodeCircle(n)).join('\n    ')}
</svg>`;
}

// ---------- 方案 B：深蓝底 ----------
function schemeB() {
  const body = squircle(C, C, HALF);
  const inner = squircle(C, C, HALF - 2.5);
  const grads = PALETTE.map((c) => nodeGrad(c)).join('\n    ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}">
  <defs>
    <!-- 底：深蓝渐变。深色底让彩色节点更醒目，Dock 深色背景下同样清晰 -->
    <linearGradient id="bodyB" x1="0" y1="0" x2="0.15" y2="1">
      <stop offset="0" stop-color="#1a3a74"/>
      <stop offset="0.55" stop-color="#122c5c"/>
      <stop offset="1" stop-color="#0b1f42"/>
    </linearGradient>
    <linearGradient id="edgeB" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4a76b8" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#0a1c3c" stop-opacity="0.9"/>
    </linearGradient>
    ${grads}
  </defs>
  <path d="${body}" fill="url(#bodyB)"/>
  <path d="${inner}" fill="none" stroke="url(#edgeB)" stroke-width="3"/>
  ${linksSVG('#cfe0f2', 0.65, 0.4)}
  ${NODES.map((n) => nodeCircle(n, 5)).join('\n    ')}
</svg>`;
}

const isDark = process.argv.includes('--dark');
const outBase = isDark ? 'icon-dark' : 'icon';
const svg = isDark ? schemeB() : schemeA();

writeFileSync(join(HERE, `${outBase}.svg`), svg);
await sharp(Buffer.from(svg), { density: 384 })
  .resize(CANVAS, CANVAS)
  .png({ compressionLevel: 9 })
  .toFile(join(HERE, `${outBase}.png`));
console.log(`已生成 ${outBase}.svg 与 ${outBase}.png（${isDark ? '方案 B 深蓝底' : '方案 A 浅色底'}）`);
