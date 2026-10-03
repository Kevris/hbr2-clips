'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { FFMPEG_PATH, probeInfo } = require('./framesToVideo');

// Transiciones entre clips (las de xfade de ffmpeg que mejor quedan en un resumen de goles).
// 'fadeblack' (default) baja a negro y sube al clip siguiente, separa bien un gol de otro;
// 'fade' los funde directamente; 'none' los pega en seco, sin recodificar.
const TRANSITIONS = ['none', 'fadeblack', 'fade', 'fadewhite', 'dissolve', 'wipeleft', 'wiperight', 'slideleft', 'slideright'];

function runFfmpeg(args, what) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => reject(new Error(`could not run ffmpeg (${FFMPEG_PATH}): ${e.message}`)));
    p.on('close', (code) => (code !== 0 ? reject(new Error(`ffmpeg ${what} failed:\n${err}`)) : resolve()));
  });
}

// Pegado en seco: todos los clips comparten códec / resolución / fps (así sale todo lo que produce
// encodeClip), así que el demuxer concat copia los streams sin recodificar (rápido, sin pérdida).
async function concatCopy(files, outFile) {
  const listFile = path.join(os.tmpdir(), `hbr2clips-merge-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(listFile, files.map((f) => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile], 'merge');
  } finally {
    fs.rmSync(listFile, { force: true });
  }
}

// Une clips en un solo mp4, en el orden dado, con una transición de `transitionS` segundos entre
// uno y otro (el audio se funde igual). Con transición hay que recodificar: es un paso más lento que
// pegarlos, pero son clips cortos. Los clips se solapan durante la transición, así que el resultado
// dura la suma de los clips menos transitionS por cada unión.
async function mergeClips(files, outFile, { transition = 'none', transitionS = 0.5 } = {}) {
  if (!files.length) throw new Error('no clips to merge');
  if (!TRANSITIONS.includes(transition)) throw new Error(`unknown transition "${transition}", use ${TRANSITIONS.join(', ')}`);
  if (files.length < 2 || transition === 'none' || !(transitionS > 0)) return concatCopy(files, outFile).then(() => outFile);

  const infos = await Promise.all(files.map((f) => probeInfo(f)));
  if (infos.some((i) => !i.durationS)) throw new Error('could not read the duration of a clip to merge');
  const audio = infos.every((i) => i.hasAudio);
  // la transición no puede ser más larga que casi la mitad del clip más corto
  const D = Math.min(transitionS, 0.45 * Math.min(...infos.map((i) => i.durationS)));

  const parts = [];
  let v = '[0:v]', a = '[0:a]', acc = infos[0].durationS;
  for (let k = 1; k < files.length; k++) {
    const last = k === files.length - 1;
    const vo = last ? '[vout]' : `[v${k}]`;
    parts.push(`${v}[${k}:v]xfade=transition=${transition}:duration=${D.toFixed(3)}:offset=${(acc - D).toFixed(3)}${vo}`);
    v = vo;
    if (audio) {
      const ao = last ? '[aout]' : `[a${k}]`;
      parts.push(`${a}[${k}:a]acrossfade=d=${D.toFixed(3)}:c1=tri:c2=tri${ao}`);
      a = ao;
    }
    acc += infos[k].durationS - D; // lo que dura lo unido hasta acá
  }

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const f of files) args.push('-i', f);
  args.push('-filter_complex', parts.join(';'), '-map', '[vout]');
  if (audio) args.push('-map', '[aout]');
  args.push('-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '18', '-tag:v', 'avc1');
  if (audio) args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000');
  args.push('-movflags', '+faststart', outFile);
  await runFfmpeg(args, 'merge with transitions');
  return outFile;
}

module.exports = { mergeClips, TRANSITIONS };
