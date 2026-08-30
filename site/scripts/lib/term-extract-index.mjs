// 术语提取产物索引（D4 共用库）：扫描 data/term-extract/*.json（636 片，只读），
//   把逐片提取记录按"归一化术语名"建索引，供 build-term-nodes（取定义处 evidence 作 summary）
//   与 build-term-content（取各出处 evidence / definition）复用。本模块不写任何文件。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_BY_KEY } from './domains.mjs';

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

// 域 → 法域（专利/商标/著作权/竞争法/品种布图/综合程序）。未登记域回落域名本身，
//   使其自成一档，不会与任何已登记法域混算。
const fieldOfDomain = (domain) => KNOWN_BY_KEY.get(domain)?.field || domain;

// 主域：该词全部提取记录（不分 role）按法域计数的众数。并列第一时返回 null（不施加偏好）。
//   为什么按法域而非按单本书取众数：语料各书体量悬殊（《商标审查审理指南》895 片 >
//   专利七书合计 636 片），按书取众数会让任何在商标指南里被顺带提及的专利术语都判成
//   「商标主域」——实测按书众数会改写 52 条释义，其中「优先权」被改成商标指南的
//   「并要求优先权的」这类残句。按法域聚合后同一法域的多本书合并计数，改写收敛到 13 条。
function mainFieldOf(records) {
  const count = new Map();
  for (const r of records) {
    const f = fieldOfDomain(r.domain);
    count.set(f, (count.get(f) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  let tie = false;
  for (const [f, n] of count) {
    if (n > bestN) {
      best = f;
      bestN = n;
      tie = false;
    } else if (n === bestN) {
      tie = true;
    }
  }
  return tie ? null : best;
}

// 挑"定义处 evidence"：role=defined 优先、confidence 高者优先、**主域（记录数占优的法域）内者优先**、
//   出处落在词表 sources 内者优先、evidence 更长者优先；全部无 defined 记录时返回空串
//   （调用方自行决定兜底策略）。
//
// 主域优先键的动机（2026-08-30 阶段5.11 波H）：同一词面在多个法域各有法定定义时，原排序无从
//   分辨法域，只能比 evidence 长短——term-0027「新颖性」因此被《植物新品种保护条例》的
//   「新颖性，是指申请品种权的植物新品种在申请日前该品种繁殖材料、收获材料未被销售」
//   （较长）顶掉专利法的「新颖性，是指该发明或者实用新型不属于现有技术」（较短），
//   而该词 21 条提取记录里 18 条出自专利法域、仅 3 条出自品种布图。本键即按此事实择优，
//   属通用解：凡「跨法域同名词」皆按记录数占优的法域取定义，不是给单个词打补丁。
//   键位刻意排在 confidence 之后、preferredNodes 之前——置信度是提取质量判断，优先级最高；
//   而 preferredNodes（词表 sources 锚定节点）在跨法域同名词上两侧同时命中，无分辨力。
//   法域计数并列第一时返回 null，排序完全回退到原有次序，行为与波H 之前逐字一致。
export function pickDefinition(index, canonical, aliases = [], preferredNodes = new Set()) {
  const all = recordsOfTerm(index, canonical, aliases);
  const mainField = mainFieldOf(all);
  const inMain = (it) => (mainField && fieldOfDomain(it.domain) === mainField ? 1 : 0);
  const cands = all.filter((it) => it.role === 'defined' && it.evidence);
  cands.sort(
    (a, b) =>
      CONF_RANK[b.confidence] - CONF_RANK[a.confidence] ||
      inMain(b) - inMain(a) ||
      (preferredNodes.has(b.anchorNode) ? 1 : 0) - (preferredNodes.has(a.anchorNode) ? 1 : 0) ||
      b.evidence.length - a.evidence.length ||
      a.chunk.localeCompare(b.chunk),
  );
  return cands[0]?.evidence || '';
}
