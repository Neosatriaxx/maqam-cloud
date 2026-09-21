'use strict';
/* =====================================================================
   MAQAM v3 — POST /api/detect-face
   Vercel Serverless Function (Node.js)

   Body : { image: dataUrl, geo?: { lat, lng, accuracy, ts } }
   Does : 1. optional geofence re-check (if geo present)
          2. server-side face detection via faceAiLoader.detectOnlyFromDataUrl
          3. if a face is found, also compute the full descriptor via
             faceAiLoader.faceDescriptorFromDataUrl
          4. return { descriptor: number[128], box: {x,y,width,height}, score }
             or { error } if no face / invalid image
   ===================================================================== */

const { handler, readBody, validDataURL, geoCheck } = require('../utils/api-helpers');
const { faceDescriptorFromDataUrl, detectOnlyFromDataUrl } = require('../utils/faceAiLoader');

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metode tidak diizinkan' });

  const body = await readBody(req);
  if (!validDataURL(body.image)) return res.status(400).json({ error: 'Foto tidak valid' });

  if (body.geo) {
    await geoCheck(body.geo); // throws if outside geofence
  }

  const det = await detectOnlyFromDataUrl(body.image);
  if (!det) return res.status(400).json({ error: 'Wajah tidak terdeteksi — hadapkan wajah ke kamera' });

  const full = await faceDescriptorFromDataUrl(body.image);
  const descriptor = (full && full.descriptor && full.descriptor.length === 128)
    ? Array.from(full.descriptor)
    : null;
  const box = det.box;
  const score = det.score;

  res.status(200).json({ descriptor, box, score });
});
