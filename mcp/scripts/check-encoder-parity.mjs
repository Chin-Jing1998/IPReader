// check-encoder-parity.mjs —— 双端分词器一致性校验
//
// MCP 的 src/search.mjs 与站内搜索的 quartz-kb/quartz/components/scripts/search.inline.ts
// 共用同一个 encoder：CJK 逐字切分、非 CJK 按空白与标点切词。两者必须逐字一致，
// 否则同一条查询在 MCP 与站内会被切成不同的 token，检索口径分裂。
//
// 该约束此前只写在两处注释里（search.mjs 的「与 search.inline.ts 逐字一致」、
// search.inline.ts 的「本 encoder 与 mcp/src/search.mjs 的同名函数逐字一致」），
// 无任何机制保证。本脚本把注释约束升为可执行断言。
//
// 判等前做最小归一，只抹平语言与格式差异，不触碰任何语义：
//   ① 整行注释与空行  ② 行尾空白与分号  ③ TS 类型标注与非空断言  ④ 引号风格
// quartz 侧经 Prettier 格式化为双引号，MCP 侧为单引号，这是当前两侧唯一的实际差异。
//
// 本脚本只读，不修改任何文件。
//
// 用法：node scripts/check-encoder-parity.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const MCP_FILE = join(HERE, '..', 'src', 'search.mjs');
const QUARTZ_FILE = join(REPO, 'quartz-kb', 'quartz', 'components', 'scripts', 'search.inline.ts');

// 待比对区段：自 PUNCT 常量起，至 encoder 的 return tokens 后首个右花括号止
const START = 'const PUNCT';
const END_ANCHOR = 'return tokens';

/** 抽出 encoder 区段；定位失败即报错，避免静默比对空串 */
function extract(file) {
  const src = readFileSync(file, 'utf8');
  const i = src.indexOf(START);
  if (i === -1) throw new Error(`${rel(file)}：未找到区段起点「${START}」`);
  const j = src.indexOf(END_ANCHOR, i);
  if (j === -1) throw new Error(`${rel(file)}：未找到区段终点「${END_ANCHOR}」`);
  const k = src.indexOf('}', j);
  if (k === -1) throw new Error(`${rel(file)}：区段终点后缺少右花括号`);
  const seg = src.slice(i, k + 1);
  return { seg, line: src.slice(0, i).split('\n').length };
}

/** 最小归一：抹平注释、空行、分号、TS 标注与引号风格 */
function normalize(seg) {
  return seg
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('//'))
    .join('\n')
    .replace(/;$/gm, '')
    .replace(/\(str: string\): string\[\]/g, '(str)')
    .replace(/\(str: string\)/g, '(str)')
    .replace(/const tokens: string\[\] = \[\]/g, 'const tokens = []')
    .replace(/codePointAt\(0\)!/g, 'codePointAt(0)')
    .replace(/"/g, "'");
}

const rel = (p) => relative(REPO, p);

function main() {
  for (const f of [MCP_FILE, QUARTZ_FILE]) {
    if (!existsSync(f)) {
      console.error(`被测文件不存在：${rel(f)}`);
      process.exit(1);
    }
  }

  const a = extract(MCP_FILE);
  const b = extract(QUARTZ_FILE);
  const na = normalize(a.seg);
  const nb = normalize(b.seg);

  console.log('双端分词器一致性校验');
  console.log('─'.repeat(78));
  console.log(`MCP    ${rel(MCP_FILE)}:${a.line}　原文 ${a.seg.length} 字节 · 归一后 ${na.split('\n').length} 行`);
  console.log(`quartz ${rel(QUARTZ_FILE)}:${b.line}　原文 ${b.seg.length} 字节 · 归一后 ${nb.split('\n').length} 行`);

  if (na === nb) {
    console.log('─'.repeat(78));
    console.log('✓ 校验通过：两侧 encoder 在归一后逐字一致');
    return;
  }

  const la = na.split('\n');
  const lb = nb.split('\n');
  console.error('─'.repeat(78));
  console.error('✗ 校验失败：两侧 encoder 已不一致，改一侧必须同步改另一侧');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] === lb[i]) continue;
    console.error(`  归一后第 ${i + 1} 行`);
    console.error(`    MCP    ： ${la[i] === undefined ? '（无此行）' : la[i]}`);
    console.error(`    quartz ： ${lb[i] === undefined ? '（无此行）' : lb[i]}`);
  }
  process.exit(1);
}

main();
