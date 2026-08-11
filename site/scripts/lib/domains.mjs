// 规范域注册表 + 自动发现
//   把项目根目录下"含 _index.md + 主 md"的每个规范目录视作一个"域"（domain）。
//   数据管线（parse-domains / extract-edges / compute-layout / build-content-shell）据此把
//   多部规范合并进同一张星图：每个域 = 一个星系。
//   设计目标：用户日后在根目录补上新规范目录（如 implementation-rules/），无需改代码，重跑脚本即自动并入。
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 项目根 = site 的上一级（site/scripts → site → 项目根）
export function projectRoot(scriptsDir) {
  return join(scriptsDir, '..', '..');
}

// 已知规范的元数据（数组顺序 = 星系/图例的默认排序；guideline 居首=中央星系）。
//   special:'guideline' 走特例解析（不加前缀、保留 部/章/节/小节 与 826 校验）。
//   lawName 非空者，其"第X条"标题节点会被赋 lawKey，供跨域 lawref 连线锚定。
export const KNOWN_DOMAINS = [
  { key: 'examination-guideline', title: '专利审查指南', short: '审查指南', prefix: '', special: 'guideline' },
  { key: 'patent-law', title: '中华人民共和国专利法', short: '专利法', prefix: 'law', lawName: '专利法' },
  { key: 'implementation-rules', title: '专利法实施细则', short: '实施细则', prefix: 'rule', lawName: '专利法实施细则' },
  { key: 'infringement-guide', title: '专利侵权判定指南', short: '侵权判定', prefix: 'infr' },
  { key: 'mechanical-drafting-rules', title: '机械领域申请文件撰写规范', short: '机械撰写', prefix: 'mech' },
  { key: 'chemistry-drafting-rules', title: '化学领域申请文件撰写规范', short: '化学撰写', prefix: 'chem' },
  { key: 'oa-response-guide', title: '答复审查意见指南', short: '答复指引', prefix: 'oa' },
];

const KNOWN_BY_KEY = new Map(KNOWN_DOMAINS.map((d) => [d.key, d]));

// 目录是否为合格规范域：存在 _index.md 且存在至少一个非 _index 的 .md（主文件）
function mainMdOf(dir, key) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  const mds = files.filter((f) => f.endsWith('.md') && f !== '_index.md');
  if (!mds.length) return null;
  // 优先与目录同名的主文件；否则取首个非 _index 的 .md
  const same = mds.find((f) => f === `${key}.md`);
  return join(dir, same || mds.sort()[0]);
}

function isDomainDir(root, name) {
  if (name === 'site' || name.startsWith('.') || name.startsWith('_')) return false;
  const dir = join(root, name);
  let st;
  try {
    st = statSync(dir);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return false;
  if (!existsSync(join(dir, '_index.md'))) return false;
  return !!mainMdOf(dir, name);
}

function prefixFromKey(key) {
  // 未知规范的默认前缀：取字母数字、截断，保证命名空间 id 不与 guideline 冲突
  const p = key.replace(/[^a-z0-9]/gi, '').slice(0, 4).toLowerCase();
  return p || 'doc';
}

// 发现并返回域列表：先按 KNOWN_DOMAINS 顺序纳入存在者，再追加根目录下其余合格规范目录。
//   每项：{ key, dir, mainMd, prefix, title, short, special?, lawName? }
export function discoverDomains(root) {
  const out = [];
  const seen = new Set();

  for (const meta of KNOWN_DOMAINS) {
    if (!isDomainDir(root, meta.key)) continue;
    const dir = join(root, meta.key);
    out.push({ ...meta, dir, mainMd: mainMdOf(dir, meta.key) });
    seen.add(meta.key);
  }

  let names = [];
  try {
    names = readdirSync(root).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    if (seen.has(name) || !isDomainDir(root, name)) continue;
    const dir = join(root, name);
    out.push({
      key: name,
      title: name,
      short: name.slice(0, 6),
      prefix: prefixFromKey(name),
      dir,
      mainMd: mainMdOf(dir, name),
    });
    seen.add(name);
  }

  return out;
}

export { KNOWN_BY_KEY };
