// 原文附图导入（一次性）：把七书正文实际引用的 88 张附图从桌面源文件夹
// 复制到 site/assets/book-images/<domain>/，并产出对应索引 manifest。
// 引用清单以 data/node-bodies.json 的 ownText 为准（与 build-quartz-md.mjs 同一正文来源），
// 源目录中未被任何正文引用的"孤儿图"不复制、仅记录（无处展示）。
// 只读：data/node-bodies.json、data/nodes.json、桌面源目录、quartz-kb/content（文件名→页路径映射）
// 产出：assets/book-images/<domain>/<原文件名>、data/book-images-manifest.json
// 用法：node scripts/import-book-images.mjs
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(SITE, 'data');
const ASSETS = join(SITE, 'assets', 'book-images');
const CONTENT = join(SITE, '..', 'quartz-kb', 'content');
const IMG_REF_RE = /!\[[^\]]*\]\(images\/([^)]+)\)/g;
// 三本含图书：domain → 桌面源 images 目录
// ⚠ 2026-08-23 修复（任务书外发现）：examination-guideline 域已由 'examination-guideline-2025' 更名，
//   本表键仍写旧字面量，致 SRC_BY_DOMAIN[domain] 查不中，该域含图节点会在下方判空处直接抛错退出；
//   现同步新键；桌面源目录路径本身与域 key 无关、不属本次修复范围，原样保留。
// ⚠ 2026-08-24 补导（阶段5.2 批次 W-R，经主会话裁决批准）：批次 Q-1 将《专利质量评价指南》
//   作为第 88 部书入库 214 节点时，仅入正文未导附图，致其 8 个节点引用的 13 张图在
//   build-quartz-md.mjs 判为死链、硬闸 exit 1；现补入该域源目录映射，附图总数 88 → 101。
const SRC_BY_DOMAIN = {
  'examination-guideline':
    '/Users/chin.jing1998/Desktop/知识产权相关文件/专利审查指南（2025）/images',
  'mechanical-drafting-rules':
    '/Users/chin.jing1998/Desktop/知识产权相关文件/机械案件撰写规范/images',
  'chemistry-drafting-rules':
    '/Users/chin.jing1998/Desktop/知识产权相关文件/化学案件撰写规范/images',
  'quality-evaluation':
    '/Users/chin.jing1998/Desktop/知识产权相关文件/专利质量评价指南/images',
};

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const bodies = readJson(join(DATA, 'node-bodies.json'));
const nodes = readJson(join(DATA, 'nodes.json'));
const domainById = new Map(nodes.map((n) => [n.id, n.domain]));

// 节点 id → quartz 页面路径（供 manifest 索引；只需覆盖含图节点）
function buildPageMap() {
  const map = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.md')) map.set(name.replace(/\.md$/, ''), relative(CONTENT, p));
    }
  };
  walk(CONTENT);
  return map;
}

// 从 ownText 提取全部图片引用（保持出现顺序）
function collectRefs() {
  const refs = [];
  for (const [nodeId, rec] of Object.entries(bodies)) {
    const own = (rec && rec.ownText) || '';
    let m;
    IMG_REF_RE.lastIndex = 0;
    while ((m = IMG_REF_RE.exec(own))) {
      const domain = domainById.get(nodeId);
      if (!domain) throw new Error(`引用所在节点 ${nodeId} 不在 nodes.json 中`);
      if (!SRC_BY_DOMAIN[domain]) throw new Error(`节点 ${nodeId}（${domain}）含图片引用但域无源目录映射`);
      refs.push({ file: m[1], domain, nodeId });
    }
  }
  return refs;
}

function main() {
  const refs = collectRefs();
  const pageMap = buildPageMap();
  const errors = [];
  const images = [];
  const copiedByDomain = new Map();

  for (const r of refs) {
    const src = join(SRC_BY_DOMAIN[r.domain], r.file);
    if (!existsSync(src)) {
      errors.push(`源图缺失：${src}（节点 ${r.nodeId}）`);
      continue;
    }
    const bytes = statSync(src).size;
    if (bytes === 0) {
      errors.push(`源图为空文件：${src}`);
      continue;
    }
    const destDir = join(ASSETS, r.domain);
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, r.file);
    copyFileSync(src, dest);
    if (statSync(dest).size !== bytes) {
      errors.push(`复制后字节数不一致：${dest}`);
      continue;
    }
    images.push({
      file: r.file,
      domain: r.domain,
      nodeId: r.nodeId,
      page: pageMap.get(r.nodeId) || null,
      bytes,
    });
    if (!copiedByDomain.has(r.domain)) copiedByDomain.set(r.domain, new Set());
    copiedByDomain.get(r.domain).add(r.file);
  }

  if (errors.length) {
    console.error(`导入失败（${errors.length} 项）：\n` + errors.join('\n'));
    process.exit(1);
  }

  // 孤儿图：源目录存在但从未被正文引用（不复制，仅记录）
  const orphans = [];
  for (const [domain, srcDir] of Object.entries(SRC_BY_DOMAIN)) {
    const used = copiedByDomain.get(domain) || new Set();
    for (const name of readdirSync(srcDir)) {
      if (name.startsWith('.')) continue;
      if (!used.has(name)) orphans.push({ file: name, domain, bytes: statSync(join(srcDir, name)).size });
    }
  }

  const manifest = {
    _说明:
      '原文附图索引：images 为正文实际引用并已复制入 assets/book-images/<domain>/ 的附图（build-quartz-md.mjs 据此嵌入文档站）；orphans 为源目录中从未被正文引用的孤儿图（未复制）。',
    generatedAt: new Date().toISOString(),
    counts: {
      images: images.length,
      orphans: orphans.length,
      byDomain: Object.fromEntries(
        [...copiedByDomain.entries()].map(([d, s]) => [d, s.size]),
      ),
    },
    images,
    orphans,
  };
  writeFileSync(join(DATA, 'book-images-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest.counts, null, 2));
  console.log(`✅ 导入完成：${images.length} 张图片，manifest 已写入 data/book-images-manifest.json`);
}

main();
