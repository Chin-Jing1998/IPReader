// 术语提取产物索引（D4 共用库）：扫描 data/term-extract/*.json（636 片，只读），
//   把逐片提取记录按"归一化术语名"建索引，供 build-term-nodes（取定义处 evidence 作 summary）
//   与 build-term-content（取各出处 evidence / definition）复用。本模块不写任何文件。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 归一化：与 merge-terms.mjs / build-seed-lexicon.mjs 同口径（NFKC 全半角 / 去空白 / 小写）
export const normTerm = (s) => (s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

// 置信度排序权重
const CONF_RANK = { high: 2, mid: 1, low: 0 };

// 扫描提取目录 → { byNorm: Map(归一名 → [记录]), files: 成功解析的文件数 }
//   记录 = { chunk, domain, anchorNode, name, role, confidence, evidence }
//   同一条记录若带 aliases，会以各别名再登记一次（指向同一对象），便于按词表 canonical/alias 任一命中。
export function loadTermExtractIndex(extractDir) {
  const byNorm = new Map();
  let files = 0;
  if (!existsSync(extractDir)) return { byNorm, files };
  for (const f of readdirSync(extractDir).filter((x) => x.endsWith('.json')).sort()) {
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(extractDir, f), 'utf8'));
    } catch {
      continue; // 单片损坏不阻塞整体（merge-terms 已另行统计）
    }
    files++;
    const chunk = rec.chunk || f.replace(/\.json$/, '').split('__').join('/');
    const domain = chunk.split('/')[0];
    for (const t of rec.terms || []) {
      const item = {
        chunk,
        domain,
        anchorNode: rec.anchorNode || null,
        name: String(t.name || '').trim(),
        role: t.role === 'defined' ? 'defined' : 'used',
        confidence: t.confidence === 'high' || t.confidence === 'mid' ? t.confidence : 'low',
        evidence: typeof t.evidence === 'string' ? t.evidence.trim() : '',
      };
      const keys = new Set([normTerm(item.name), ...(t.aliases || []).map((a) => normTerm(String(a)))]);
      for (const k of keys) {
        if (!k) continue;
        if (!byNorm.has(k)) byNorm.set(k, []);
        byNorm.get(k).push(item);
      }
    }
  }
  return { byNorm, files };
}

// 收集某词（canonical + aliases）命中的全部提取记录（按对象去重，保持扫描顺序）
export function recordsOfTerm(index, canonical, aliases = []) {
  const out = [];
  const seen = new Set();
  for (const key of [normTerm(canonical), ...aliases.map((a) => normTerm(a))]) {
    for (const it of index.byNorm.get(key) || []) {
      if (seen.has(it)) continue;
      seen.add(it);
      out.push(it);
    }
  }
  return out;
}

// 挑"定义处 evidence"：role=defined 优先、confidence 高者优先、出处落在词表 sources 内者优先、
//   evidence 更长者优先；全部无 defined 记录时返回空串（调用方自行决定兜底策略）。
export function pickDefinition(index, canonical, aliases = [], preferredNodes = new Set()) {
  const cands = recordsOfTerm(index, canonical, aliases).filter((it) => it.role === 'defined' && it.evidence);
  cands.sort(
    (a, b) =>
      CONF_RANK[b.confidence] - CONF_RANK[a.confidence] ||
      (preferredNodes.has(b.anchorNode) ? 1 : 0) - (preferredNodes.has(a.anchorNode) ? 1 : 0) ||
      b.evidence.length - a.evidence.length ||
      a.chunk.localeCompare(b.chunk),
  );
  return cands[0]?.evidence || '';
}
