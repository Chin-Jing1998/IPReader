// 本地中文 embedding 封装（transformers.js + bge-m3）。
//   设计原则：可降级——依赖未安装 / 模型下载失败时返回 null，调用方自动退回纯规则核查，脚本永不崩。
//   bge-m3：8192 token 上下文（不截断长法规）、cls pooling、归一化后点积即余弦。MIT 许可、Node 端走原生 onnxruntime-node。
const MODEL_ID = 'Xenova/bge-m3';
const DTYPE = 'q8'; // q8≈570MB，质量足够做相关性核查；如需更高质量改 'fp16'

let _extractor = null;
let _failed = false;

// 懒加载模型管线；失败只告警一次并置 _failed，后续直接返回 null。
export async function getEmbedder() {
  if (_extractor) return _extractor;
  if (_failed) return null;
  try {
    const mod = await import('@huggingface/transformers').catch(() => import('@xenova/transformers'));
    const { pipeline } = mod;
    process.stdout.write(`[embed] 加载本地模型 ${MODEL_ID}（首次需联网下载，约 ${DTYPE} 量级）…\n`);
    _extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: DTYPE });
    process.stdout.write('[embed] 模型就绪。\n');
    return _extractor;
  } catch (err) {
    console.warn(`[embed] 本地 embedding 不可用，降级为纯规则核查。原因：${err?.message ?? err}`);
    _failed = true;
    return null;
  }
}

// 批量向量化；返回 number[][]（已 L2 归一化）或 null（不可用时）。
export async function embedTexts(texts, { batchSize = 12 } = {}) {
  const extractor = await getEmbedder();
  if (!extractor) return null;
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await extractor(batch, { pooling: 'cls', normalize: true });
    for (const v of res.tolist()) out.push(v);
    process.stdout.write(`\r[embed] 向量化 ${Math.min(i + batchSize, texts.length)}/${texts.length}`);
  }
  process.stdout.write('\n');
  return out;
}

// 余弦相似度（输入已归一化 → 点积即可）。
export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export { MODEL_ID };
