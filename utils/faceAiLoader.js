'use strict';
/* =====================================================================
   MAQAM v3 — faceAiLoader.js
   Server-side AI singleton for Vercel serverless functions.

   Loads ONE of two @vladmandic/face-api builds:
     1. face-api.node.js        (native @tensorflow/tfjs-node — fastest, needs tfjs-node)
     2. face-api.node-wasm.js   (pure-JS tfjs + wasm backend — zero native deps)

   Detection is automatic: if tfjs-node is importable it is used, otherwise wasm.
   On Vercel the wasm path is the safe default — no native binaries to ship,
   and the function stays far below the 50 MB limit.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const tf = require('@tensorflow/tfjs');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

/* ------------------------------------------------------------------ */
/* tf backend                                                          */
/* ------------------------------------------------------------------ */
let backendReady = false;
function hasTfjsNode() {
  try { require.resolve('@tensorflow/tfjs-node'); return true; } catch (e) { return false; }
}
function setupWasm() {
  const wasm = require('@tensorflow/tfjs-backend-wasm');
  let base;
  if (process.env.VERCEL) {
    // Serverless: serve the wasm binaries from a CDN pinned to the npm version.
    const ver = require('@tensorflow/tfjs-backend-wasm/package.json').version;
    base = `https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@${ver}/dist/`;
  } else {
    base = path.join(process.cwd(), 'node_modules/@tensorflow/tfjs-backend-wasm/dist') + path.sep;
  }
  wasm.setWasmPaths(base);
  return wasm;
}
async function ensureBackend() {
  if (backendReady) return;
  if (!hasTfjsNode()) {
    setupWasm();
    await tf.setBackend('wasm');
  }
  await tf.ready();
  backendReady = true;
}

/* ------------------------------------------------------------------ */
/* image decoding (replaces the `canvas` package — no native deps)     */
/* ------------------------------------------------------------------ */
function decodeImageToTensor(buf) {
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
  let rgba, w, h;
  if (isPng) {
    const png = PNG.sync.read(buf);
    rgba = png.data; w = png.width; h = png.height;
  } else {
    const dec = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    rgba = dec.data; w = dec.width; h = dec.height;
  }
  // strip alpha -> RGB tensor3d (face-api expects 3 channels)
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4) {
    rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2];
  }
  return tf.tensor3d(rgb, [h, w, 3], 'int32');
}
async function decodeDataUrlToTensor(dataUrl) {
  const b64 = String(dataUrl).split(',')[1];
  if (!b64) throw new Error('data URL tidak valid');
  return decodeImageToTensor(Buffer.from(b64, 'base64'));
}

/* ------------------------------------------------------------------ */
/* model location: /api functions are traced with public/models/**     */
/* so the weights sit next to the bundle at <bundle>/public/models     */
/* ------------------------------------------------------------------ */
function modelsDir() {
  const candidates = [
    process.env.MAQAM_MODELS_DIR,                       // explicit override
    path.join(process.cwd(), 'public/models'),          // vercel dev / local
    path.join(__dirname, '..', 'public/models'),        // bundled trace layout
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'face', 'tiny_face_detector_model-weights_manifest.json'))) return c;
  }
  throw new Error('Folder model AI tidak ditemukan — cek includeFiles di vercel.json');
}

/* ------------------------------------------------------------------ */
/* singletons                                                          */
/* ------------------------------------------------------------------ */
let faceP = null;
async function getFaceApi() {
  if (faceP) return faceP;
  faceP = (async () => {
    await ensureBackend();
    const faceapi = hasTfjsNode()
      ? require('@vladmandic/face-api/dist/face-api.node.js')
      : require('@vladmandic/face-api/dist/face-api.node-wasm.js');
    const dir = path.join(modelsDir(), 'face');
    await faceapi.nets.tinyFaceDetector.loadFromDisk(dir);
    await faceapi.nets.faceLandmark68TinyNet.loadFromDisk(dir);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(dir);
    return faceapi;
  })().catch((e) => { faceP = null; throw e; });
  return faceP;
}

let mnP = null;
async function getMobilenet() {
  if (mnP) return mnP;
  mnP = (async () => {
    await ensureBackend();
    const dir = path.join(modelsDir(), 'mobilenet');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
    const bufs = [];
    for (const g of manifest.weightsManifest) for (const p of g.paths) bufs.push(fs.readFileSync(path.join(dir, p)));
    const nb = Buffer.concat(bufs);
    // decodeWeights expects a raw ArrayBuffer (a Node Buffer view would be copied element-wise)
    const weightData = nb.buffer.slice(nb.byteOffset, nb.byteOffset + nb.byteLength);
    const model = await tf.loadGraphModel(
      tf.io.fromMemory({ modelTopology: manifest.modelTopology, weightSpecs: manifest.weightsManifest.flatMap((g) => g.weights), weightData })
    );
    return model;
  })().catch((e) => { mnP = null; throw e; });
  return mnP;
}

/* ------------------------------------------------------------------ */
/* high-level helpers                                                  */
/* ------------------------------------------------------------------ */
/** returns { descriptor: number[128], box, score } or null if no face */
async function faceDescriptorFromDataUrl(dataUrl, inputSize = 416) {
  const faceapi = await getFaceApi();
  const img = await decodeDataUrlToTensor(dataUrl);
  try {
    const out = await faceapi
      .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.3 }))
      .withFaceLandmarks(true).withFaceDescriptor();
    if (!out) return null;
    const box = out.detection ? out.detection.box : out.box;
    const score = out.detection ? out.detection.score : out.score;
    return { descriptor: Array.from(out.descriptor), box: { x: box.x, y: box.y, width: box.width, height: box.height }, score };
  } finally { img.dispose(); }
}

/** returns { score, box } or null — lightweight "is there a face?" check */
async function detectOnlyFromDataUrl(dataUrl, inputSize = 416) {
  const faceapi = await getFaceApi();
  const img = await decodeDataUrlToTensor(dataUrl);
  try {
    const out = await faceapi.detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.3 }));
    if (!out) return null;
    const box = out.detection ? out.detection.box : out.box;
    const score = out.detection ? out.detection.score : out.score;
    return { score, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
  } finally { img.dispose(); }
}

/** L2-normalized mobilenet embedding from a data URL (scene verification) */
async function sceneEmbeddingFromDataUrl(dataUrl) {
  const model = await getMobilenet();
  const img = await decodeDataUrlToTensor(dataUrl);
  let x = null, out = null;
  try {
    x = tf.tidy(() => tf.image.resizeBilinear(img, [224, 224]).div(127.5).sub(1).expandDims(0));
    // Graph-model mobilenet: use the global_pool node output (pre-logits embedding).
    const nodeNames = model.executor.graph ? Object.keys(model.executor.graph.nodes || {}) : [];
    const poolName = nodeNames.find((n) => /Logits\/global_pool$/.test(n))
      || nodeNames.find((n) => /global_average_pooling2d|global_pool|avg_pool/.test(n));
    out = poolName ? model.execute(x, poolName, false) : model.predict(x);
    const flat = out.shape.length > 2 ? tf.tidy(() => out.mean([1, 2])) : out;
    const arr = await flat.data();
    // L2-normalize so similarity is plain cosine/inner-product
    let n = 0; for (const v of arr) n += v * v; n = Math.sqrt(n) || 1;
    const vec = Array.from(arr, (v) => v / n);
    tf.dispose([img, x, out]);
    if (flat !== out) flat.dispose();
    return vec;
  } catch (e) {
    try { img.dispose(); } catch (e2) {}
    try { if (x) x.dispose(); } catch (e2) {}
    try { if (out) out.dispose(); } catch (e2) {}
    throw e;
  }
}

/** cosine similarity between two L2-normalized vectors */
function cosine(a, b) {
  let s = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
/** euclidean distance between two 128-d face descriptors */
function euclid(a, b) {
  let s = 0;
  for (let i = 0; i < 128; i++) { const t = a[i] - b[i]; s += t * t; }
  return Math.sqrt(s);
}

module.exports = {
  getFaceApi, getMobilenet, modelsDir, ensureBackend,
  decodeImageToTensor, decodeDataUrlToTensor,
  faceDescriptorFromDataUrl, detectOnlyFromDataUrl, sceneEmbeddingFromDataUrl,
  cosine, euclid,
};
