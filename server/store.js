'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const REPLAYS_DIR = path.join(DATA_DIR, 'replays');
const RENDERS_DIR = path.join(DATA_DIR, 'renders');
const MAX_AGE_MS = Number(process.env.MAX_AGE_MINUTES || 120) * 60 * 1000; // cuánto tiempo se conservan los archivos

fs.mkdirSync(REPLAYS_DIR, { recursive: true });
fs.mkdirSync(RENDERS_DIR, { recursive: true });

// id -> { file, goals, segments, totalGoals, createdAt }
const replays = new Map();
// id -> { status, replayId, dir, files, merged, error, createdAt }
const jobs = new Map();

function newId() {
  return require('crypto').randomBytes(9).toString('base64url'); // corto y apto para URLs
}

function addReplay(buffer, goals, totalGoals, segments = []) {
  const id = newId();
  const file = path.join(REPLAYS_DIR, `${id}.hbr2`);
  fs.writeFileSync(file, buffer);
  replays.set(id, { id, file, goals, segments, totalGoals, createdAt: Date.now() });
  return id;
}

function addJob(replayId) {
  const id = newId();
  const dir = path.join(RENDERS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  jobs.set(id, { id, status: 'queued', replayId, dir, files: null, merged: null, error: null, createdAt: Date.now() });
  return id;
}

// Elimina de memoria y disco todo lo más viejo que MAX_AGE_MS. Corre en un intervalo para que
// un servidor de larga duración (hosting de bot, VPS siempre encendido) no vaya llenando el
// disco de a poco.
function cleanup() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, r] of replays) {
    if (r.createdAt < cutoff) { fs.rmSync(r.file, { force: true }); replays.delete(id); }
  }
  for (const [id, j] of jobs) {
    if (j.createdAt < cutoff) { fs.rmSync(j.dir, { recursive: true, force: true }); jobs.delete(id); }
  }
}

let timer = null;
function startCleanup() {
  if (timer) return;
  timer = setInterval(cleanup, 10 * 60 * 1000);
  timer.unref(); // que esto no mantenga vivo el proceso por sí solo
}

module.exports = { REPLAYS_DIR, RENDERS_DIR, replays, jobs, addReplay, addJob, newId, startCleanup };
