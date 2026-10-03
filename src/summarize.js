'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractGoalClips, buildMerged } = require('./extractGoalClip');

// Arma el resumen de UN partido en un solo video, a partir de una o varias grabaciones.
//
//   const r = await summarizeMatch(
//     [{ replay: 'parte1.hbr2', segments: [2] }, { replay: 'parte2.hbr2', segments: [1, 2] }],
//     'resumen.mp4',
//     { size: '1280x720', transition: 'fadeblack', music: 'tema.mp3' },
//   );
//   // r.file = 'resumen.mp4', r.goals = los goles en orden, con autor y asistente
//
// Cada parte es { replay, segments?, goals?, team?, scorer? }:
//   - segments: los partidos de esa grabación que cuentan (número o lista). Sin `segments` ni `goals`
//     entran todos los goles. Una lista vacía significa "de esta grabación no entra nada".
//   - goals / team / scorer: los mismos selectores que extractGoalClips (ver src/select.js).
// Las partes se renderizan una tras otra, en el orden dado, y los goles quedan en ese orden. Las
// opciones son las de extractGoalClips más keepClips (conservar los clips sueltos, junto al video).
async function summarizeMatch(parts, outFile, options = {}) {
  if (!Array.isArray(parts) || !parts.length) throw new Error('summarizeMatch needs at least one part: [{ replay, segments }]');
  for (const [i, p] of parts.entries()) {
    if (!p || typeof p.replay !== 'string') throw new Error(`part ${i + 1} needs a "replay" path`);
    if (!fs.existsSync(p.replay)) throw new Error(`part ${i + 1}: replay not found: ${p.replay}`);
  }
  if (!outFile) throw new Error('summarizeMatch needs an output file path');
  if ((options.format || 'mp4') !== 'mp4') throw new Error('summarizeMatch only works with mp4');

  const { keepClips, ...render } = options;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr2-summary-'));
  const clips = [], used = [];
  try {
    for (const [i, part] of parts.entries()) {
      if (Array.isArray(part.segments) && !part.segments.length) continue; // el bot no marcó nada válido en esta grabación
      const dir = path.join(workDir, `part${i + 1}`); // carpeta propia: el gol 1 de una grabación no pisa al gol 1 de otra
      fs.mkdirSync(dir);
      const r = await extractGoalClips(part.replay, dir, {
        poster: false,
        ...render,
        merge: false, mergeBy: 'all', music: null, // lo combinado se hace una sola vez, al final
        onlyGoal: part.goals, segment: part.segments,
        team: part.team ?? render.team, scorer: part.scorer ?? render.scorer,
      });
      for (const c of r) clips.push({ ...c, part: i + 1 });
      used.push({ replay: part.replay, clips: r.length });
    }
    if (!clips.length) throw new Error('no goals found in the selected segments');

    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    // mergeBy 'match': aunque sea un solo gol, el resultado se copia a outFile (no se devuelve el clip suelto)
    await buildMerged(clips.map((c) => c.file), path.resolve(outFile), { ...render, mergeBy: 'match' });

    const goals = clips.map(({ file, poster, frames, ...goal }) => goal);
    const result = { file: path.resolve(outFile), goalCount: clips.length, goals, parts: used };
    if (keepClips) {
      const keep = path.join(path.dirname(path.resolve(outFile)), `${path.parse(outFile).name}_clips`);
      fs.rmSync(keep, { recursive: true, force: true });
      fs.cpSync(workDir, keep, { recursive: true });
      result.clipsDir = keep;
    }
    return result;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { summarizeMatch };
