'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ruta del binario de ffmpeg: usa FFMPEG_PATH si el usuario puso uno, si no el binario
// estático que viene como dependencia de npm (ffmpeg-static). Así con un `npm install` alcanza
// en cualquier plataforma o panel de hosting, sin ffmpeg del sistema ni tocar el PATH.
const FFMPEG_PATH = process.env.FFMPEG_PATH || require('ffmpeg-static');

// Codifica un archivo de frames crudos (ver framesFile más abajo) con ffmpeg (se llama por ruta
// absoluta, no hace falta que esté en el PATH del sistema). Borra framesFile al terminar.
//
// mp4 (por defecto): H.264 High + yuv420p. Si se pasa audioPath, el wav entra en la misma
// corrida de ffmpeg como AAC-LC estéreo 48 kHz. El filtro pan solo copia el canal mono a los
// dos lados (un -ac 2 común bajaría el nivel 3 dB).
// gif: pasar gif = { width }. Paleta en dos pasos dentro de una sola corrida; width null
// mantiene el tamaño del frame.
// watermark: { pngPath, opacity, overlayExpr } (ver src/watermark.js) - overlay de un PNG con
// transparencia, funciona igual en mp4 y en gif.
// framesFile: un solo archivo con los frames en crudo (BGRA, canvas.toBuffer('raw')) uno atrás
// del otro - lo escribe extractGoalClip.js directo desde el renderer, sin PNGs de por medio (ver
// src/officialRenderer.js). width/height tienen que ser el tamaño exacto de esos frames.
function encodeClip({ framesFile, width, height, outFile, fps, audioPath = null, gif = null, watermark = null }) {
  return new Promise((resolve, reject) => {
    if (audioPath && !fs.existsSync(audioPath)) return reject(new Error('audio file not found: ' + audioPath));

    // orden de inputs: 0 = frames, 1 = watermark (si hay), luego el audio (mp4 únicamente)
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', framesFile,
    ];
    if (watermark) args.push('-i', watermark.pngPath);
    const audioInputIndex = watermark ? 2 : 1;

    const wmChain = watermark
      ? `[1:v]format=rgba,colorchannelmixer=aa=${watermark.opacity}[wm];[0:v][wm]overlay=${watermark.overlayExpr}`
      : null;

    if (gif) {
      const scale = gif.width ? `scale=${gif.width}:-1:flags=lanczos,` : '';
      const video = watermark ? `${wmChain}[v0];[v0]` : '[0:v]';
      const chain = `${video}${scale}split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
      args.push('-filter_complex', chain, '-loop', '0', outFile);
    } else {
      if (audioPath) args.push('-i', audioPath);
      if (watermark) {
        args.push('-filter_complex', `${wmChain}[vout]`, '-map', '[vout]');
      } else {
        args.push('-map', '0:v:0');
      }
      if (audioPath) args.push('-map', `${audioInputIndex}:a:0`);
      args.push('-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '18', '-tag:v', 'avc1');
      if (audioPath) args.push('-c:a', 'aac', '-profile:a', 'aac_low', '-af', 'pan=stereo|c0=c0|c1=c0', '-b:a', '160k', '-ar', '48000', '-shortest');
      args.push('-movflags', '+faststart', outFile);
    }

    const p = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => reject(new Error('could not run ffmpeg (' + FFMPEG_PATH + '): ' + e.message)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg failed:\n' + err));
      if (audioPath && !hasAudio(outFile)) return reject(new Error('mp4 came out without an audio track: ' + outFile));
      fs.rmSync(framesFile, { force: true });
      resolve(outFile);
    });
  });
}

// Saca una miniatura jpg de un mp4 ya codificado, en el segundo `timeS` (por defecto, pensado
// para el instante del gol). Un archivo por clip - no una sola para todo el lote.
function extractPoster(videoFile, timeS, outFile) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, timeS)), '-i', videoFile, '-frames:v', '1', '-q:v', '3', outFile];
    const p = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => reject(new Error('could not run ffmpeg (' + FFMPEG_PATH + '): ' + e.message)));
    p.on('close', (code) => (code !== 0 ? reject(new Error('ffmpeg poster failed:\n' + err)) : resolve(outFile)));
  });
}

// Pone musicFile como pista de fondo debajo del audio que ya tiene videoFile (el mp4 mergeado),
// desde el segundo 0. Si la música es más larga que el video se corta; si es más corta, el
// resto queda en silencio (no se repite en loop). Solo tiene sentido para el video mergeado -
// el proyecto no ofrece esto por clip individual. No recodifica el video (-c:v copy), así que
// es rápido incluso con clips largos.
function mixBackgroundMusic({ videoFile, musicFile, outFile, volume = 0.35 }) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(musicFile)) return reject(new Error('music file not found: ' + musicFile));

    Promise.all([probeInfo(videoFile)]).then(([info]) => {
      if (!info.durationS) return reject(new Error('could not read the duration of ' + videoFile));
      // atrim + apad a la duración exacta del video, en vez de un apad sin límite: ffmpeg-static
      // no trae ffprobe, y un apad infinito atado a -shortest se cuelga en vez de cortar solo
      const music = `[1:a]atrim=0:${info.durationS},apad,volume=${volume}[m]`;
      const filter = info.hasAudio
        ? `${music};[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[aout]`
        : `${music.replace('[m]', '[aout]')}`;
      const args = [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', videoFile, '-i', musicFile,
        '-filter_complex', filter, '-map', '0:v', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', String(info.durationS),
        '-movflags', '+faststart', outFile,
      ];
      const p = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
      p.on('error', (e) => reject(new Error('could not run ffmpeg (' + FFMPEG_PATH + '): ' + e.message)));
      p.on('close', (code) => (code !== 0 ? reject(new Error('ffmpeg music mix failed:\n' + err)) : resolve(outFile)));
    }, reject);
  });
}

// Lee duración y si tiene audio del texto que ffmpeg tira por stderr con "-i" (ffmpeg-static no
// trae ffprobe, así que no hay otra forma liviana de sacar esto sin un binario aparte).
function probeInfo(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let out = '';
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => reject(new Error('could not run ffmpeg (' + FFMPEG_PATH + '): ' + e.message)));
    p.on('close', () => {
      const m = out.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
      const durationS = m ? (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) : null;
      resolve({ durationS, hasAudio: /Stream #\d+:\d+.*Audio:/.test(out) });
    });
  });
}

function hasAudio(file) {
  const r = spawnSync(FFMPEG_PATH, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  return /Stream #\d+:\d+.*Audio:/.test(r.stderr || '');
}

module.exports = { encodeClip, extractPoster, mixBackgroundMusic, probeInfo, FFMPEG_PATH };
