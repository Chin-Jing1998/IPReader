// lib/io.mjs —— 文件读写、备份与差异输出
//
// 写入纪律（硬性）：凡寄居 agent 主配置文件的写入，一律「读—改—写 + 写前时间戳备份」。
// 本模块只提供能力，纪律由 index.mjs 统一执行：默认 dry-run，须显式 --write 才落盘。
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 读文本；文件不存在时返回 null（区别于空文件的 ''）。
 * 路径指向目录时同样返回 null——探测点清单里混有目录（如 ~/.zcode、
 * ~/.local/share/mimocode），直接 readFileSync 会抛 EISDIR。
 */
export function readTextIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    if (!statSync(path).isFile()) return null;
  } catch {
    return null;
  }
  return readFileSync(path, 'utf8');
}

/** 路径是否存在（文件或目录皆可），用于 agent 在位探测。 */
export function pathExists(path) {
  return existsSync(path);
}

/**
 * 生成备份文件路径：<原路径>.bak.YYYYMMDD-HHmmss
 * @param {string} path
 * @param {Date} [now] 注入用（测试需要确定性）
 */
export function backupPathFor(path, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${path}.bak.${stamp}`;
}

/**
 * 只备份不改写。用于把写入动作交给外部命令（如 claude mcp add）时的兜底。
 * @returns {string|null} 备份路径；原文件不存在时返回 null
 */
export function backupFile(path, now) {
  if (!existsSync(path)) return null;
  const bak = backupPathFor(path, now);
  copyFileSync(path, bak);
  return bak;
}

/**
 * 落盘：先备份（原文件存在时），再写新内容。
 * @param {string} path
 * @param {string} content
 * @param {object} [opts]
 * @param {Date} [opts.now]
 * @returns {{written:string, backup:string|null}}
 */
export function writeWithBackup(path, content, opts = {}) {
  let backup = null;
  if (existsSync(path)) {
    backup = backupPathFor(path, opts.now);
    copyFileSync(path, backup);
  } else {
    mkdirSync(dirname(path), { recursive: true });
  }
  writeFileSync(path, content, 'utf8');
  return { written: path, backup };
}

/**
 * 统一差异（unified diff）。
 *
 * 先剥离公共前后缀再对中间段做 LCS——~/.claude.json 有 5600 行，
 * 直接全量 LCS 会退化到 3000 万格，剥离后中间段通常只有几行。
 *
 * @param {string|null} before 原内容；null 表示新建文件
 * @param {string} after 新内容
 * @param {string} label 显示用路径
 * @param {number} [context] 上下文行数
 * @returns {string}
 */
export function unifiedDiff(before, after, label, context = 3) {
  const a = before === null ? [] : before.split('\n');
  const b = after.split('\n');

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length === 0 && midB.length === 0) return '';

  const ops = diffLines(midA, midB);

  const out = [`--- ${before === null ? '/dev/null' : label}`, `+++ ${label}`];
  // 只有一个 hunk：中间段加上下文
  const ctxBefore = a.slice(Math.max(0, head - context), head);
  const ctxAfter = a.slice(a.length - tail, Math.min(a.length, a.length - tail + context));
  const aStart = Math.max(0, head - context) + 1;
  const aLen = ctxBefore.length + midA.length + ctxAfter.length;
  const bStart = Math.max(0, head - context) + 1;
  const bLen = ctxBefore.length + midB.length + ctxAfter.length;
  out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
  for (const l of ctxBefore) out.push(` ${l}`);
  for (const op of ops) out.push(`${op[0]}${op[1]}`);
  for (const l of ctxAfter) out.push(` ${l}`);
  return out.join('\n');
}

/** 朴素 LCS 行级差异，返回 [标记, 行] 序列。仅用于剥离公共前后缀后的中间段。 */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    // 中间段仍然巨大时退化为「整段删 + 整段增」，避免内存爆炸
    return [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([' ', a[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(['-', a[i]]);
      i++;
    } else {
      ops.push(['+', b[j]]);
      j++;
    }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}
