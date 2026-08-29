#!/usr/bin/env node
// 数据管线 D3-0：从节点树生成镜像切片树 —— data/nodes.json + data/node-bodies.json → <域>/_chunks/**
//
//   用途与由来（阶段5.9 波0）：
//     术语提取需要「切片」作为证据单元，而切片历来由外层仓 slice-tools 从源 md 切出。
//     本脚本提供第二条路径：**不读不写源 md 与 _index.md**，直接把已解析好的节点树 1:1 镜像成切片树。
//     先例：quality-evaluation 域（214 节点 → 199 片 + 15 个 _preamble.md）即此形态，
//     本脚本的规则正是从该域反推并逐项校验通过后固化的。
//
//   镜像规则（与 quality-evaluation 实测完全吻合，勿擅改）：
//     · 叶节点（不存在以 `<id>-` 为前缀的其它同域节点）  → 一个切片 `.md`，含正文；
//     · 内部节点（有子节点）                              → 该级目录下的 `_preamble.md`，
//       仅承载该节点自身的 ownText（多为引言性文字），**不计入切片数**——
//       prep-term-extraction.mjs 的 walkMd 显式跳过 `_preamble.md`，故不参与术语提取。
//     ⚠ 不可改为「全部节点各出一片」：内部节点的 fullText 含其全部子节点正文，
//       与子切片重复，会在 df 计数中造成同证据双计（污染术语频次）。
//
//   路径与编号：
//     节点 id 形如 `<prefix>-01-01-04-02`，去前缀后每段两位数字，段数 == breadcrumb 长度。
//     切片路径按段逐级建目录：`_chunks/01/01/04/02.md`。此形态保证
//     prep-term-extraction.mjs 的 deriveIdFromPath 能恒等回推出原 id（自断言 D4）。
//     ⚠ 勿使用「01-01」这类合并编号作目录段——deriveIdFromPath 按 /^\d+$/ 筛选数字段，
//       含连字符的段会被整段丢弃，导致派生 id 缺级、层内 tie-break 失效。
//
//   切片正文格式（与既有切片树逐字对齐，parseChunk 依赖）：
//     第 1 行：`> 〔《书名》 ｜ 祖先段1 ｜ … ｜ 本节 label〕`
//     第 2 行：空行
//     第 3 行：`#`×min(层深,6) + 空格 + label      ← markdown 仅 6 级标题，深层截断至 6
//     其后  ：空行 + 节点 ownText
//
//   四条自断言（--dry-run 亦全部执行，失败即 exit 1）：
//     D1 片数 == 叶节点数（逐域）
//     D2 每片首行匹配面包屑正则，且段数 == 该节点 breadcrumb 长度（首段为书名）
//     D3 首个 markdown 标题 == 节点 label（逐字）
//     D4 deriveIdFromPath(路径数字段) == 节点 id（恒等回推）
//
//   运行：
//     node scripts/build-chunks-from-nodes.mjs --domains <key[,key...]> [--dry-run] [--force]
//       --dry-run  只在内存中生成并跑四条自断言，不落盘（默认行为亦为 dry-run）
//       --force    实际落盘。**会先整目录删除该域现有 _chunks**，请确认外层语料仓已有回退点。
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_DOMAINS, projectRoot } from './lib/domains.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = projectRoot(__dirname);
const DATA_DIR = join(__dirname, '..', 'data');

// ---- 参数解析 ----
const argv = process.argv.slice(2);
function argVal(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}
const DOMAINS_ARG = argVal('--domains');
const FORCE = argv.includes('--force');
const DRY = !FORCE; // 未显式 --force 一律视为 dry-run，避免误落盘

if (!DOMAINS_ARG) {
  console.error('✗ 必须显式指定 --domains <key[,key...]>：本脚本会整目录重写 _chunks，不设「全域默认」。');
  process.exit(1);
}
const wanted = DOMAINS_ARG.split(',').map((s) => s.trim()).filter(Boolean);

const KNOWN_BY_KEY = new Map(KNOWN_DOMAINS.map((d) => [d.key, d]));
const unknown = wanted.filter((k) => !KNOWN_BY_KEY.has(k));
if (unknown.length) {
  console.error(`✗ 未在 KNOWN_DOMAINS 注册的域：${unknown.join('、')}`);
  process.exit(1);
}

// ---- 数据源 ----
const nodes = JSON.parse(readFileSync(join(DATA_DIR, 'nodes.json'), 'utf8'));
const bodies = JSON.parse(readFileSync(join(DATA_DIR, 'node-bodies.json'), 'utf8'));

const pad = (n) => String(n).padStart(2, '0');

// 与 prep-term-extraction.mjs:110 deriveIdFromPath 同口径（复刻，用于 D4 自断言）
function deriveIdFromPath(dom, relSegs) {
  const digits = relSegs.filter((s) => /^\d+$/.test(s)).map((s) => pad(parseInt(s, 10)));
  if (!digits.length) return null;
  return dom.special === 'guideline' ? digits.join('-') : [dom.prefix, ...digits].join('-');
}

const BREADCRUMB_RE = /^>\s*〔(.+)〕\s*$/;
const MAX_HEADING_LEVEL = 6; // markdown 标题上限；深于 6 层的节点截断至 6，parseChunk 正则同为 {1,6}

function renderChunk(node) {
  const bc = node.breadcrumb;
  const segs = [`《${bc[0]}》`, ...bc.slice(1), node.label];
  const crumb = `> 〔${segs.join(' ｜ ')}〕`;
  const level = Math.min(bc.length, MAX_HEADING_LEVEL);
  const heading = `${'#'.repeat(level)} ${node.label}`;
  const body = ((bodies[node.id] && bodies[node.id].ownText) || '').trim();
  return `${crumb}\n\n${heading}\n\n${body}\n`;
}

// ---- 逐域生成 ----
let allOk = true;
const summary = [];

for (const key of wanted) {
  const dom = KNOWN_BY_KEY.get(key);
  const domNodes = nodes.filter((n) => n.domain === key);
  const chunksRoot = join(ROOT, key, '_chunks');

  if (!domNodes.length) {
    console.error(`✗ [${key}] nodes.json 中无该域节点——请先确认 parse-domains 已覆盖该域。`);
    allOk = false;
    continue;
  }

  // 叶判定：不存在以 `<id>-` 开头的同域节点
  const idSet = domNodes.map((n) => n.id);
  const hasChild = new Set();
  for (const a of domNodes) {
    for (const b of idSet) {
      if (b !== a.id && b.startsWith(a.id + '-')) { hasChild.add(a.id); break; }
    }
  }
  const leaves = domNodes.filter((n) => !hasChild.has(n.id));
  const inners = domNodes.filter((n) => hasChild.has(n.id));

  // 生成（内存）
  const files = []; // {relPath, content, node, isPreamble}
  for (const n of leaves) {
    const segs = n.id.replace(new RegExp(`^${dom.prefix}-`), '').split('-');
    files.push({ relPath: segs.join('/') + '.md', content: renderChunk(n), node: n, isPreamble: false, segs });
  }
  for (const n of inners) {
    const segs = n.id.replace(new RegExp(`^${dom.prefix}-`), '').split('-');
    files.push({ relPath: segs.join('/') + '/_preamble.md', content: renderChunk(n), node: n, isPreamble: true, segs });
  }

  // ---- 四条自断言 ----
  const chunkFiles = files.filter((f) => !f.isPreamble);
  const errs = [];

  // D1 片数 == 叶节点数
  if (chunkFiles.length !== leaves.length) {
    errs.push(`D1 片数 ${chunkFiles.length} ≠ 叶节点数 ${leaves.length}`);
  }

  // D2/D3/D4 逐片校验
  let d2 = 0, d3 = 0, d4 = 0;
  const d2Bad = [], d3Bad = [], d4Bad = [];
  for (const f of chunkFiles) {
    const lines = f.content.split('\n');
    const m = lines[0].match(BREADCRUMB_RE);
    // D2 面包屑格式与段数（段数 = breadcrumb 长度：首段书名 + 祖先 + 自身 label）
    if (m) {
      const segs = m[1].split(/[｜|]/).map((s) => s.trim()).filter(Boolean);
      if (segs.length === f.node.breadcrumb.length + 1) d2++;
      else d2Bad.push(`${f.relPath}: 段数 ${segs.length} ≠ ${f.node.breadcrumb.length + 1}`);
    } else d2Bad.push(`${f.relPath}: 首行不匹配面包屑正则`);

    // D3 首个 markdown 标题 == label
    let heading = null;
    for (const line of lines.slice(1)) {
      const hm = line.match(/^#{1,6}\s+(.*\S)\s*$/);
      if (hm) { heading = hm[1].trim(); break; }
    }
    if (heading === f.node.label) d3++;
    else d3Bad.push(`${f.relPath}: 标题「${heading}」≠ label「${f.node.label}」`);

    // D4 deriveIdFromPath 恒等回推
    const derived = deriveIdFromPath(dom, f.relPath.replace(/\.md$/, '').split('/'));
    if (derived === f.node.id) d4++;
    else d4Bad.push(`${f.relPath}: 派生 ${derived} ≠ id ${f.node.id}`);
  }
  if (d2 !== chunkFiles.length) errs.push(`D2 面包屑格式 ${d2}/${chunkFiles.length}`);
  if (d3 !== chunkFiles.length) errs.push(`D3 首标题=label ${d3}/${chunkFiles.length}`);
  if (d4 !== chunkFiles.length) errs.push(`D4 id 恒等回推 ${d4}/${chunkFiles.length}`);

  // 空正文统计（不构成断言失败，但必须显式告知——空片对术语提取无产出）
  const emptyBody = chunkFiles.filter((f) => f.content.split('\n').slice(3).join('').trim() === '');

  console.log(`\n—— [${key}] ${dom.title} ——`);
  console.log(`节点 ${domNodes.length} = 叶 ${leaves.length} + 内部 ${inners.length}`);
  console.log(`生成: 切片 ${chunkFiles.length} 片、_preamble ${files.length - chunkFiles.length} 个`);
  console.log(`自断言: D1 片数=叶数 ${chunkFiles.length === leaves.length ? '✓' : '✗'} | D2 面包屑 ${d2}/${chunkFiles.length} | D3 首标题=label ${d3}/${chunkFiles.length} | D4 id 恒等回推 ${d4}/${chunkFiles.length}`);
  if (emptyBody.length) console.log(`⚠ 空正文切片 ${emptyBody.length} 片（节点 ownText 为空，提取时无产出）：${emptyBody.slice(0, 5).map((f) => f.node.id).join('、')}${emptyBody.length > 5 ? ' …' : ''}`);
  for (const bad of [d2Bad, d3Bad, d4Bad]) {
    for (const line of bad.slice(0, 5)) console.error(`  ✗ ${line}`);
    if (bad.length > 5) console.error(`  ✗ …另有 ${bad.length - 5} 条`);
  }
  if (errs.length) {
    allOk = false;
    console.error(`✗ [${key}] 自断言未通过：${errs.join('；')}`);
  }

  // ---- 落盘 ----
  if (DRY) {
    const existing = existsSync(chunksRoot) ? countMd(chunksRoot) : 0;
    console.log(`（dry-run，未落盘。现有 _chunks 下 .md 文件 ${existing} 个；加 --force 才写入并整目录替换）`);
  } else if (!errs.length) {
    if (existsSync(chunksRoot)) {
      const before = countMd(chunksRoot);
      rmSync(chunksRoot, { recursive: true, force: true });
      console.log(`已删除旧 _chunks（原有 .md ${before} 个）`);
    }
    for (const f of files) {
      const abs = join(chunksRoot, f.relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }
    console.log(`✓ 已落盘 ${files.length} 个文件 → ${chunksRoot}`);
  } else {
    console.error(`✗ [${key}] 因自断言未通过，跳过落盘`);
  }

  summary.push({ key, nodes: domNodes.length, leaves: leaves.length, inners: inners.length, chunks: chunkFiles.length, empty: emptyBody.length, ok: !errs.length });
}

function countMd(dir) {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) n += countMd(p);
    else if (name.endsWith('.md')) n++;
  }
  return n;
}

// ---- 汇总 ----
console.log('\n—— 汇总 ——');
console.log('域 | 节点 | 叶(=片数) | 内部(_preamble) | 空正文 | 断言');
for (const s of summary) {
  console.log(`${s.key} | ${s.nodes} | ${s.leaves} | ${s.inners} | ${s.empty} | ${s.ok ? '✓' : '✗'}`);
}
console.log(`合计切片 ${summary.reduce((a, s) => a + s.chunks, 0)} 片${DRY ? '（dry-run）' : '（已落盘）'}`);
console.log(allOk ? '✓ 全部自断言通过' : '✗ 存在未通过项');
if (!allOk) process.exit(1);
