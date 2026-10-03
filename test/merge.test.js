'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { mergeClips, TRANSITIONS } = require('../src/mergeClips');
const { FFMPEG_PATH, probeInfo } = require('../src/framesToVideo');
const { buildMerged } = require('../src/extractGoalClip');

// clips sintéticos con el mismo formato que produce encodeClip (h264 + aac 48k estéreo)
function makeClip(dir, name, seconds, { audio = true } = {}) {
  const file = path.join(dir, name);
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=20:duration=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-ac', '2', '-shortest');
  args.push(file);
  const r = spawnSync(FFMPEG_PATH, args);
  assert.equal(r.status, 0, String(r.stderr));
  return file;
}

test('con transición el video dura la suma menos una transición por unión', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr2-merge-'));
  const clips = [makeClip(dir, 'a.mp4', 4), makeClip(dir, 'b.mp4', 4), makeClip(dir, 'c.mp4', 4)];
  const out = path.join(dir, 'out.mp4');
  await mergeClips(clips, out, { transition: 'fadeblack', transitionS: 0.5 });
  const info = await probeInfo(out);
  assert.ok(Math.abs(info.durationS - 11) < 0.15, `duración ${info.durationS}, esperada ~11`);
  assert.equal(info.hasAudio, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sin transición se pegan en seco (suma exacta, sin recodificar)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr2-merge-'));
  const clips = [makeClip(dir, 'a.mp4', 3), makeClip(dir, 'b.mp4', 3)];
  const out = path.join(dir, 'out.mp4');
  await mergeClips(clips, out, { transition: 'none' });
  const info = await probeInfo(out);
  assert.ok(Math.abs(info.durationS - 6) < 0.2, `duración ${info.durationS}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('una transición demasiado larga se acota a casi la mitad del clip más corto', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr2-merge-'));
  const clips = [makeClip(dir, 'a.mp4', 2), makeClip(dir, 'b.mp4', 2)];
  const out = path.join(dir, 'out.mp4');
  await mergeClips(clips, out, { transition: 'fade', transitionS: 5 });
  const info = await probeInfo(out);
  assert.ok(info.durationS > 3 && info.durationS < 3.3, `duración ${info.durationS}, esperada ~3.1 (2+2-0.9)`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('clips sin sonido también se funden', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr2-merge-'));
  const clips = [makeClip(dir, 'a.mp4', 3, { audio: false }), makeClip(dir, 'b.mp4', 3, { audio: false })];
  const out = path.join(dir, 'out.mp4');
  await mergeClips(clips, out, { transition: 'dissolve', transitionS: 0.4 });
  const info = await probeInfo(out);
  assert.equal(info.hasAudio, false);
  assert.ok(Math.abs(info.durationS - 5.6) < 0.15, `duración ${info.durationS}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('todas las transiciones declaradas funcionan y una desconocida falla claro', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr2-merge-'));
  const clips = [makeClip(dir, 'a.mp4', 2), makeClip(dir, 'b.mp4', 2)];
  for (const t of TRANSITIONS) {
    const out = path.join(dir, `${t}.mp4`);
    await mergeClips(clips, out, { transition: t, transitionS: 0.3 });
    assert.ok(fs.statSync(out).size > 1000, t);
  }
  await assert.rejects(() => mergeClips(clips, path.join(dir, 'x.mp4'), { transition: 'confeti' }), /unknown transition "confeti"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildMerged sin opciones aplica la transición por defecto (fadeblack, 0.5 s)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr2-merge-'));
  const clips = [makeClip(dir, 'a.mp4', 3), makeClip(dir, 'b.mp4', 3), makeClip(dir, 'c.mp4', 3)];
  const out = path.join(dir, 'out.mp4');
  await buildMerged(clips, out, {});
  const info = await probeInfo(out);
  assert.ok(Math.abs(info.durationS - 8) < 0.15, `duración ${info.durationS}, esperada ~8 (9 - 2 x 0.5)`);
  await buildMerged(clips, out, { transition: 'none' });
  assert.ok(Math.abs((await probeInfo(out)).durationS - 9) < 0.2, 'con none se pegan en seco');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildMerged con un solo clip lo copia al destino (modo match) o lo devuelve tal cual', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr2-merge-'));
  const clip = makeClip(dir, 'a.mp4', 2);
  const out = path.join(dir, 'copia.mp4');
  assert.equal(await buildMerged([clip], out, {}), clip);
  assert.equal(await buildMerged([clip], out, { mergeBy: 'match' }), out);
  assert.ok(fs.existsSync(out));
  fs.rmSync(dir, { recursive: true, force: true });
});
