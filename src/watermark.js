'use strict';

// Prepara el PNG de la marca de agua (texto o logo) y sus coordenadas para el overlay de
// ffmpeg. El texto se renderiza una sola vez con node-canvas a un PNG con fondo transparente -
// evitamos el filtro drawtext de ffmpeg porque el binario de ffmpeg-static no trae freetype
// garantizado en todas las plataformas.
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

const POSITIONS = {
  'bottom-right': (m) => `W-w-${m}:H-h-${m}`,
  'bottom-left': (m) => `${m}:H-h-${m}`,
  'top-right': (m) => `W-w-${m}:${m}`,
  'top-left': (m) => `${m}:${m}`,
};

// videoWidth/videoHeight: tamaño del clip, para calcular un margen y un tamaño de letra a escala
function prepareWatermark({ text, imagePath, position = 'bottom-right', opacity = 0.7, scale = 0.12, videoWidth, videoHeight, workDir }) {
  if (!text && !imagePath) return null;
  if (!POSITIONS[position]) throw new Error(`unknown watermark position "${position}", use ${Object.keys(POSITIONS).join('|')}`);
  if (!(opacity > 0 && opacity <= 1)) throw new Error('watermark opacity has to be above 0 and up to 1');

  let pngPath = imagePath;
  if (imagePath && !fs.existsSync(imagePath)) throw new Error(`watermark image not found: ${imagePath}`);

  if (!imagePath) {
    const fontPx = Math.max(12, Math.round(videoHeight * 0.035));
    const padding = Math.round(fontPx * 0.5);
    const measure = createCanvas(1, 1).getContext('2d');
    measure.font = `bold ${fontPx}px sans-serif`;
    const textWidth = Math.ceil(measure.measureText(text).width);

    const canvas = createCanvas(textWidth + padding * 2, fontPx + padding * 2);
    const ctx = canvas.getContext('2d');
    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000000';
    ctx.globalAlpha = 0.55;
    ctx.fillText(text, padding + 1, canvas.height / 2 + 1); // sombra sutil para que se lea en fondos claros
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, padding, canvas.height / 2);

    pngPath = path.join(workDir, 'watermark.png');
    fs.writeFileSync(pngPath, canvas.toBuffer('image/png'));
  }

  const margin = Math.max(4, Math.round(videoWidth * 0.02));
  return { pngPath, opacity, overlayExpr: POSITIONS[position](margin), ownsFile: !imagePath };
}

module.exports = { prepareWatermark, WATERMARK_POSITIONS: Object.keys(POSITIONS) };
