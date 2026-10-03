'use strict';

// Renderiza un clip de video de cada gol en un replay .hbr2, usando el renderer y los sonidos
// del propio juego.
//
//   node src/extractGoalClip.js replay.hbr2 [--goal all|2|1,3|seg-1] [--segment 1] [--list]
//                                           [--merge | --merge-per-match] [--transition fadeblack]
//                                           [--before 5] [--after 2] [--fps 30] [--zoom 1.6]
//                                           [--size 1280x720] [--format gif] [--camera cinema]
//                                           [--no-sound] [--no-crowd] [--no-overlays]
//
// Primero una pasada silenciosa (src/scan.js) detecta los partidos de la grabación, los goles
// (con autor, asistente y autogol) y los tiros. Después se hace una sola pasada dibujando los
// frames dentro de cada ventana de gol. Un clip se codifica con ffmpeg apenas termina su ventana,
// mientras la pasada sigue corriendo.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installDomShim } = require('./domShim');
const { loadAssets } = require('./assets');
const { createOfficialRenderer } = require('./officialRenderer');
const { createCameraTracker } = require('./camera');
const { createCinemaCamera } = require('./cinemaCamera');
const { createDirector } = require('./director');
const { scanReplay, play } = require('./scan');
const { selectGoals, teamName } = require('./select');
const { buildTrack } = require('./audio');
const { encodeClip, extractPoster, mixBackgroundMusic } = require('./framesToVideo');
const { prepareWatermark } = require('./watermark');
const { mergeClips, TRANSITIONS } = require('./mergeClips');
const { readGoalIndex } = require('./hbr2Index');
const { CrowdModel, readDanger, CELEBRATION_TICKS } = require('./crowd');

const TICK_RATE = 60;
const CROWD_LEAD_TICKS = 5 * TICK_RATE; // arrancar el modelo de público este rato antes de una ventana
const MAX_ENCODERS = 2;

const DEFAULTS = {
  width: 960, height: 540, zoom: 1.5,
  fps: 60,           // 60 = un frame por tick. Se redondea a un divisor de 60 (60, 30, 20, 15...)
  preS: 5, postS: 2.5, // segundos antes / después del gol (2.5s es justo cuando el juego reposiciona jugadores y pelota)
  format: 'mp4',     // 'mp4' o 'gif' (el gif no tiene audio y tope de 30 fps)
  gifWidth: 640,     // ancho de salida del gif, los frames se escalan a eso
  // 'cinema' (default): cámara cinematográfica, se acerca a la jugada ANTES del remate y del gol y
  // centra al autor en el festejo (ver src/director.js y src/cinemaCamera.js). 'ball': sigue la
  // pelota y, handoffMs después del gol, se desliza hacia el autor. 'player': sigue a un jugador
  // todo el clip (por defecto el autor). 'game': el seguimiento propio del juego.
  camera: 'cinema',
  followPlayerId: null, // solo con camera:'player' - fija el jugador a seguir en vez del autor de cada gol
  smooth: 0.2,       // cámaras 'ball'/'player': 1 = pegada al objetivo, valores bajos = más lenta ('cinema' ya viene afinada)
  handoffMs: 400,    // cámara 'ball': cuánto esperar tras el gol antes de empezar a moverse hacia el autor
  blendMs: 500,      // cámara 'ball': qué tan rápido gira hacia el autor una vez arranca (sin saltos de dirección, ver src/camera.js)
  warmupTicks: 60,   // se dibujan pero no se guardan, para que la cámara se asiente
  speed: 60,         // velocidad de reproducción del replay mientras se dibuja, no cambia la salida
  skipSpeed: 9999,   // velocidad entre goles, donde no se dibuja nada (igual a speed = sin salto rápido)
  sound: true, crowd: true, overlays: true,
  // Qué goles: null / 'all' = todos, 3 = ese gol, [1,3] = esos, 'seg-2' = el partido 2 (una grabación
  // puede traer varios), y se pueden combinar: ['seg-1', 7]. Ver src/select.js.
  onlyGoal: null,
  segment: null,    // atajo: 2 o [1,2] = los goles de esos partidos (se suma a onlyGoal)
  team: null,       // 'red' | 'blue': solo los goles que convirtió ese equipo
  scorer: null,     // solo los goles de este jugador (parte del nombre, sin distinguir mayúsculas)
  merge: false,     // también genera un video con todos los goles renderizados uno atrás del otro (solo mp4)
  // Video combinado (merge): transición entre goles (ver TRANSITIONS en src/mergeClips.js) y su duración.
  // mergeBy 'match' genera un video por partido (match_1.mp4, match_2.mp4...) en la misma pasada.
  transition: 'fadeblack',
  transitionMs: 500,
  mergeBy: 'all',
  music: null,        // ruta a un audio - pista de fondo para el video mergeado (solo con merge: true)
  musicVolume: 0.35,  // volumen de esa pista, mezclada debajo del audio del juego (1 = mismo nivel)
  poster: true,     // además de cada goal_N.mp4, un goal_N.jpg (miniatura en el instante del gol)
  watermarkText: null,    // ej. "haxven.gg" - se ignora si watermarkImage está puesto
  watermarkImage: null,   // ruta a un PNG (con transparencia si se quiere) - tiene prioridad sobre el texto
  watermarkPosition: 'bottom-right', // bottom-right | bottom-left | top-right | top-left
  watermarkOpacity: 0.7,
  resDat: path.join(__dirname, '..', 'assets', 'res.dat'),
};

function createLimiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// sparse[from..to] con los huecos rellenados con el último valor
function denseGains(sparse, from, to) {
  const out = [];
  let last = 0;
  for (let i = from; i <= to; i++) { if (sparse[i] !== undefined) last = sparse[i]; out.push(last); }
  return out;
}

// Une los clips de `files` en `finalFile` (con la transición pedida y, si hay, la música de fondo).
// Con un solo clip no hay nada que unir: en modo 'all' ese clip ya es "el video" y se devuelve tal
// cual (salvo que haya música); en modo 'match' se copia, para que el archivo se llame match_N.mp4.
async function buildMerged(files, finalFile, options = {}) {
  // quien llama desde afuera (summarizeMatch) pasa solo lo que quiso cambiar: el resto, por defecto
  const opts = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
  if (!TRANSITIONS.includes(opts.transition)) throw new Error(`unknown transition "${opts.transition}", use ${TRANSITIONS.join(', ')}`);
  let current = files[0], created = false;
  if (files.length > 1) {
    await mergeClips(files, finalFile, { transition: opts.transition, transitionS: opts.transitionMs / 1000 });
    current = finalFile; created = true;
  }
  if (opts.music) {
    if (!fs.existsSync(opts.music)) throw new Error('music file not found: ' + opts.music);
    const withMusic = `${finalFile}.music.mp4`; // no puede ser el mismo archivo que lee ffmpeg
    await mixBackgroundMusic({ videoFile: current, musicFile: opts.music, outFile: withMusic, volume: opts.musicVolume });
    if (created) fs.rmSync(current, { force: true }); // nunca borra un clip individual
    fs.renameSync(withMusic, finalFile);
    return finalFile;
  }
  if (!created && opts.mergeBy === 'match') { fs.copyFileSync(current, finalFile); return finalFile; }
  return current;
}

// lo que se le muestra a quien llama (sin los ids internos que usa la cámara)
function publicGoal(g) {
  return {
    index: g.index, tick: g.tick, teamId: g.teamId, team: teamName(g.teamId),
    segment: g.segment, segmentGoal: g.segmentGoal,
    scorer: g.scorer, assist: g.assist, ownGoal: g.ownGoal, deflectedBy: g.deflectedBy,
    red: g.red, blue: g.blue, timeS: g.timeS,
  };
}

async function renderClips({ API, data, goals, timeline, opts, assets, domShim, outDir }) {
  const stride = Math.max(1, Math.round(TICK_RATE / opts.fps));
  const fps = TICK_RATE / stride; // el frame rate real, ya que dibujamos un frame cada `stride` ticks
  const dtMs = (stride / TICK_RATE) * 1000;
  const withAudio = opts.sound && opts.format === 'mp4';
  const gifWidth = opts.gifWidth && opts.width > opts.gifWidth ? opts.gifWidth : null;
  const R = createOfficialRenderer({
    API, domShim, images: assets.images, width: opts.width, height: opts.height, zoom: opts.zoom, overlays: opts.overlays,
    camera: opts.camera,
  });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hbr2clips-')); // frames temporales, fuera de OneDrive

  // 'game' mueve la cámara por su cuenta y produce el mismo frame sin importar la ventana, así
  // que se puede dibujar una vez por tick y copiarlo a todas las ventanas activas ('ball'/
  // 'player' necesitan una cámara propia por ventana, ver src/camera.js - le sale un poco más
  // caro cuando dos goles se solapan, pero ahí es donde importa que no se pisen)
  const perWindowCamera = opts.camera !== 'game';
  // 'cinema' sale del análisis previo: qué mirar y cuánto acercarse en cada tick (ver src/director.js)
  const director = opts.camera === 'cinema' ? createDirector(timeline) : null;
  const scanGoals = new Map(timeline.goals.map((g) => [g.index, g]));
  const handoffTicks = Math.round((opts.handoffMs / 1000) * TICK_RATE);
  const blendTicks = Math.round((opts.blendMs / 1000) * TICK_RATE);

  const watermark = (opts.watermarkText || opts.watermarkImage)
    ? prepareWatermark({
      text: opts.watermarkText, imagePath: opts.watermarkImage, position: opts.watermarkPosition,
      opacity: opts.watermarkOpacity, videoWidth: opts.width, videoHeight: opts.height, workDir: tmpRoot,
    })
    : null;

  const windows = goals.map((g) => {
    const start = Math.max(0, g.tick - opts.preS * TICK_RATE);
    const followPlayerId = opts.camera === 'player' ? (opts.followPlayerId ?? g.scorerId ?? null) : null;
    return {
      index: g.index, expectTick: g.tick, start, from: Math.max(0, start - opts.warmupTicks), end: g.tick + opts.postS * TICK_RATE,
      // un solo archivo con los frames crudos uno atrás del otro (ver R.draw), no una carpeta de
      // PNGs - fd se abre recién con el primer frame que sí se guarda
      rawFile: path.join(tmpRoot, `goal_${g.index}.raw`), fd: null, frames: 0, firstTick: null, crowd: [], info: null, done: false,
      camera: director
        ? createCinemaCamera({ director, width: opts.width, height: opts.height, zoom: opts.zoom })
        : perWindowCamera ? createCameraTracker({ mode: opts.camera, smooth: opts.smooth, ticksPerFrame: stride, followPlayerId, handoffTicks, blendTicks }) : null,
    };
  });
  let pending = windows.length;
  const inAnyWindow = (t) => windows.some((w) => !w.done && t >= w.from && t <= w.end);
  // Entre goles no se dibuja nada, así que ahí el replay corre a opts.skipSpeed. Se vuelve a opts.speed
  // con margen antes de cada ventana (y de lo que necesita el público): el lector reproduce los ticks
  // en tandas, y el margen asegura que la tanda que cae sobre la ventana ya vaya a velocidad normal.
  const FAST_MARGIN_TICKS = 2400;
  const canSkip = opts.skipSpeed > opts.speed;
  const slowNeeded = (t) => windows.some((w) => !w.done && t >= w.from - CROWD_LEAD_TICKS - FAST_MARGIN_TICKS && t <= w.end + FAST_MARGIN_TICKS / 4);
  let fastNow = false;
  const needCrowd = (t) => windows.some((w) => !w.done && t >= w.from - CROWD_LEAD_TICKS && t <= w.end);

  const kicks = [];
  let goalSeq = 0, celebrateUntil = -1, dangerOk = true, stoppedEarly = false;
  const crowd = new CrowdModel();
  const limit = createLimiter(MAX_ENCODERS);
  const jobs = [], results = [], failures = [];

  const finalize = (w) => {
    w.done = true; pending--;
    if (w.fd != null) fs.closeSync(w.fd);
    const g = w.info;
    if (!g || !w.frames) {
      console.warn(`goal_${w.index}: ${!g ? 'the replay never fired this goal' : 'no frames'}, skipping`);
      fs.rmSync(w.rawFile, { force: true });
      return;
    }
    const outFile = path.join(outDir, `goal_${w.index}.${opts.format}`);
    let audioPath = null;
    if (withAudio) {
      const t0 = w.firstTick;
      const workDir = path.join(outDir, 'work', `goal_${w.index}`);
      fs.mkdirSync(workDir, { recursive: true });
      audioPath = buildTrack({
        sounds: assets.sounds,
        durationS: w.frames / fps,
        kicks: kicks.filter((k) => k >= t0 && k <= w.end).map((k) => (k - t0) / TICK_RATE),
        goalT: (g.tick - t0) / TICK_RATE,
        crowdGains: opts.crowd ? denseGains(w.crowd, t0 - w.start, w.crowd.length - 1) : null,
        gainsPerS: TICK_RATE,
        outPath: path.join(workDir, 'audio.wav'),
      });
    }
    const workDir = audioPath ? path.dirname(audioPath) : null;
    jobs.push(limit(async () => {
      await encodeClip({ framesFile: w.rawFile, width: opts.width, height: opts.height, outFile, fps, audioPath, gif: opts.format === 'gif' ? { width: gifWidth } : null, watermark });
      let posterFile = null;
      if (opts.poster && opts.format === 'mp4') {
        posterFile = path.join(outDir, `goal_${w.index}.jpg`);
        const goalT = (g.tick - w.firstTick) / TICK_RATE; // TICK_RATE, no fps: el offset está en ticks de 60 Hz
        await extractPoster(outFile, goalT, posterFile).catch((e) => { console.warn(`goal_${w.index}: poster failed (${e.message})`); posterFile = null; });
      }
      console.log(`${path.basename(outFile)}  ${g.scorer ?? '?'}  ${g.red}-${g.blue}`);
      results.push({ file: outFile, poster: posterFile, frames: w.frames, ...g });
    }).catch((e) => { failures.push(`goal_${w.index}: ${e.message}`); })
      .finally(() => { if (workDir) fs.rmSync(workDir, { recursive: true, force: true }); }));
  };

  await play(API, data, (ctx) => ({
    onGameStart: (...a) => { if (inAnyWindow(ctx.reader.getCurrentFrameNo())) R.onGameStart(...a); },

    onPlayerBallKick: () => { kicks.push(ctx.reader.getCurrentFrameNo()); },

    onTeamGoal: (...a) => {
      const teamId = a[0], tick = ctx.reader.getCurrentFrameNo();
      celebrateUntil = tick + CELEBRATION_TICKS;
      // el gol número N de esta pasada es el gol número N del análisis previo: empatan por orden
      const seq = ++goalSeq;
      const w = windows.find((x) => x.index === seq);
      if (w) {
        if (Math.abs(tick - w.expectTick) > 2) console.warn(`goal_${w.index}: scan says tick ${w.expectTick}, replay says ${tick}`);
        w.info = publicGoal(scanGoals.get(seq));
        // cámara 'ball': recién ahora se sabe a quién hacer el traspaso (ver src/camera.js)
        if (w.camera && opts.camera === 'ball') w.camera.onGoal(tick, scanGoals.get(seq).scorerId ?? null);
      }
      if (inAnyWindow(tick)) R.onTeamGoal(...a);
    },

    onGameTick: () => {
      if (!pending) return;
      const t = ctx.reader.getCurrentFrameNo();
      if (canSkip) {
        const wantFast = !slowNeeded(t);
        if (wantFast !== fastNow) { fastNow = wantFast; ctx.reader.setSpeed(fastNow ? opts.skipSpeed : opts.speed); }
      }
      const st = ctx.reader.state;
      if (!st.gameState) return;

      // el modelo de público corre cada tick cerca de las ventanas
      let gain = 0;
      if (withAudio && opts.crowd) {
        if (needCrowd(t)) {
          let danger = false;
          if (dangerOk) {
            try { danger = readDanger(st); } catch (e) {
              dangerOk = false;
              console.warn(`could not read player positions for the crowd (${e.message}), only the goal crowd will play`);
            }
          }
          gain = crowd.step({ celebrating: t < celebrateUntil, danger });
        } else crowd.reset();
      }

      const active = windows.filter((w) => !w.done && t >= w.from && t <= w.end);
      for (const w of active) if (t >= w.start) w.crowd[t - w.start] = gain;

      if (active.length && t % stride === 0) {
        R.advance(dtMs);
        if (!perWindowCamera) {
          // misma cámara para todas: un solo dibujado, copiado a cada ventana activa
          const buf = R.draw(st, null);
          for (const w of active) {
            if (t < w.start) continue; // calentamiento de cámara
            if (w.firstTick == null) w.firstTick = t;
            if (w.fd == null) w.fd = fs.openSync(w.rawFile, 'w');
            fs.writeSync(w.fd, buf);
            w.frames++;
          }
        } else {
          // cada ventana puede estar mirando a un jugador distinto - un dibujado por ventana.
          // el paso de cámara corre siempre (incluso en el calentamiento, para que se asiente
          // antes de que arranque a grabarse); el dibujado en sí, que es lo caro, solo cuando
          // el frame se va a guardar.
          for (const w of active) {
            const origin = w.camera.step(st, t);
            if (t < w.start) continue; // calentamiento de cámara
            const buf = R.draw(st, origin);
            if (w.firstTick == null) w.firstTick = t;
            if (w.fd == null) w.fd = fs.openSync(w.rawFile, 'w');
            fs.writeSync(w.fd, buf);
            w.frames++;
          }
        }
      }

      for (const w of windows) if (!w.done && t > w.end) finalize(w);
      // ya no queda ninguna ventana: no hace falta reproducir el resto del replay (con un gol al
      // principio de una grabación larga, eso era casi todo el tiempo)
      if (!pending && !stoppedEarly) { stoppedEarly = true; setImmediate(ctx.stop); }
    },
  }), opts.speed);

  // goles cerca del final del replay
  for (const w of windows) if (!w.done) finalize(w);
  if (!stoppedEarly && goalSeq !== timeline.goals.length) console.warn(`the scan found ${timeline.goals.length} goals but the replay fired ${goalSeq}`);

  await Promise.all(jobs);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(path.join(outDir, 'work'), { recursive: true, force: true }); // cada goal_N ya se limpió solo, esto borra el padre ya vacío

  if (failures.length) throw new Error('some clips failed:\n  ' + failures.join('\n  '));
  return results.sort((a, b) => a.index - b.index);
}

// devuelve un { file, poster, frames, index, tick, teamId, team, segment, segmentGoal, scorer, assist,
// ownGoal, deflectedBy, red, blue, timeS } por gol - poster es la ruta del goal_N.jpg (null si
// opts.poster es false o el formato es gif)
async function extractGoalClips(replayPath, outDir, options = {}) {
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const opts = { ...DEFAULTS, ...given };
  if (!['mp4', 'gif'].includes(opts.format)) throw new Error(`unknown format "${opts.format}", use mp4 or gif`);
  if (!['cinema', 'game', 'ball', 'player'].includes(opts.camera)) throw new Error(`unknown camera "${opts.camera}", use cinema, game, ball or player`);
  if (!(opts.smooth > 0 && opts.smooth <= 1)) throw new Error('smooth has to be a number above 0 and up to 1');
  if (!(opts.preS >= 0 && opts.postS >= 0)) throw new Error('before / after have to be zero or more seconds');
  if (!(opts.fps > 0)) throw new Error('fps has to be a positive number');
  if (!(opts.speed > 0 && opts.skipSpeed > 0)) throw new Error('speed / skip-speed have to be positive numbers');
  if (!(opts.handoffMs >= 0 && opts.blendMs >= 0)) throw new Error('handoff / blend have to be zero or more milliseconds');
  if (opts.watermarkText && opts.watermarkImage) console.warn('watermarkText and watermarkImage were both set, using the image');
  if (!TRANSITIONS.includes(opts.transition)) throw new Error(`unknown transition "${opts.transition}", use ${TRANSITIONS.join(', ')}`);
  if (!(opts.transitionMs >= 0)) throw new Error('transition-ms has to be zero or more milliseconds');
  if (!['all', 'match'].includes(opts.mergeBy)) throw new Error('merge-by has to be all or match');
  if (opts.mergeBy === 'match') opts.merge = true; // un video por partido implica combinar
  if (opts.music && !opts.merge) throw new Error('background music (--music) only applies to the merged video, pass --merge too');
  if (opts.music && !fs.existsSync(opts.music)) throw new Error('music file not found: ' + opts.music);
  if (opts.format === 'gif') opts.fps = Math.min(opts.fps, 30);
  const domShim = installDomShim(); // tiene que pasar antes de crear el renderer
  const API = require('node-haxball')();

  // copia de tamaño exacto: un Buffer de Node puede ser un slice de un pool más grande, y
  // node-haxball leería basura del pool como parte del header del .hbr2
  const data = new Uint8Array(fs.readFileSync(replayPath));

  const timeline = await scanReplay(API, data); // a velocidad máxima: opts.speed es solo para la pasada que dibuja
  const chosen = selectGoals(timeline.goals, opts);
  if (!chosen.length) return [];

  const assets = await loadAssets(opts.resDat);
  const results = await renderClips({ API, data, goals: chosen, timeline, opts, assets, domShim, outDir });

  // results sigue siendo un array plano (así `.length` / `.map()` etc. siguen funcionando para
  // los que ya la llaman) con lo combinado colgado como propiedades extra, sin romper la
  // enumerabilidad: results.merged (un solo video) o results.matches (uno por partido).
  if (opts.merge) {
    if (opts.format !== 'mp4') {
      console.warn('merge only works with --format mp4, skipping');
    } else if (opts.mergeBy === 'match') {
      const byMatch = new Map();
      for (const r of results) byMatch.set(r.segment ?? 0, (byMatch.get(r.segment ?? 0) || []).concat(r));
      results.matches = [];
      for (const [segment, clips] of [...byMatch.entries()].sort((x, y) => x[0] - y[0])) {
        const file = await buildMerged(clips.map((c) => c.file), path.join(outDir, `match_${segment}.mp4`), opts);
        results.matches.push({ segment, goals: clips.length, file });
      }
      if (results.matches.length === 1) results.merged = results.matches[0].file;
    } else {
      results.merged = await buildMerged(results.map((r) => r.file), path.join(outDir, 'all.mp4'), opts);
    }
  }
  return results;
}

// Los partidos y goles de un replay, sin renderizar nada (una pasada silenciosa, ~1 s cada 100k ticks).
// Sirve para mostrar qué hay antes de pedir los clips. listReplayData recibe los bytes del .hbr2.
async function listReplayData(data, { speed } = {}) {
  const API = require('node-haxball')();
  const tl = await scanReplay(API, data, speed ? { speed } : undefined);
  return { totalTicks: tl.n, durationS: Math.round(tl.n / TICK_RATE), segments: tl.segments, goals: tl.goals.map(publicGoal) };
}
async function listReplay(replayPath, options) {
  return listReplayData(new Uint8Array(fs.readFileSync(replayPath)), options);
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
function printList(info) {
  console.log(`${info.goals.length} goal(s), ${info.segments.length} match(es), ${mmss(info.durationS)} of replay`);
  for (const seg of info.segments) {
    console.log(`\nMatch ${seg.index}  (${mmss(seg.durationS)}, final ${seg.red}-${seg.blue}, ${seg.goals} goal(s))   --goal seg-${seg.index}`);
    for (const g of info.goals.filter((x) => x.segment === seg.index)) {
      const who = g.scorer ? `${g.scorer}${g.ownGoal ? ' (own goal)' : ''}${g.assist ? `, assist ${g.assist}` : ''}` : '?';
      console.log(`  #${g.index}  ${mmss(g.timeS)}  ${g.red}-${g.blue}  ${g.team}  ${who}`);
    }
  }
}

function parseArgs(argv) {
  const o = {}; let replay = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--goal') o.onlyGoal = (o.onlyGoal || []).concat(argv[++i]); // se puede repetir o recibir "1,3,seg-2"
    else if (a === '--segment' || a === '--match' || a === '--seg') o.segment = (o.segment || []).concat(argv[++i].split(',').map(Number));
    else if (a === '--team') o.team = argv[++i];
    else if (a === '--scorer') o.scorer = argv[++i];
    else if (a === '--list') o.list = true;
    else if (a === '--skip-speed') o.skipSpeed = Number(argv[++i]);
    else if (a === '--transition') o.transition = argv[++i];
    else if (a === '--transition-ms') o.transitionMs = Number(argv[++i]);
    else if (a === '--merge-per-match') { o.merge = true; o.mergeBy = 'match'; }
    else if (a === '--merge') o.merge = true;
    else if (a === '--fps') o.fps = Number(argv[++i]);
    else if (a === '--before') o.preS = Number(argv[++i]);
    else if (a === '--after') o.postS = Number(argv[++i]);
    else if (a === '--format') o.format = argv[++i];
    else if (a === '--gif-width') o.gifWidth = Number(argv[++i]);
    else if (a === '--camera') o.camera = argv[++i];
    else if (a === '--follow') o.followPlayerId = Number(argv[++i]);
    else if (a === '--smooth') o.smooth = Number(argv[++i]);
    else if (a === '--handoff') o.handoffMs = Number(argv[++i]);
    else if (a === '--blend') o.blendMs = Number(argv[++i]);
    else if (a === '--zoom') o.zoom = Number(argv[++i]);
    else if (a === '--size') { const [w, h] = argv[++i].split('x').map(Number); o.width = w; o.height = h; }
    else if (a === '--res') o.resDat = argv[++i];
    else if (a === '--no-sound') o.sound = false;
    else if (a === '--no-crowd') o.crowd = false;
    else if (a === '--no-overlays') o.overlays = false;
    else if (a === '--no-poster') o.poster = false;
    else if (a === '--watermark') o.watermarkText = argv[++i];
    else if (a === '--watermark-image') o.watermarkImage = argv[++i];
    else if (a === '--watermark-position') o.watermarkPosition = argv[++i];
    else if (a === '--watermark-opacity') o.watermarkOpacity = Number(argv[++i]);
    else if (a === '--music') o.music = argv[++i];
    else if (a === '--music-volume') o.musicVolume = Number(argv[++i]);
    else replay = a;
  }
  return { replay, options: o };
}

if (require.main === module) {
  const { replay, options } = parseArgs(process.argv.slice(2));
  if (!replay) {
    console.error('usage: node src/extractGoalClip.js replay.hbr2 [--list]\n' +
      '       [--goal all | N | 1,3,4 | seg-2] [--segment 1,2] [--team red|blue] [--scorer name]\n' +
      '       [--merge | --merge-per-match] [--transition fadeblack|fade|none|...] [--transition-ms 500]\n' +
      '       [--before S] [--after S]\n' +
      '       [--fps 30] [--zoom 1.6] [--size 1280x720] [--format mp4|gif] [--gif-width 640]\n' +
      '       [--camera cinema|game|ball|player] [--follow playerId] [--smooth 0.2] [--handoff 400] [--blend 500]\n' +
      '       [--watermark "texto"] [--watermark-image logo.png] [--watermark-position bottom-right]\n' +
      '       [--watermark-opacity 0.7] [--music song.mp3] [--music-volume 0.35]\n' +
      '       [--no-poster] [--no-sound] [--no-crowd] [--no-overlays] [--res ruta.dat] [--skip-speed N]');
    process.exit(1);
  }
  if (options.list) {
    listReplay(replay).then(printList).catch((e) => { console.error(e.message); process.exit(1); });
    return;
  }
  const outDir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  extractGoalClips(replay, outDir, options).then((r) => {
    if (!r.length) return console.log('no goals match (try --list to see what this replay has)');
    console.log(`${r.length} clip(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${outDir}`);
    if (r.matches) for (const m of r.matches) console.log(`match ${m.segment} (${m.goals} goal(s)) -> ${m.file}`);
    else if (r.merged) console.log(`merged -> ${r.merged}`);
  }).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { extractGoalClips, listReplay, listReplayData, readGoalIndex, buildMerged };
