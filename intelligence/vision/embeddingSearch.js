// Lazy-load @xenova/transformers (130MB WASM) — only on first embedding request.
let _transformers = null;
async function getTransformers() {
  if (!_transformers) _transformers = await import("@xenova/transformers");
  return _transformers;
}

let embedder;
const VECTOR_INDEX = new Map();
const MAX_VECTORS = 2500;

async function getEmbedder() {
  if (!embedder) {
    const { pipeline } = await getTransformers();
    embedder = await pipeline(
      "image-feature-extraction",
      "Xenova/clip-vit-base-patch32"
    );
  }
  return embedder;
}

function normalizeVector(vec = []) {
  if (!Array.isArray(vec) || !vec.length) return [];
  let mag = 0;

  for (let i = 0; i < vec.length; i++) {
    const v = Number(vec[i]) || 0;
    mag += v * v;
  }

  mag = Math.sqrt(mag) || 1;

  return vec.map((v) => (Number(v) || 0) / mag);
}

export async function computeImageEmbedding(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return null;
  try {
    const { RawImage } = await getTransformers();
    const model = await getEmbedder();
    // RawImage.fromBlob works in Node.js via sharp; wrap buffer in a Blob
    const blob = new Blob([imageBuffer], { type: "image/jpeg" });
    const image = await RawImage.fromBlob(blob);
    const output = await model(image);
    const data = Array.from(output?.data || []);
    return normalizeVector(data);
  } catch (e) {
    console.warn("computeImageEmbedding failed:", e?.message || e);
    return null;
  }
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (!a.length || !b.length) return 0;

  const len = Math.min(a.length, b.length);

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < len; i++) {
    const av = Number(a[i]) || 0;
    const bv = Number(b[i]) || 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function storeVector(query, vector) {
  const key = String(query || "").trim().toLowerCase();
  if (!key || !Array.isArray(vector) || !vector.length) return false;

  VECTOR_INDEX.set(key, {
    query: key,
    vector: normalizeVector(vector),
    updatedAt: Date.now(),
  });

  if (VECTOR_INDEX.size > MAX_VECTORS) {
    const oldestKey = VECTOR_INDEX.keys().next().value;
    if (oldestKey) VECTOR_INDEX.delete(oldestKey);
  }

  return true;
}

export function nearestVectors(vector, limit = 8) {
  if (!Array.isArray(vector) || !vector.length) return [];
  if (VECTOR_INDEX.size === 0) return [];

  const needle = normalizeVector(vector);

  return [...VECTOR_INDEX.values()]
    .map((entry) => ({
      query: entry.query,
      score: cosineSimilarity(needle, entry.vector),
      updatedAt: entry.updatedAt,
    }))
    .filter((x) => Number.isFinite(x.score) && x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number(limit) || 8));
}
