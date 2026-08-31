// lib/yaml-edit.mjs —— Hermes Agent 的 config.yaml 块级编辑
//
// 为什么不引 YAML 库、也不做完整解析再序列化：
//   ~/.hermes/config.yaml 是 Hermes 的**主配置文件**（本机实测 684 行、37 个顶层键，
//   含模型、供应商、密钥引用、平台工具集等），整体反序列化再写回必然重排键序、
//   丢失注释与引号风格，对用户是不可接受的破坏。
//   本模块因此只做「按缩进定位 `mcp_servers:` 顶层块内的某个二级键，替换/插入/删除
//   该键所辖的行区间」，文件其余部分逐字节保持原样。
//
// 前置校验（任一不满足即报错停止，绝不写入）：
//   1. 不得含 Tab 缩进（YAML 禁 Tab，混用会改变语义）；
//   2. `mcp_servers:` 必须是顶层键且其值为块映射（不是 inline 的 `{...}`）；
//   3. 官方明示的常见错误写法 `mcp: \n  servers:` 存在时给出告警。

export class YamlEditError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'YamlEditError';
  }
}

const TOP_KEY_RE = /^([A-Za-z_][A-Za-z0-9_.\-]*):(.*)$/;

/** 是否为空行或整行注释。 */
const isBlank = (l) => l.trim() === '' || /^\s*#/.test(l);

/**
 * 定位顶层块。
 * @param {string[]} lines
 * @param {string} key 顶层键名
 * @returns {{keyIdx:number, bodyStart:number, bodyEnd:number, childIndent:number,
 *            inline:boolean}|null} bodyEnd 为开区间上界
 */
export function findTopBlock(lines, key) {
  let keyIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TOP_KEY_RE);
    if (m && m[1] === key) {
      keyIdx = i;
      break;
    }
  }
  if (keyIdx < 0) return null;
  const rest = lines[keyIdx].slice(key.length + 1).trim();
  const inline = rest !== '' && !rest.startsWith('#');

  let bodyEnd = lines.length;
  for (let i = keyIdx + 1; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    if (TOP_KEY_RE.test(lines[i])) {
      bodyEnd = i;
      break;
    }
  }
  // 回退掉块尾的空行，插入点定在最后一条实质内容之后
  while (bodyEnd - 1 > keyIdx && isBlank(lines[bodyEnd - 1])) bodyEnd--;

  let childIndent = 2;
  for (let i = keyIdx + 1; i < bodyEnd; i++) {
    if (isBlank(lines[i])) continue;
    childIndent = lines[i].match(/^ */)[0].length;
    break;
  }
  return { keyIdx, bodyStart: keyIdx + 1, bodyEnd, childIndent, inline };
}

/**
 * 列出块内的二级键及其行区间。
 * @returns {{name:string, start:number, end:number}[]} end 为开区间上界
 */
export function listChildren(lines, block) {
  const pad = ' '.repeat(block.childIndent);
  const re = new RegExp(`^${pad}([A-Za-z0-9_.\\-]+):`);
  const found = [];
  for (let i = block.bodyStart; i < block.bodyEnd; i++) {
    const m = lines[i].match(re);
    if (m) found.push({ name: m[1], start: i, end: block.bodyEnd });
  }
  for (let k = 0; k < found.length - 1; k++) {
    let end = found[k + 1].start;
    while (end - 1 > found[k].start && isBlank(lines[end - 1])) end--;
    found[k].end = end;
  }
  return found;
}

/** 通篇前置校验。 */
function assertEditable(text, topKey) {
  const warnings = [];
  if (/^\t| \t/m.test(text)) {
    throw new YamlEditError('配置文件含 Tab 缩进，YAML 语义有歧义，拒绝自动编辑');
  }
  const lines = text.split('\n');
  const block = findTopBlock(lines, topKey);
  if (block && block.inline) {
    throw new YamlEditError(
      `顶层键 ${topKey} 的值为行内写法（如 {} 或引用），本工具只支持块映射，拒绝自动编辑`,
    );
  }
  const wrong = findTopBlock(lines, 'mcp');
  if (wrong) {
    warnings.push(
      '检测到顶层键 mcp:——Hermes 只识别顶层 mcp_servers:，mcp.servers 形式不会生效，请人工核对',
    );
  }
  return { lines, block, warnings };
}

/** YAML 标量转写：路径与普通标识符裸写，其余单引号包裹。 */
export function yamlScalar(v) {
  const s = String(v);
  const bare =
    /^[A-Za-z0-9_/][A-Za-z0-9_./+\-一-鿿]*$/.test(s) &&
    !/^(true|false|null|yes|no|on|off|~)$/i.test(s) &&
    !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s);
  return bare ? s : `'${s.replace(/'/g, "''")}'`;
}

/**
 * 插入或替换二级块（幂等：已存在同名键时整段替换，不产生重复条目）。
 * @param {string} text 原文
 * @param {string} topKey 顶层键
 * @param {string} childName 二级键名
 * @param {string[]} childLines 以「childName:」开头、内部缩进 2 空格的相对行
 * @returns {{text:string, action:'insert'|'update'|'noop', warnings:string[]}}
 */
export function upsertChild(text, topKey, childName, childLines) {
  const { lines, block, warnings } = assertEditable(text, topKey);
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? lines.slice(0, -1) : lines;

  if (!block) {
    // 顶层块不存在：追加到文件末尾
    const added = [`${topKey}:`, ...childLines.map((l) => (l ? `  ${l}` : l))];
    const next = [...body, ...added];
    return {
      text: next.join('\n') + (trailingNewline ? '\n' : ''),
      action: 'insert',
      warnings: [...warnings, `顶层键 ${topKey}: 原本不存在，已在文件末尾新建`],
    };
  }

  const pad = ' '.repeat(block.childIndent);
  const rendered = childLines.map((l) => (l ? `${pad}${l}` : l));
  const children = listChildren(body, findTopBlock(body, topKey));
  const hit = children.find((c) => c.name === childName);

  let next;
  let action;
  if (hit) {
    const old = body.slice(hit.start, hit.end);
    if (old.join('\n') === rendered.join('\n')) {
      return { text, action: 'noop', warnings };
    }
    next = [...body.slice(0, hit.start), ...rendered, ...body.slice(hit.end)];
    action = 'update';
  } else {
    const at = findTopBlock(body, topKey).bodyEnd;
    next = [...body.slice(0, at), ...rendered, ...body.slice(at)];
    action = 'insert';
  }
  return { text: next.join('\n') + (trailingNewline ? '\n' : ''), action, warnings };
}

/**
 * 删除二级块。
 * @returns {{text:string, action:'remove'|'noop', warnings:string[]}}
 */
export function removeChild(text, topKey, childName) {
  const { warnings } = assertEditable(text, topKey);
  const trailingNewline = text.endsWith('\n');
  const all = text.split('\n');
  const body = trailingNewline ? all.slice(0, -1) : all;
  const block = findTopBlock(body, topKey);
  if (!block) return { text, action: 'noop', warnings };
  const hit = listChildren(body, block).find((c) => c.name === childName);
  if (!hit) return { text, action: 'noop', warnings };
  const next = [...body.slice(0, hit.start), ...body.slice(hit.end)];
  return { text: next.join('\n') + (trailingNewline ? '\n' : ''), action: 'remove', warnings };
}

/** 读取块内是否已有该二级键，以及其原始文本（供 --list 展示）。 */
export function readChild(text, topKey, childName) {
  const lines = text.split('\n');
  const block = findTopBlock(lines, topKey);
  if (!block) return null;
  const hit = listChildren(lines, block).find((c) => c.name === childName);
  if (!hit) return null;
  return lines.slice(hit.start, hit.end).join('\n');
}

/**
 * 把 server 规范模型渲染为 Hermes 的二级块行（相对缩进，内部 2 空格）。
 *
 * Hermes 不继承父进程环境，只透传显式声明的 env 加一组安全基线——
 * 因此 env 必须写全，且 command 必须是绝对路径。
 */
export function renderServerBlock(spec) {
  const out = [`${spec.name}:`, `  command: ${yamlScalar(spec.command)}`];
  if (spec.args.length) {
    out.push('  args:');
    for (const a of spec.args) out.push(`    - ${yamlScalar(a)}`);
  }
  const envKeys = Object.keys(spec.env);
  if (envKeys.length) {
    out.push('  env:');
    for (const k of envKeys) out.push(`    ${k}: ${yamlScalar(spec.env[k])}`);
  }
  out.push('  enabled: true');
  return out;
}
