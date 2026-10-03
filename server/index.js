'use strict';

try { require('dotenv').config(); } catch { /* .env es opcional: si no está instalado dotenv, simplemente no se usa .env */ }

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { extractGoalClips, listReplayData, readGoalIndex } = require('../src/extractGoalClip');
const { selectGoals } = require('../src/select');
const { TRANSITIONS } = require('../src/mergeClips');
const { createLimiter } = require('./limiter');
const store = require('./store');

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);
const MAX_CONCURRENT_RENDERS = Number(process.env.MAX_CONCURRENT_RENDERS || 2);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'; // en producción, poné el origen de tu sitio

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });
const limit = createLimiter(MAX_CONCURRENT_RENDERS);
store.startCleanup();

const app = express();
app.use(express.json());
app.use((req, res, next) => { // CORS mínimo para que una página en otro origen pueda llamar esto
  res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const TICK_RATE = 60;
// goles tal como los devuelve listReplayData (ya con partido, autor y asistente); replayS es el
// punto de la grabación y timeS el reloj del partido
const publicGoal = (g) => ({
  index: g.index, team: g.team, segment: g.segment, segmentGoal: g.segmentGoal,
  scorer: g.scorer, assist: g.assist, ownGoal: g.ownGoal, deflectedBy: g.deflectedBy,
  red: g.red, blue: g.blue, timeS: g.timeS, replayS: Math.round(g.tick / TICK_RATE),
});
const fileUrl = (req, jobId, filePath) => `${req.protocol}://${req.get('host')}/files/${jobId}/${path.basename(filePath)}`;

app.get('/health', (req, res) => res.json({ ok: true }));

// 1) Subís un .hbr2 y te devuelve la lista de goles al instante, sin renderizar nada.
//    Le permite a una web mostrar "Gol 1 - 12' - red" etc. antes de gastar CPU en renderizar.
app.post('/api/replays', upload.single('replay'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'send the replay as multipart field "replay"' });
  const data = new Uint8Array(req.file.buffer);
  try { readGoalIndex(data); } // validación barata: rechaza lo que no es un .hbr2 sin gastar la pasada completa
  catch (e) { return res.status(400).json({ error: `not a valid .hbr2 replay: ${e.message}` }); }

  // pasada silenciosa (~1 s cada 100k ticks): partidos, autores, asistentes, autogoles
  let info;
  try { info = await listReplayData(data); }
  catch (e) { return res.status(400).json({ error: `could not read the replay: ${e.message}` }); }

  const replayId = store.addReplay(req.file.buffer, info.goals, info.goals.length, info.segments);
  res.json({ replayId, totalGoals: info.goals.length, durationS: info.durationS, segments: info.segments, goals: info.goals.map(publicGoal) });
});

app.get('/api/replays/:id', (req, res) => {
  const r = store.replays.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'replay not found (it may have expired)' });
  res.json({ replayId: r.id, totalGoals: r.totalGoals, segments: r.segments, goals: r.goals.map(publicGoal) });
});

// 2) Renderiza algunos (o todos) los goles de ese replay. Corre en segundo plano a través de
//    una cola con concurrencia limitada; consultá GET /api/jobs/:id para ver el progreso y los
//    links de descarga.
//    JSON normal, o multipart si vas a mandar música de fondo (ver más abajo):
//    Body: { goals: "all" | [1,2,3] | "seg-1" | ["seg-2", 7], segment: 1 | [1,2], team: "red" | "blue", scorer: "nombre",
//            merge: false | true, mergeBy: "all" | "match" (un video por partido), transition, transitionMs, format: "mp4", fps, zoom, camera, followPlayerId,
//            size, before, after, sound, crowd, overlays, smooth, handoffMs, blendMs, gifWidth,
//            poster, watermarkText, watermarkPosition, watermarkOpacity, musicVolume }
//    (watermarkImage no se acepta por API: solo la del servidor vía env, ver WATERMARK_IMAGE)
//
//    Música de fondo: solo tiene efecto con merge: true. Como es un archivo, este endpoint no
//    va como JSON en ese caso - mandá multipart/form-data con un campo "music" (el audio) y un
//    campo "options" con el mismo body de arriba, pero como texto JSON.
app.post('/api/replays/:id/render', upload.single('music'), (req, res) => {
  const replay = store.replays.get(req.params.id);
  if (!replay) return res.status(404).json({ error: 'replay not found (it may have expired)' });

  let b;
  if (req.file) {
    try { b = req.body.options ? JSON.parse(req.body.options) : {}; }
    catch { return res.status(400).json({ error: 'the "options" field must be valid JSON when sending a music file' }); }
  } else {
    b = req.body || {};
  }
  if (req.file && !(b.merge || b.mergeBy === 'match')) return res.status(400).json({ error: 'background music only applies to the merged video, send merge: true too' });

  const options = {
    onlyGoal: b.goals == null || b.goals === 'all' ? null : b.goals, // 'all', números, 'seg-N' (ver src/select.js)
    segment: b.segment, team: b.team, scorer: b.scorer,
    merge: !!b.merge || b.mergeBy === 'match',
    mergeBy: b.mergeBy, transition: b.transition, transitionMs: b.transitionMs,
    format: b.format,
    fps: b.fps, zoom: b.zoom, camera: b.camera, followPlayerId: b.followPlayerId, smooth: b.smooth,
    handoffMs: b.handoffMs, blendMs: b.blendMs,
    preS: b.before, postS: b.after,
    sound: b.sound, crowd: b.crowd, overlays: b.overlays,
    gifWidth: b.gifWidth,
    poster: b.poster,
    musicVolume: b.musicVolume,
    watermarkPosition: b.watermarkPosition, watermarkOpacity: b.watermarkOpacity,
  };
  // el logo/texto de marca de agua lo define el servidor por env (WATERMARK_TEXT o
  // WATERMARK_IMAGE - nunca una ruta que mande el cliente, así nadie hace que el servidor lea
  // archivos arbitrarios). El cliente solo puede pedir un texto propio o apagarla del todo, y
  // solo si el servidor no puso WATERMARK_FORCE=true.
  const forced = process.env.WATERMARK_FORCE === 'true';
  if (process.env.WATERMARK_IMAGE) {
    options.watermarkImage = process.env.WATERMARK_IMAGE; // el logo siempre gana, no se apaga por API
  } else if (!forced && b.watermark === false) {
    options.watermarkText = undefined;
  } else if (!forced && typeof b.watermarkText === 'string') {
    options.watermarkText = b.watermarkText;
  } else {
    options.watermarkText = process.env.WATERMARK_TEXT || undefined;
  }
  if (typeof b.size === 'string' && /^\d+x\d+$/.test(b.size)) {
    [options.width, options.height] = b.size.split('x').map(Number);
  }

  let musicTmpFile = null;
  if (req.file) {
    musicTmpFile = path.join(os.tmpdir(), `hbr2clips-music-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(musicTmpFile, req.file.buffer);
    options.music = musicTmpFile;
  }

  // lo que el cliente puede equivocar se rechaza acá con un 400, no dentro del trabajo
  if (options.transition !== undefined && !TRANSITIONS.includes(options.transition)) return res.status(400).json({ error: `unknown transition "${options.transition}", use ${TRANSITIONS.join(', ')}` });
  if (options.mergeBy !== undefined && !['all', 'match'].includes(options.mergeBy)) return res.status(400).json({ error: 'mergeBy has to be "all" or "match"' });

  try {
    if (!selectGoals(replay.goals, options).length) return res.status(400).json({ error: 'no goals match that selection (see GET /api/replays/:id for the goals and matches)' });
  } catch (e) { return res.status(400).json({ error: e.message }); }

  const jobId = store.addJob(replay.id);
  const job = store.jobs.get(jobId);

  limit(() => {
    job.status = 'processing';
    return extractGoalClips(replay.file, job.dir, options);
  }).then((results) => {
    job.status = 'done';
    job.files = results;
    job.merged = results.merged || null;
    job.matches = results.matches || null;
  }).catch((e) => {
    job.status = 'error';
    job.error = e.message;
  }).finally(() => {
    if (musicTmpFile) fs.rmSync(musicTmpFile, { force: true });
  });

  res.status(202).json({ jobId, status: job.status });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = store.jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found (it may have expired)' });
  if (job.status !== 'done') return res.json({ jobId: job.id, status: job.status, error: job.error || undefined });

  res.json({
    jobId: job.id,
    status: 'done',
    files: job.files.map((f) => ({
      index: f.index, team: f.team, segment: f.segment, segmentGoal: f.segmentGoal, scorer: f.scorer, assist: f.assist,
      ownGoal: f.ownGoal, red: f.red, blue: f.blue, timeS: f.timeS,
      url: fileUrl(req, job.id, f.file),
      posterUrl: f.poster ? fileUrl(req, job.id, f.poster) : null,
    })),
    mergedUrl: job.merged ? fileUrl(req, job.id, job.merged) : null,
    matches: job.matches ? job.matches.map((m) => ({ segment: m.segment, goals: m.goals, url: fileUrl(req, job.id, m.file) })) : null,
  });
});

// 3) Sirve los archivos ya renderizados. Se mantiene como ruta propia (no express.static sobre
//    todo el directorio de datos) para que nada fuera de la carpeta de cada job sea accesible.
app.get('/files/:jobId/:filename', (req, res) => {
  const job = store.jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();
  const safeName = path.basename(req.params.filename); // evita path traversal con ../
  res.sendFile(path.join(job.dir, safeName), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

app.delete('/api/replays/:id', (req, res) => {
  const r = store.replays.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'replay not found' });
  require('fs').rmSync(r.file, { force: true });
  store.replays.delete(req.params.id);
  res.status(204).end();
});

// Captura errores pasados con next(err) (p. ej. multer rechazando un archivo demasiado grande)
// para que el cliente siempre reciba un JSON de error limpio, en vez de la página HTML con el
// stack trace que muestra Express por defecto.
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `replay is larger than the ${MAX_UPLOAD_MB} MB limit` });
  if (err) return res.status(400).json({ error: err.message || 'bad request' });
  next();
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`hbr2-clips API listening on http://localhost:${PORT}`));
}

module.exports = { app };
