// 生成 PatentKB 的应用图标：build/icon.svg（可查看的源）与 build/icon.png（打包输入）。
//   用法：node build/make-icon.mjs   （在 desktop/ 下执行）
//
// 为什么用脚本而非手写 SVG：Apple 的图标轮廓不是普通圆角矩形，而是**连续曲率**的
// squircle（超椭圆）。SVG 的 rx 圆角在角部有曲率突变，与系统内置图标并排时一眼可辨。
// 超椭圆没有简洁的贝塞尔表达，用参数方程采样成路径最准确。
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

const body = squircle(C, C, HALF);
const inner = squircle(C, C, HALF - 2.5); // 内描边走同一形状，避免角部错位

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- 由 build/make-icon.mjs 生成，勿直接编辑；改设计请改脚本后重跑 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}">
  <defs>
    <!-- 底：近白。浅底把注意力全部让给中央符号，也让图标在深浅两种 Dock
         背景下都清晰。极轻的自上而下渐变提供厚度，避免"一张纸"的观感。 -->
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0"   stop-color="#ffffff"/>
      <stop offset="0.6" stop-color="#fbfcfd"/>
      <stop offset="1"   stop-color="#f1f4f7"/>
    </linearGradient>
    <!-- 边缘：浅底图标必须有一圈极淡的描边，否则贴在白色窗口上会"融掉" -->
    <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0"   stop-color="#ffffff" stop-opacity="0.9"/>
      <stop offset="1"   stop-color="#c9d2da" stop-opacity="0.75"/>
    </linearGradient>

    <!-- 笔画：沿走向的三段蓝，制造丝带扭转的明暗。
         浅端在右上（受光），深端在左下（背光）。 -->
    <linearGradient id="ink" x1="0.05" y1="0.95" x2="0.95" y2="0.05">
      <stop offset="0"    stop-color="#0b4a86"/>
      <stop offset="0.42" stop-color="#1878d0"/>
      <stop offset="0.78" stop-color="#33a9f2"/>
      <stop offset="1"    stop-color="#5cc8fb"/>
    </linearGradient>
    <!-- 关联那一笔：同色系更浅，退到主笔画之后 -->
    <linearGradient id="ink2" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0"   stop-color="#1e86dd"/>
      <stop offset="1"   stop-color="#6fd0fb"/>
    </linearGradient>
  </defs>

  <path d="${body}" fill="url(#body)"/>
  <path d="${inner}" fill="none" stroke="url(#edge)" stroke-width="3"/>

  <!-- 符号：书法体的 P（Patent 的首字母）——一竖带弧、收笔向右轻提；
       一环自竖顶甩出、回落至竖的中部。
       笔宽统一：靠分段描边做粗细变化会在接缝处留下凸起；等宽笔画把立体感
       全部交给沿走向的渐变（右上受光偏亮、左下背光偏深），这也是这类图标
       惯用的做法。
       整体以画布中心放大 1.22 倍并右移 20，使字符约占图形区宽度的 48%——
       字符太小会让图标显得空。笔宽随之缩放到约 71，占比与参考观感一致。 -->
  <g transform="translate(532,512) scale(1.22) translate(-512,-512)"
     fill="none" stroke-linecap="round" stroke-linejoin="round">
    <!-- 竖：起笔略向左倾，行笔挺直，收笔向右轻提 -->
    <path d="M 366 296 C 356 430, 356 578, 368 696 C 371 720, 386 730, 406 724"
          stroke="url(#ink)" stroke-width="58"/>
    <!-- 环：自竖顶向右张开，回落到竖的中部 -->
    <path d="M 366 296 C 502 276, 626 332, 624 426 C 622 522, 508 560, 396 552"
          stroke="url(#ink)" stroke-width="58"/>
  </g>
</svg>
`;

writeFileSync(join(HERE, 'icon.svg'), svg);
await sharp(Buffer.from(svg), { density: 384 })
  .resize(CANVAS, CANVAS)
  .png({ compressionLevel: 9 })
  .toFile(join(HERE, 'icon.png'));
console.log('已生成 icon.svg 与 icon.png');
