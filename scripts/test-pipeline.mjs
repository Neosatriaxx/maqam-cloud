/* Smoke test for the MAQAM v3 backend AI pipeline (pure tfjs + wasm). */
import fs from 'node:fs';
import path from 'node:path';
import tf from '@tensorflow/tfjs';
import wasm from '@tensorflow/tfjs-backend-wasm';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

wasm.setWasmPaths('node_modules/@tensorflow/tfjs-backend-wasm/dist/');
await tf.setBackend('wasm');
await tf.ready();
console.log('[1] tf backend:', tf.getBackend());

const faceapi = (await import('@vladmandic/face-api/dist/face-api.node-wasm.js')).default;

// ---- mobilenet loader (in-memory, works locally and on serverless) ----
async function loadMobilenetFromDisk(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
  const buffers = [];
  for (const group of manifest.weightsManifest)
    for (const p of group.paths) buffers.push(fs.readFileSync(path.join(dir, p)));
  const weightSpecs = manifest.weightsManifest.flatMap((g) => g.weights);
  const nb = Buffer.concat(buffers);
  // decodeWeights expects a raw ArrayBuffer — a Node Buffer (Uint8Array view) would be copied element-wise!
  const weightData = nb.buffer.slice(nb.byteOffset, nb.byteOffset + nb.byteLength);
  const model = await tf.loadGraphModel(
    tf.io.fromMemory({ modelTopology: manifest.modelTopology, weightSpecs, weightData })
  );
  return model;
}

const MODEL_DIR = 'public/models';
await faceapi.nets.tinyFaceDetector.loadFromDisk(path.join(MODEL_DIR, 'face'));
await faceapi.nets.faceLandmark68TinyNet.loadFromDisk(path.join(MODEL_DIR, 'face'));
await faceapi.nets.faceRecognitionNet.loadFromDisk(path.join(MODEL_DIR, 'face'));
console.log('[2] face models loaded');

const mn = await loadMobilenetFromDisk(path.join(MODEL_DIR, 'mobilenet'));
const graphObj = mn.executor.graph || mn.executor._graph || {};
const nodes = graphObj.nodes ? (Object.keys(graphObj.nodes).length && !Array.isArray(graphObj.nodes) ? Object.values(graphObj.nodes) : graphObj.nodes) : [];
const poolNodes = (Array.isArray(nodes) ? nodes : Object.values(nodes)).filter((n) => n && /pool|reshape|logits/i.test(n.name)).map((n) => `${n.name}:${n.op}`);
console.log('[3] mobilenet loaded; pool-ish nodes:', poolNodes.join(' , ').slice(0, 400));

// build a synthetic 320x240 JPEG (no face on it — we just verify the pipeline runs)
const w = 320, h = 240;
const png = new PNG({ width: w, height: h });
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    const idx = (w * y + x) << 2;
    png.data[idx] = (x / w) * 255; png.data[idx + 1] = (y / h) * 255; png.data[idx + 2] = 120; png.data[idx + 3] = 255;
  }
const rawRgb = Buffer.from(png.data.filter((_, i) => i % 4 !== 3));
const jpgBuf = jpeg.encode({ data: rawRgb, width: w, height: h }, 80).data;

// face pipeline: jpeg-js -> RGBA -> strip alpha to RGB (face-api expects 3 channels)
const dec = jpeg.decode(jpgBuf, { useTArray: true, formatAsRGBA: true });
const rgb = new Uint8Array(dec.width * dec.height * 3);
for (let i = 0, j = 0; i < dec.data.length; i += 4) { rgb[j++] = dec.data[i]; rgb[j++] = dec.data[i + 1]; rgb[j++] = dec.data[i + 2]; }
const imgTensor = tf.tensor3d(rgb, [dec.height, dec.width, 3], 'int32');
const det = await faceapi.detectSingleFace(imgTensor, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }));
console.log('[4] face detect ran, face found (expect none/undefined):', det ? det.score : 'none');

const full = await faceapi.detectSingleFace(imgTensor, new faceapi.TinyFaceDetectorOptions({ inputSize: 320 }))
  .withFaceLandmarks(true).withFaceDescriptor();
console.log('[5] descriptor pipeline ran, descriptor:', full ? Array.from(full.descriptor).slice(0, 4).map((v) => v.toFixed(3)).join(',') + ' …' : 'none (no face in synthetic img — OK)');

// mobilenet embedding: [1,224,224,3] float, output layer = global avg pool
const rgbIn = tf.tidy(() => tf.image.resizeBilinear(tf.slice(imgTensor, [0, 0, 0], [-1, -1, -1]), [224, 224]));
const x = rgbIn.div(127.5).sub(1).expandDims(0);
let poolName = poolNodes.find((n) => n.includes('global_average_pooling'))?.split(':')[0]
  || poolNodes.find((n) => n.includes('avg_pool'))?.split(':')[0];
console.log('[6] using mobilenet layer:', poolName);
const emb = mn.predict(x, { intermediateLayer: poolName ? poolName : undefined });
const shape = emb.shape;
const sum = (await emb.data()).reduce((a, v) => a + Math.abs(v), 0) / emb.size;
console.log('[7] mobilenet embedding shape:', JSON.stringify(shape), '| mean|v|:', sum.toFixed(4));
imgTensor.dispose(); rgbIn.dispose(); x.dispose(); emb.dispose();

console.log('\nPIPELINE OK ✅');
