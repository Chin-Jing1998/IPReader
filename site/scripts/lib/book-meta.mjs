// 从各域 _index.md 顶部的 front matter 解析书目元信息 → 普通对象（阶段5.3 批次 W1，D2 上游）
//   与 lib/law-titles.mjs 同风格：**行式解析、零依赖**，不引入 yaml 解析库。
//   全库 88 域实测（2026-08-25）：每域 _index.md 首行均为 `---`、均有闭合 `---`，
//   围栏内 100% 为单行 `key: value`，无列表项、无续行、无块标量，故行式解析足够且无损。
//
// 解析口径：
//   ① 键名：`^[A-Za-z_][A-Za-z0-9_-]*` —— 不匹配者整行跳过（正文行、注释行不会被误收）。
//   ② 分割：按**第一个冒号**切分，冒号之后（含后续冒号）全部归入值。
//      必要性实测：source_ref 值形如 https://www.cnipa.gov.cn/...（含 `://`）、
//      sliced_at 值形如 2026-08-09T06:17:36.923Z（含 2 个冒号）、
//      structure 值形如「六级树：编·部分(…)」（含中文全角冒号与半角冒号混排）。
//   ③ 值：先 trim，再剥去**成对**的首尾引号（"…" 或 '…'），剥后再 trim。
//      只剥最外层一对，内层引号原样保留 —— 如 gb-standards-index 的
//      effective_date: "不适用（多项标准各自实施日期见清单表内'实施日期'列，详见正文）"
//      解析后为「不适用（多项标准各自实施日期见清单表内'实施日期'列，详见正文）」，内层单引号不动。
//   ④ 键名转 camelCase：仅在 `_`/`-` 分隔处提升后一字符，不整体小写
//      （避免将来出现 sourceURL 一类混合大小写键被压平）。document_no → documentNo、
//      judicial_interpretation_no → judicialInterpretationNo。
//   ⑤ 缺失/空一律 ''：返回对象恒含 CANONICAL_KEYS 全部键（缺者为空串），
//      源文件另有的键（source / structure / body_chars / domain_key / article_count 等）一并收录。
//      文件读不到、首行非 `---`、围栏未闭合三种情形，均返回「全 '' 的规范键集」而不抛错。
import { readFileSync } from 'node:fs';

// 规范键位：无论源 _index.md 是否登记，返回对象恒含以下键，使下游（data/book-meta.json 消费方）
//   拿到稳定形状、无需逐键判存。取自全库 88 域实测键频（title 81/88、effective_date 80/88、
//   adopted_date 65/88、document_no 55/88、judicial_interpretation_no 25/88、
//   source_ref 15/88、issued_by 与 issued_year 各 2/88，其余为 0 或非元信息键）。
export const CANONICAL_KEYS = [
  'title',
  'manifestTitle',
  'documentNo',
  'judicialInterpretationNo',
  'adoptedDate',
  'effectiveDate',
  'status',
  'issuedBy',
  'issuedYear',
  'sourceUrl',
  'sourceRef',
  'fetchedAt',
  'originFile',
];

const FENCE = '---';
const KV_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/; // 贪婪 `.*` 保证第一个冒号之后全归值

function toCamel(key) {
  return key.replace(/[_-]+([A-Za-z0-9])/g, (_, c) => c.toUpperCase()).replace(/[_-]+$/, '');
}

function unquote(raw) {
  const s = raw.trim();
  if (s.length >= 2) {
    const a = s[0];
    const z = s[s.length - 1];
    if ((a === '"' && z === '"') || (a === "'" && z === "'")) return s.slice(1, -1).trim();
  }
  return s;
}

export function readIndexFrontmatter(indexMdAbsPath) {
  const out = {};
  for (const k of CANONICAL_KEYS) out[k] = '';

  let text;
  try {
    text = readFileSync(indexMdAbsPath, 'utf8');
  } catch {
    return out; // 无 _index.md → 全 ''
  }

  const lines = text.split('\n');
  if (!lines.length || lines[0].trim() !== FENCE) return out; // 无 front matter 围栏
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FENCE) {
      end = i;
      break;
    }
  }
  if (end < 0) return out; // 围栏未闭合，按无 front matter 处理

  for (let i = 1; i < end; i++) {
    const m = lines[i].match(KV_RE);
    if (!m) continue;
    out[toCamel(m[1])] = unquote(m[2]);
  }
  return out;
}
