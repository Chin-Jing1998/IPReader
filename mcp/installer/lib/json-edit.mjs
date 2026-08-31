// lib/json-edit.mjs —— JSON / JSONC 的读—改—写
//
// Cursor、OpenCode、MiMo Code 的配置文件允许注释与尾逗号（JSONC），
// 用严格 JSON.parse 会直接失败；而重新序列化又必然丢掉注释。
// 故本模块的策略是：能宽松解析就解析，但**检出注释即视为不可安全重写**，
// 由调用方决定是报错停止（默认）还是显式放行（--allow-drop-comments）。

/** 解析失败时抛出的错误类型，供调用方区分「文件损坏」与「其他异常」。 */
export class ConfigParseError extends Error {
  constructor(path, cause) {
    super(`配置文件解析失败：${path}\n  ${cause}`);
    this.name = 'ConfigParseError';
    this.path = path;
  }
}

/**
 * 剥离 JSONC 的注释与尾逗号。状态机逐字符扫描，不动字符串字面量内部。
 * @param {string} text
 * @returns {{json:string, hadComments:boolean, hadTrailingComma:boolean}}
 */
export function stripJsonc(text) {
  let out = '';
  let hadComments = false;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      hadComments = true;
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      hadComments = true;
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  // 尾逗号：, 后跟空白再跟 } 或 ]
  const withoutTrailing = out.replace(/,(\s*[}\]])/g, '$1');
  return {
    json: withoutTrailing,
    hadComments,
    hadTrailingComma: withoutTrailing !== out,
  };
}

/**
 * 读取并解析配置文本，同时探测其排版风格以便原样写回。
 * @param {string|null} text 文件内容；null 表示文件不存在
 * @param {string} path 仅用于报错文案
 * @param {object} [opts]
 * @param {*} [opts.fallback] 文件不存在时的初值，缺省 {}
 * @returns {{value:*, indent:number, trailingNewline:boolean,
 *            hadComments:boolean, existed:boolean}}
 */
export function parseConfig(text, path, opts = {}) {
  if (text === null) {
    return {
      value: opts.fallback !== undefined ? opts.fallback : {},
      indent: 2,
      trailingNewline: true,
      hadComments: false,
      existed: false,
    };
  }
  if (text.trim() === '') {
    return {
      value: opts.fallback !== undefined ? opts.fallback : {},
      indent: 2,
      trailingNewline: true,
      hadComments: false,
      existed: true,
    };
  }
  const { json, hadComments } = stripJsonc(text);
  let value;
  try {
    value = JSON.parse(json);
  } catch (e) {
    throw new ConfigParseError(path, e.message);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigParseError(path, '顶层不是对象，拒绝写入');
  }
  return {
    value,
    indent: detectIndent(text),
    trailingNewline: text.endsWith('\n'),
    hadComments,
    existed: true,
  };
}

/** 探测缩进宽度：取首个有前导空格的行。取不到时按 2。 */
export function detectIndent(text) {
  const m = text.match(/\n([ ]+)\S/);
  return m ? m[1].length : 2;
}

/** 按探测到的风格序列化。 */
export function stringifyLike(value, style) {
  const s = JSON.stringify(value, null, style.indent);
  return style.trailingNewline ? `${s}\n` : s;
}

/** 取深路径值。path 为键名数组。 */
export function getDeep(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 设深路径值，沿途缺失的对象逐层补齐。返回是否发生了实际变更。 */
export function setDeep(obj, path, value) {
  const before = JSON.stringify(getDeep(obj, path));
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (cur[k] === null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
  return before !== JSON.stringify(value);
}

/** 删深路径值。返回是否确有删除。 */
export function deleteDeep(obj, path) {
  const parent = getDeep(obj, path.slice(0, -1));
  const key = path[path.length - 1];
  if (parent === null || typeof parent !== 'object' || !(key in parent)) return false;
  delete parent[key];
  return true;
}
