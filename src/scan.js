'use strict';

// Pasada silenciosa por todo el replay (sin dibujar nada, a fondo: ~1 s cada 100k ticks) que deja
// listo todo lo que hay que saber ANTES de renderizar:
//
//   - los partidos (segments): una grabación puede traer varios, se separan por los eventos de
//     inicio / fin de juego. Se numeran 1, 2, 3... y cada gol sabe a qué partido pertenece.
//   - los goles, con autor, asistente, autogol y desvíos (quién tocó la pelota de verdad, por
//     distancia, no solo quién la pateó).
//   - los toques y los tiros al arco, que alimentan la cámara cinematográfica (src/director.js).
//   - una serie por tick (pelota, fase de juego, jugador más cercano...).
//
// La detección de toques y tiros sigue reglas simples y explicables (ver las constantes de abajo);
// son heurísticas, no una verdad absoluta: un "tiro" es una pelota que sale con velocidad hacia el
// arco rival y alcanzaría a llegar, no una intención.
const { readGoalIndex } = require('./hbr2Index');

const TICK_RATE = 60;
const TOUCH_GAP = 6;              // ticks sin contacto para que un contacto nuevo cuente como otro toque
const NEAR_R = 60;                // "jugador cerca de la pelota" (enfoque de la cámara en tiros rápidos)
const MIN_SEGMENT_TICKS = 30 * TICK_RATE; // un partido sin goles y más corto que esto se ignora (pruebas sueltas)
const DEFLECT_TICKS = 60;         // un rival que toca la pelota hasta 1 s después de un tiro al arco lo desvía
const SHOT_MIN_SPEED_KICK = 2.5;  // u/tick mínimos de la pelota 2 ticks después de una patada para ser tiro
const SHOT_MIN_SPEED_TOUCH = 4;   // ... y si fue solo un toque de cuerpo
const BALL_FRICTION_FRAMES = 99.762; // alcance máximo con fricción 0.99: distancia <= 99.762 * (v - 2)

const TRACK_ARRAYS = {
  game: Uint8Array, phase: Uint8Array, paused: Uint8Array, stadium: Uint8Array,
  bx: Float32Array, by: Float32Array, bvx: Float32Array, bvy: Float32Array,
  near: Int32Array, d1: Float32Array, d2: Float32Array,
};

function createTrack(n) {
  const t = { n };
  for (const [k, C] of Object.entries(TRACK_ARRAYS)) t[k] = new C(n);
  t.near.fill(-1); t.d1.fill(Infinity); t.d2.fill(Infinity);
  return t;
}

function growTrack(t, need) {
  if (need < t.n) return;
  const n = Math.max(need + 1, t.n * 2);
  for (const [k, C] of Object.entries(TRACK_ARRAYS)) {
    const a = new C(n);
    if (k === 'near') a.fill(-1); else if (k === 'd1' || k === 'd2') a.fill(Infinity);
    a.set(t[k]);
    t[k] = a;
  }
  t.n = n;
}

// Reproduce el replay a la velocidad dada. handlers(ctx) devuelve los callbacks de node-haxball;
// ctx.stop() corta la reproducción antes del final (por ejemplo cuando ya no queda nada que hacer).
function play(API, data, handlers, speed) {
  return new Promise((resolve) => {
    const ctx = {};
    let finished = false;
    ctx.stop = () => {
      if (finished) return;
      finished = true;
      try { ctx.reader.destroy(); } catch { /* ya estaba destruido */ }
      resolve();
    };
    ctx.reader = API.Replay.read(data, handlers(ctx));
    ctx.reader.onEnd = ctx.stop;
    ctx.reader.setSpeed(speed);
  });
}

const teamId = (t) => { const id = t && typeof t === 'object' ? t.id : t; return id === 1 || id === 2 ? id : 0; };

// Geometría de un estadio lo justo para la detección: bocas de arco, radio de "zona de peligro"...
// (las bocas son [izquierda, derecha]; team = el equipo que DEFIENDE ese arco)
function buildGeo(stadium, ballRadius) {
  const goals = [];
  for (const g of stadium.goals || []) {
    const x0 = g.p0 && g.p0.x, y0 = g.p0 && g.p0.y, x1 = g.p1 && g.p1.x, y1 = g.p1 && g.p1.y;
    if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
    goals.push({ team: teamId(g.team), x0, y0, x1, y1, mx: (x0 + x1) / 2 });
  }
  const mouths = [null, null];
  for (let side = 0; side < 2; side++) {
    const dir = side === 0 ? -1 : 1;
    let best = null, bestScore = -Infinity;
    for (const g of goals) {
      if (g.mx * dir <= 0) continue;
      // se prefieren los arcos verticales (palo contra la línea de fondo) y los más lejos del centro
      const score = (Math.abs(g.x1 - g.x0) <= Math.abs(g.y1 - g.y0) ? 1e6 : 0) + Math.abs(g.mx);
      if (score > bestScore) { bestScore = score; best = g; }
    }
    if (best) mouths[side] = { x: best.mx, y: (best.y0 + best.y1) / 2, hw: Math.max(20, Math.abs(best.y1 - best.y0) / 2), team: best.team };
  }
  const width = stadium.width > 0 ? stadium.width : 400;
  mouths[0] = mouths[0] || { x: -width, y: 0, hw: 70, team: 0 };
  mouths[1] = mouths[1] || { x: width, y: 0, hw: 70, team: 0 };
  const rIn = Math.max(150, 0.3 * Math.max(100, (Math.abs(mouths[0].x) + Math.abs(mouths[1].x)) / 2), 2.2 * Math.max(mouths[0].hw, mouths[1].hw));
  return { goals, mouths, rIn2: rIn * rIn, rOut2: (1.3 * rIn) ** 2, halfWidth: Math.abs(mouths[1].x - mouths[0].x) / 2, br: ballRadius };
}

const stadiumKey = (s) => [s.name, s.width, s.height, (s.goals || []).map((g) => [g.p0 && g.p0.x, g.p0 && g.p0.y, g.p1 && g.p1.x, g.p1 && g.p1.y].join(',')).join(';')].join('|');

// ¿La pelota que sale en (x,y) con velocidad (vx,vy) llega a un arco del rival? Devuelve
// { tx, ty, onTarget } (punto de llegada a la línea de gol) o null. onTarget = entre los palos;
// un tiro que pasa hasta un 25% del ancho del arco (+ radio de la pelota) afuera cuenta como desviado.
function aimAtGoal(geo, team, x, y, vx, vy, speed) {
  const maxT = BALL_FRICTION_FRAMES * (1 - 2 / speed);
  let best = null;
  for (const g of geo.goals) {
    if (g.team !== (team === 1 ? 2 : 1)) continue;
    const u = g.x1 - g.x0, d = g.y1 - g.y0, p = Math.hypot(u, d);
    if (p < 1e-6) continue;
    const m = u * (y - g.y0) - d * (x - g.x0);   // de qué lado de la línea de gol está la pelota
    const h = u * (0 - g.y0) - d * (0 - g.x0);   // ... y el centro de la cancha
    if (m * h < 0 || Math.abs(m) > Math.max(Math.abs(h), 0.5 * geo.halfWidth * p)) continue; // detrás de la línea o en campo propio
    const f = vx * d - vy * u;
    if (Math.abs(f) < 1e-9) continue;
    const gx = g.x0 - x, gy = g.y0 - y;
    const tt = (gx * d - gy * u) / f;            // ticks hasta la línea (sin fricción)
    const bb = (gx * vy - gy * vx) / f;          // dónde cae sobre el arco: 0..1 = entre los palos
    if (!(tt > 0) || tt > maxT) continue;
    const k = (0.25 * p + geo.br) / p;
    if (bb < -k || bb > 1 + k) continue;
    const onTarget = bb >= 0 && bb <= 1;
    if (best && (!onTarget || best.onTarget)) continue;
    best = { tx: x + vx * tt, ty: y + vy * tt, onTarget };
  }
  return best;
}

// La pasada de análisis siempre va a velocidad máxima: no dibuja nada, así que no hay motivo para frenarla.
async function scanReplay(API, data, { speed = 9999 } = {}) {
  let hint = 1 << 16;
  try { hint = readGoalIndex(data).totalTicks + 2; } catch { /* sin índice legible: el track crece solo */ }
  const track = createTrack(hint);

  const geos = [], geoIdx = new Map();
  let lastStadium = null, lastStadiumIdx = 0;
  const stadiumIndex = (stadium, ballRadius) => {
    if (stadium === lastStadium) return lastStadiumIdx;
    const key = stadiumKey(stadium);
    let i = geoIdx.get(key);
    if (i === undefined) { i = Math.min(255, geos.length); geos[i] = buildGeo(stadium, ballRadius); geoIdx.set(key, i); }
    lastStadium = stadium; lastStadiumIdx = i;
    return i;
  };

  const touches = [];        // { tick, end, id, team, kick, kickTick, seq }
  const goals = [];
  const kicksPending = [];
  const lastTouchOf = new Map(); // id -> índice en touches
  const lastActiveOf = new Map(); // id -> contador de ticks activos en el último contacto
  let seq = 0, prevPhase = -1, lastToucher = -1, active = 0, maxTick = 0;

  const segEvents = [];      // { tick, open|close }
  let segOpen = false;

  const addTouch = (id, team, tick, kick) => {
    const i = touches.length;
    touches.push({ tick, end: tick, id, team, kick, kickTick: kick ? tick : -1, seq });
    lastTouchOf.set(id, i);
    lastToucher = id;
    return i;
  };

  const flushKicks = (st) => {
    for (const k of kicksPending) {
      const i = lastTouchOf.get(k.id);
      const t = i === undefined ? null : touches[i];
      if (t && t.seq === seq && !t.kick && t.end >= k.tick - TOUCH_GAP) { t.kick = true; t.kickTick = k.tick; lastToucher = k.id; }
      else addTouch(k.id, teamId(st.getPlayer(k.id) && st.getPlayer(k.id).team), k.tick, true);
    }
    kicksPending.length = 0;
  };

  const chainStart = (i) => { let c = i; while (c > 0 && touches[c - 1].seq === touches[i].seq && touches[c - 1].id === touches[i].id) c--; return c; };

  // ¿algún toque de la cadena [c0..c1] salió como tiro al arco? (para los desvíos)
  const chainShot = (c0, c1, lastTick) => {
    for (let k = c0; k <= c1; k++) {
      const next = k < touches.length - 1 && touches[k + 1].seq === touches[k].seq ? touches[k + 1].tick : null;
      const s = evalShot(track, geos, touches[k], next, lastTick);
      if (s && s.onTarget) return true;
    }
    return false;
  };

  const onGoal = (scoring, tick, st) => {
    flushKicks(st);
    const gs = st.gameState;
    const name = (id) => { const p = id != null && id >= 0 ? st.getPlayer(id) : null; return p ? p.name : null; };
    let scorerTouch = -1, deflectedBy = null, ownGoal = false;
    if (touches.length && touches[touches.length - 1].seq === seq) {
      const L = touches.length - 1, last = touches[L];
      scorerTouch = L;
      if (last.team !== scoring) {
        // tocó último un rival: desvío de un tiro al arco (el gol es del tirador) o autogol
        const c0 = chainStart(L);
        const prev = c0 > 0 && touches[c0 - 1].seq === seq ? c0 - 1 : -1;
        let kicked = false;
        for (let k = c0; k <= L; k++) if (touches[k].kick) kicked = true;
        if (!kicked && prev >= 0 && touches[prev].team === scoring && tick - touches[c0].tick <= DEFLECT_TICKS &&
            chainShot(chainStart(prev), prev, tick)) { scorerTouch = prev; deflectedBy = last.id; }
        else ownGoal = true;
      }
    }
    const sTouch = scorerTouch >= 0 ? touches[scorerTouch] : null;
    let assist = null, assistPass = null;
    if (sTouch && !ownGoal) {
      const c0 = chainStart(scorerTouch);
      const a = c0 > 0 && touches[c0 - 1].seq === seq ? touches[c0 - 1] : null;
      if (a && a.team === scoring) {
        assist = a.id;
        assistPass = { tick: a.kickTick >= 0 ? a.kickTick : a.end, toTick: touches[c0].tick };
      }
    }
    goals.push({
      index: goals.length + 1, tick, teamId: scoring,
      scorerId: sTouch ? sTouch.id : null, scorer: sTouch ? name(sTouch.id) : null,
      assistId: assist, assist: name(assist), ownGoal,
      deflectedBy: name(deflectedBy),
      shotTick: sTouch ? (sTouch.kickTick >= 0 ? sTouch.kickTick : sTouch.end) : null,
      assistPass,
      red: gs.redScore, blue: gs.blueScore, timeS: Math.round(gs.timeElapsed),
      segment: null, segmentGoal: null,
      _touch: scorerTouch,
    });
  };

  await play(API, data, (ctx) => ({
    onGameStart: () => {
      const t = ctx.reader.getCurrentFrameNo();
      if (segOpen) segEvents.push({ tick: t - 1, open: false });
      segEvents.push({ tick: t, open: true }); segOpen = true;
      seq++; lastToucher = -1;
    },
    onGameStop: () => {
      if (segOpen) { segEvents.push({ tick: ctx.reader.getCurrentFrameNo(), open: false }); segOpen = false; }
    },
    onPlayerBallKick: (id) => { kicksPending.push({ id, tick: ctx.reader.getCurrentFrameNo() }); },
    onTeamGoal: (scoring) => onGoal(scoring, ctx.reader.getCurrentFrameNo(), ctx.reader.state),

    onGameTick: () => {
      const t = ctx.reader.getCurrentFrameNo();
      const st = ctx.reader.state, gs = st.gameState;
      if (!gs) return;
      growTrack(track, t);
      if (t > maxTick) maxTick = t;
      if (!segOpen) { segEvents.push({ tick: t, open: true }); segOpen = true; }

      const ball = gs.physicsState.discs[0];
      const phase = gs.state, paused = gs.pauseGameTickCounter > 0;
      track.game[t] = 1; track.phase[t] = phase; track.paused[t] = paused ? 1 : 0;
      track.stadium[t] = stadiumIndex(gs.stadium, ball.radius);
      track.bx[t] = ball.pos.x; track.by[t] = ball.pos.y; track.bvx[t] = ball.speed.x; track.bvy[t] = ball.speed.y;
      if (phase === 0 && prevPhase !== 0) { seq++; lastToucher = -1; }
      prevPhase = phase;

      const counting = !paused && (phase === 0 || phase === 1);
      if (counting) active++;
      let near = -1, nearD = NEAR_R * NEAR_R, d1 = Infinity, d2 = Infinity;
      const touching = [];
      for (const p of st.players) {
        const d = p.disc;
        if (!d) continue;
        const dx = d.pos.x - ball.pos.x, dy = d.pos.y - ball.pos.y, dd = dx * dx + dy * dy;
        const team = teamId(p.team);
        if (team === 1 && dd < d1) d1 = dd; else if (team === 2 && dd < d2) d2 = dd;
        if (dd < nearD) { nearD = dd; near = p.id; }
        const thr = d.radius + ball.radius + 0.01;
        if (counting && team && dd <= thr * thr) touching.push({ p, team });
      }
      track.near[t] = near; track.d1[t] = d1; track.d2[t] = d2;

      if (touching.length) {
        const lastStill = touching.some((x) => x.p.id === lastToucher);
        for (const { p, team } of touching) {
          const since = active - (lastActiveOf.has(p.id) ? lastActiveOf.get(p.id) : -1e9);
          if (since > TOUCH_GAP || (p.id !== lastToucher && !lastStill)) addTouch(p.id, team, t, false);
          else { const i = lastTouchOf.get(p.id); if (i !== undefined && touches[i].seq === seq) touches[i].end = t; }
          lastActiveOf.set(p.id, active);
        }
      }
      if (kicksPending.length) flushKicks(st);
    },
  }), speed);

  if (segOpen) segEvents.push({ tick: maxTick, open: false });

  // --- partidos ---------------------------------------------------------------------------
  const raw = [];
  for (let i = 0; i < segEvents.length; i++) {
    if (!segEvents[i].open) continue;
    const close = segEvents.slice(i + 1).find((e) => !e.open);
    raw.push({ start: segEvents[i].tick, end: close ? close.tick : maxTick });
  }
  for (const g of goals) g._seg = raw.findIndex((s) => g.tick >= s.start && g.tick <= s.end);
  const segments = [];
  raw.forEach((s, ri) => {
    const mine = goals.filter((g) => g._seg === ri);
    if (!mine.length && s.end - s.start < MIN_SEGMENT_TICKS) return; // prueba suelta sin goles
    const index = segments.length + 1;
    mine.forEach((g, k) => { g.segment = index; g.segmentGoal = k + 1; });
    const lastGoal = mine[mine.length - 1];
    let playTicks = 0; // sin las pausas: los ticks en los que el juego no corre no disparan onGameTick
    for (let t = s.start; t <= s.end && t < track.n; t++) playTicks += track.game[t];
    segments.push({
      index, start: s.start, end: s.end, goals: mine.length,
      red: lastGoal ? lastGoal.red : 0, blue: lastGoal ? lastGoal.blue : 0,
      durationS: Math.round(playTicks / TICK_RATE),
    });
  });
  for (const g of goals) delete g._seg;

  // --- tiros (los que no terminaron en gol) -----------------------------------------------
  const chainEnd = (i) => { let e = i; while (e + 1 < touches.length && touches[e + 1].seq === touches[i].seq && touches[e + 1].id === touches[i].id) e++; return e; };
  const goalChains = new Set(goals.map((g) => g._touch).filter((i) => i >= 0).map(chainEnd));
  const shots = [];
  for (let i = 0; i < touches.length;) {
    let j = i;
    while (j + 1 < touches.length && touches[j + 1].seq === touches[i].seq && touches[j + 1].id === touches[i].id) j++;
    if (!goalChains.has(j)) {
      let shot = null;
      for (let k = i; k <= j; k++) {
        const next = k < touches.length - 1 && touches[k + 1].seq === touches[k].seq ? touches[k + 1].tick : null;
        shot = evalShot(track, geos, touches[k], next, maxTick) || shot;
      }
      if (shot) shots.push(shot);
    }
    i = j + 1;
  }
  for (const g of goals) delete g._touch;

  return { n: maxTick + 1, track, geos, touches, shots, goals, segments };
}

// ¿Este toque salió como tiro hacia el arco rival? Mira la pelota 2 ticks después de la patada
// (o del último contacto), antes del siguiente toque.
function evalShot(track, geos, touch, nextTick, maxTick) {
  const t0 = touch.kickTick >= 0 ? touch.kickTick : touch.end;
  let s = t0 + 2;
  if (nextTick != null && s > nextTick - 1) s = nextTick - 1;
  if (s < t0) s = t0;
  if (s > maxTick || s >= track.n || !track.game[s]) return null;
  const vx = track.bvx[s], vy = track.bvy[s], speed = Math.hypot(vx, vy);
  if (!(speed >= (touch.kick ? SHOT_MIN_SPEED_KICK : SHOT_MIN_SPEED_TOUCH))) return null;
  const hit = aimAtGoal(geos[track.stadium[s]], touch.team, track.bx[s], track.by[s], vx, vy, speed);
  if (!hit) return null;
  return { tick: t0, id: touch.id, team: touch.team, kick: touch.kick, onTarget: hit.onTarget, speed: speed * TICK_RATE, tx: hit.tx, ty: hit.ty };
}

module.exports = { scanReplay, play, TICK_RATE };
