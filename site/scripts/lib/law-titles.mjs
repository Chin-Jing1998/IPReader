// 从法规索引 _index.md 解析「第X条（小标题）」→ Map<条号, 小标题>
//   专利法用全角括号「（立法目的）」，实施细则用半角括号「(立法依据)」，两者都兼容。
//   供 parse-domains 把法条节点名从"第二十二条"升级为"第二十二条 · 新颖性、创造性、实用性"。
import { readFileSync } from 'node:fs';
import { cn2num } from './cn-num.mjs';

// 行形如：- **第二十二条**（新颖性、创造性、实用性）：……  /  - **第一条**(立法依据)：……
const LINE_RE = /\*\*第([一二三四五六七八九十百零〇两]+)条\*\*\s*[（(]\s*([^）)]+?)\s*[）)]/;

export function parseLawTitles(indexPath) {
  const map = new Map();
  let text;
  try {
    text = readFileSync(indexPath, 'utf8');
  } catch {
    return map; // 无索引则返回空，调用方回退为纯条号
  }
  for (const line of text.split('\n')) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const num = cn2num(m[1]);
    if (!Number.isFinite(num)) continue;
    const title = m[2].trim();
    if (title && !map.has(num)) map.set(num, title);
  }
  return map;
}

// ============ tmeg（《商标审查审理指南》）专用：按章分组的条旨索引解析 ============
// 阶段5.1 批次 T-4。背景：本域下编 19 章共解读 45 个「第X条」，跨《商标法》《商标法实施条例》
//   《规范商标申请注册行为若干规定》三部法源，同一条号在不同章可指向不同法源、不同条旨——
//   例如下编第二章「第三条」实引《规范商标申请注册行为若干规定》第三条，下编第十章「第三条」
//   实引《商标法实施条例》第三条，二者均非《商标法》第三条。上游 parseLawTitles 的「条号→条旨」
//   单值 Map 只能保留首见值，会把同号异法误按《商标法》取义（改造前实测 8 处错配），
//   故本域的条旨索引改为按章分组、键升为「章序:条号」复合键。
//
// _index.md「## 条旨索引」区块的目标格式（章标题行 = 分组键来源，条旨行格式与通用域一致）：
//   ### 下编·第二章（恶意注册申请）
//
//   - **第四条**（不以使用为目的的恶意注册申请）
//   - **第三条**（申请注册应当遵循诚实信用原则）
//
// 返回 Map<`${下编章序}:第X条`, 条旨>：章序为阿拉伯数字（由章标题行的中文序号转换），
//   条号用行内原文（如「第十三条」），与 nodes.json 节点的 num 字段同形，便于直接查表。
//   解析范围严格限定在「## 条旨索引」到下一个二级标题之间，不波及「层级索引树」等其他区块；
//   同章同号重复时保留首见值（与 parseLawTitles 同口径）。上编无「第X条」节点，故不设编维度。
const TMEG_INDEX_HEAD_RE = /^##\s+条旨索引\s*$/;
const H2_RE = /^##\s+/;
// 章标题行正则：check-law-titles.mjs 判重时按同一口径识别行归属章，故导出共用，避免两处漂移。
export const TMEG_GROUP_RE = /^#{3,6}\s*下编\s*[·・]?\s*第([一二三四五六七八九十百零〇]+)章/;

export function parseTmegGroupedTitles(indexPath) {
  const map = new Map();
  let text;
  try {
    text = readFileSync(indexPath, 'utf8');
  } catch {
    return map; // 无索引则返回空，调用方回退为纯条号
  }
  const lines = text.split('\n');
  const head = lines.findIndex((l) => TMEG_INDEX_HEAD_RE.test(l));
  if (head < 0) return map;
  let chap = null;
  for (let i = head + 1; i < lines.length; i++) {
    const line = lines[i];
    const g = line.match(TMEG_GROUP_RE);
    if (g) {
      const n = cn2num(g[1]);
      chap = Number.isFinite(n) ? n : null;
      continue;
    }
    if (H2_RE.test(line)) break; // 区块到下一个二级标题为止
    const m = line.match(LINE_RE);
    if (!m || chap == null) continue;
    const key = `${chap}:第${m[1]}条`;
    const title = m[2].trim();
    if (title && !map.has(key)) map.set(key, title);
  }
  return map;
}
