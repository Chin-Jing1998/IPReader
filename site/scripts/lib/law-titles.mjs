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
