'use strict';
// Pruebas contra el replay de ejemplo (1.hbr2, en la raíz del repo): dos partidos en la misma
// grabación, 10 goles, un autogol. Se saltan solas si el archivo no está.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scanReplay } = require('../src/scan');
const { createDirector, LEVEL } = require('../src/director');

const SAMPLE = path.join(__dirname, '..', '1.hbr2');
const skip = !fs.existsSync(SAMPLE) && 'falta 1.hbr2';
let cache;
const scan = async () => {
  if (!cache) cache = await scanReplay(require('node-haxball')(), new Uint8Array(fs.readFileSync(SAMPLE)));
  return cache;
};

test('detecta los dos partidos y reparte los goles', { skip }, async () => {
  const tl = await scan();
  assert.equal(tl.goals.length, 10);
  assert.deepEqual(tl.segments.map((s) => s.goals), [4, 6]);
  assert.deepEqual(tl.segments.map((s) => `${s.red}-${s.blue}`), ['0-4', '3-3']);
  assert.deepEqual(tl.goals.map((g) => g.segment), [1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
  assert.deepEqual(tl.goals.map((g) => g.segmentGoal), [1, 2, 3, 4, 1, 2, 3, 4, 5, 6]);
  assert.ok(tl.segments[0].end < tl.segments[1].start, 'los partidos no se pisan');
});

test('autor, asistente y autogol', { skip }, async () => {
  const { goals } = await scan();
  assert.equal(goals[0].scorer, 'Frxddy');
  assert.equal(goals[0].assist, 'TUKU LEON');
  assert.equal(goals[8].ownGoal, true);
  assert.equal(goals[8].assist, null);
  assert.equal(goals.filter((g) => g.ownGoal).length, 1);
  for (const g of goals) assert.ok(g.shotTick <= g.tick && g.tick - g.shotTick < 600, `gol ${g.index}: el remate es anterior al gol`);
});

test('el director: zoom y pesos dentro de rango, plano cerrado antes del gol y festejo después', { skip }, async () => {
  const tl = await scan();
  const dir = createDirector(tl);
  const dv = {};
  for (let t = 0; t < tl.n; t += 3) {
    dir.at(t, dv);
    assert.ok(dv.zoom >= 0 && dv.zoom <= LEVEL.celebrate + 1e-6, `zoom ${dv.zoom} en ${t}`);
    for (const w of [dv.aw, dv.bw, dv.cw, dv.gw]) assert.ok(w >= 0 && w <= 1 + 1e-6, `peso ${w} en ${t}`);
    if (dv.aw > 0) assert.ok(dv.a >= 0, 'un peso sin jugador');
    if (dv.cw > 0) assert.ok(dv.c >= 0, 'un peso sin jugador');
  }
  for (const g of tl.goals) {
    assert.ok(dir.at(g.tick - 30, dv).zoom >= 0.9, `gol ${g.index}: debería estar cerca justo antes del gol`);
    assert.ok(dir.at(g.tick + 100, dv).zoom >= LEVEL.celebrate - 0.05, `gol ${g.index}: debería estar en festejo`);
    assert.equal(dv.c, g.scorerId, `gol ${g.index}: el festejo se centra en el autor`);
  }
});
