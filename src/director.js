'use strict';

// El "director" decide, para CADA tick del replay, qué debería mirar la cámara y cuánto acercarse.
// No mueve nada: solo produce una intención que después lee la cámara (src/cinemaCamera.js).
// Se calcula una vez, de antemano, a partir de la pasada silenciosa (src/scan.js) - por eso puede
// empezar a acercarse ANTES de que pase la jugada (el gol, el remate) y no detrás de ella.
//
// Por tick deja:
//   zoom         0 = cancha entera ... 1 = plano de juego ... 1.35 = festejo
//   a / aw       jugador en foco principal (el que remata, el que corre al arco) y su peso 0-1
//   b / bw       segundo foco: el que dio la asistencia
//   c / cw       tercer foco: el autor del gol durante el festejo
//   gx,gy / gw   boca del arco que tiene que entrar en el encuadre y su peso
//   x, y         centro base: la pelota 1/3 de segundo en el futuro (la cámara "mira adelante")
//
// Los pesos no saltan: se suavizan (media móvil doble de ~0.7 s) para que la cámara nunca cambie
// de objetivo de golpe. Y nada se suaviza a través de un corte (saque de centro, cambio de mapa,
// pelota teletransportada): cada tramo continuo se trata por separado.
const TICK = 60;
const sec = (s) => Math.round(s * TICK);

const LEVEL = Object.freeze({ wide: 0, danger: 0.5, cue: 0.8, shot: 1, goal: 1, celebrate: 1.35 });

const K = Object.freeze({
  goalLead: sec(2.6),     // el gol arma el plano desde 2.6 s antes (o 1.1 s antes del remate, lo que sea primero)
  shotLead: sec(1.1), shotTail: sec(1.1), shotEndDefault: sec(1.2), shotEndCap: sec(2.5),
  preGoalShot: sec(0.6),  // si no se conoce el remate del gol: 0.6 s antes
  goalHold: sec(0.35),    // se mantiene el plano 0.35 s después del gol antes de pasar al festejo
  celebrateFocusDelay: 20,
  celebrateMax: sec(20),
  cueLead: sec(0.35), cueTail: sec(0.6),
  dangerGap: sec(0.8), dangerMin: sec(0.45),
  gapFill: sec(1.6),      // dos planos separados por menos de 1.6 s se unen
  minRun: sec(1.3),       // un plano dura al menos 1.3 s (si no, parpadea)
  pad: 42,                // los focos empiezan 42 ticks antes para que el peso ya esté arriba
  idReach: 86,            // el foco sigue al mismo jugador hasta 1.4 s después de que el peso baja
  lookAhead: 20,
  smoothZoom: 43, smoothCeleb: 21,
  cueSpeed2: 5.5 * 5.5,   // u/tick^2: pelota rápida hacia un arco
  attackerR2: 110 * 110,
});

function createDirector(tl) {
  const tr = tl.track, n = tl.n, geos = tl.geos;
  const clampTick = (t) => (t < 0 ? 0 : t >= n ? n - 1 : t | 0);

  const isCut = (t) => {
    if (!(t > 0) || t >= n) return false;
    const on = tr.game[t];
    if (!tr.game[t - 1] !== !on) return true;                   // empieza / termina el juego
    if (!on) return false;
    if (tr.stadium[t] !== tr.stadium[t - 1]) return true;       // cambio de mapa
    if (tr.phase[t - 1] === 2 && tr.phase[t] !== 2) return true; // fin del festejo: se reposiciona todo
    const dx = tr.bx[t] - tr.bx[t - 1], dy = tr.by[t] - tr.by[t - 1];
    return dx * dx + dy * dy > 3600;                            // la pelota se teletransportó
  };
  const playable = (t) => tr.game[t] !== 0 && (tr.phase[t] === 1 || tr.phase[t] === 2);
  const steady = (t) => playable(t) && !isCut(t);

  // tramos continuos [inicio, fin] (plano: pares)
  const segs = [];
  { let s = 0; for (let t = 1; t < n; t++) if (isCut(t)) { segs.push(s, t - 1); s = t; } segs.push(s, n - 1); }

  const zoom = new Float32Array(n);
  const wA = new Float32Array(n), wB = new Float32Array(n), wC = new Float32Array(n), wG = new Float32Array(n);
  const idA = new Int32Array(n).fill(-1), idB = new Int32Array(n).fill(-1), idC = new Int32Array(n).fill(-1);
  const gx = new Float32Array(n).fill(NaN), gy = new Float32Array(n).fill(NaN);
  const goalAt = new Int32Array(n).fill(-1);

  // aplica fn a los ticks de [from, to] que estén en el mismo tramo continuo que `t` y se puedan jugar
  const within = (t, from, to, fn) => {
    const c = clampTick(t), m = segs.length / 2;
    let lo = 0, hi = m - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[2 * mid] <= c) lo = mid; else hi = mid - 1; }
    const a = Math.max(segs[2 * lo], from | 0), b = Math.min(segs[2 * lo + 1], to | 0);
    for (let k = a; k <= b; k++) if (playable(k)) fn(k);
  };
  const raise = (t, from, to, level) => within(t, from, to, (k) => { if (level > zoom[k]) zoom[k] = level; });
  const focus = (w, ids, t, from, to, who) => { if (who != null && who >= 0) within(t, from, to, (k) => { w[k] = 1; ids[k] = who; }); };
  const mouth = (t, from, to, m) => within(t, from, to, (k) => { wG[k] = 1; gx[k] = Math.round(m.x); gy[k] = Math.round(m.y); });
  const mouthAt = (t, ballX) => geos[tr.stadium[clampTick(t)]].mouths[ballX > 0 ? 1 : 0];

  // --- 1) pelota rápida hacia un arco, y zona de peligro ---------------------------------------
  {
    let inside = -1, runStart = -1, runLast = -1, runSide = 0, lastCue = -2, cueWho = -1;
    const closeRun = () => {
      if (runStart >= 0 && runLast - runStart >= K.dangerMin) {
        const m = geos[tr.stadium[runStart]].mouths[runSide];
        raise(runStart, runStart - K.cueLead, runLast + K.cueTail, LEVEL.danger);
        mouth(runStart, runStart - K.cueLead - K.pad, runLast + K.cueTail, m);
      }
      runStart = -1;
    };
    for (let t = 0; t < n; t++) {
      const bx = tr.bx[t], by = tr.by[t];
      if (!(tr.game[t] && tr.phase[t] === 1 && !tr.paused[t]) || !(bx === bx && by === by)) {
        inside = -1;
        if (runStart >= 0 && t - runLast > K.dangerGap) closeRun();
        continue;
      }
      const geo = geos[tr.stadium[t]], vx = tr.bvx[t], vy = tr.bvy[t];
      if (vx !== 0 && vx * vx + vy * vy >= K.cueSpeed2) {
        const m = geo.mouths[vx > 0 ? 1 : 0];
        const ticks = (m.x - bx) / vx;           // ticks hasta la línea sin fricción
        const loss = 0.01 * ticks;
        if (ticks > 0 && loss < 0.95) {
          const real = Math.log(1 - loss) / Math.log(0.99); // con la fricción de 0.99 por tick
          if (real < 80 && Math.abs(by + vy * ticks - m.y) < m.hw + 50) {
            if (t - lastCue > 1) cueWho = tr.near[Math.max(0, t - 2)];
            lastCue = t;
            const arrive = t + Math.ceil(real);
            raise(t, t - K.cueLead, arrive + K.cueTail, LEVEL.cue);
            focus(wA, idA, t, t - K.cueLead - K.pad, arrive + K.pad, cueWho);
            mouth(t, t - K.pad, arrive, m);
          }
        }
      }
      const side = bx < 0 ? 0 : 1, m = geo.mouths[side];
      const ddx = bx - m.x, ddy = by - m.y;
      inside = ddx * ddx + ddy * ddy <= (inside === side ? geo.rOut2 : geo.rIn2) ? side : -1;
      let attackers = false;
      if (inside >= 0) {
        const r1 = tr.d1[t] <= K.attackerR2, r2 = tr.d2[t] <= K.attackerR2;
        attackers = m.team === 1 ? r2 : m.team === 2 ? r1 : (r1 || r2);
      }
      if (attackers) {
        if (runStart >= 0 && (side !== runSide || t - runLast > K.dangerGap)) closeRun();
        if (runStart < 0) { runStart = t; runSide = side; }
        runLast = t;
      } else if (runStart >= 0 && t - runLast > K.dangerGap) closeRun();
    }
    closeRun();
  }

  // --- 2) tiros que no fueron gol ---------------------------------------------------------------
  for (const s of tl.shots) {
    if (s.tick < 0 || s.tick >= n) continue;
    // el tiro "termina" cuando otro jugador toca la pelota (máx. 2.5 s), o 1.2 s después si nadie
    let end = -1;
    for (const tc of tl.touches) {
      if (tc.tick <= s.tick) continue;
      if (tc.tick - s.tick > K.shotEndCap) break;
      if (tc.id !== s.id) { end = tc.tick; break; }
    }
    if (end < 0) end = s.tick + K.shotEndDefault;
    if (end - s.tick > K.shotEndCap) end = s.tick + K.shotEndCap;
    const strong = s.kick && s.speed >= 420;
    raise(s.tick, s.tick - K.shotLead, end + K.shotTail, s.onTarget || strong ? LEVEL.shot : LEVEL.cue);
    focus(wA, idA, s.tick, s.tick - K.shotLead - K.pad, end + K.pad, s.id);
    if (s.onTarget) mouth(s.tick, s.tick - K.pad, end + K.pad, mouthAt(s.tick, s.tx));
  }

  // --- 3) goles: plano previo, festejo centrado en el autor -------------------------------------
  const goals = [];
  for (const g of tl.goals) {
    const h = g.tick;
    if (h < 0 || h >= n) continue;
    let end = h;
    const p0 = tr.phase[h] === 2 ? h : (h + 1 < n && tr.phase[h + 1] === 2 ? h + 1 : -1);
    if (p0 >= 0) { end = p0; while (end + 1 < n && end + 1 - h < K.celebrateMax && tr.game[end + 1] && tr.phase[end + 1] === 2) end++; }
    else end = Math.min(n - 1, h + 150);
    const gi = goals.length;
    goals.push({ tick: h, end, teamId: g.teamId, scorer: g.scorer, assist: g.assist, ownGoal: g.ownGoal, red: g.red, blue: g.blue, scorerId: g.scorerId });
    for (let t = h; t <= end; t++) goalAt[t] = gi;

    const shotTick = g.shotTick != null ? g.shotTick : Math.max(0, h - K.preGoalShot);
    const start = Math.min(h - K.goalLead, shotTick - K.shotLead);
    raise(h, start, h - 1, LEVEL.goal);
    raise(h, h, h + K.goalHold - 1, LEVEL.goal);
    focus(wA, idA, h, start - K.pad, h + K.pad, g.scorerId);
    const m = mouthAt(h, Number.isFinite(tr.bx[h]) ? tr.bx[h] : 0);
    mouth(h, shotTick - K.pad, h, m);
    const ap = g.assistPass;
    if (ap && ap.toTick <= shotTick && ap.tick >= start - sec(2)) focus(wB, idB, h, start - K.pad, ap.toTick + K.pad, g.assistId);
    for (let t = h + K.goalHold; t <= end && tr.game[t]; t++) zoom[t] = LEVEL.celebrate;
    if (g.scorerId != null && g.scorerId >= 0) within(h, h + K.goalHold + K.celebrateFocusDelay, end, (k) => { wC[k] = 1; idC[k] = g.scorerId; });
  }

  // --- 4) limpieza: huecos cortos, duración mínima, suavizado, identidad de los focos ----------
  fillZoom(zoom, n, steady);
  fillWeights(wA, n, steady, (t, from) => { idA[t] = idA[from]; });
  fillWeights(wG, n, steady, (t, from) => { gx[t] = gx[from]; gy[t] = gy[from]; });

  const tmp = new Float32Array(n);
  smooth(zoom, tmp, segs, K.smoothZoom);
  smooth(wA, tmp, segs, K.smoothZoom);
  smooth(wB, tmp, segs, K.smoothZoom);
  smooth(wG, tmp, segs, K.smoothZoom);
  smooth(wC, tmp, segs, K.smoothCeleb);

  const reach = new Int32Array(n);
  propagate((i) => idA[i] < 0, (d, s) => { idA[d] = idA[s]; }, segs, K.idReach, reach);
  propagate((i) => idB[i] < 0, (d, s) => { idB[d] = idB[s]; }, segs, K.idReach, reach);
  propagate((i) => idC[i] < 0, (d, s) => { idC[d] = idC[s]; }, segs, K.idReach, reach);
  propagate((i) => gx[i] !== gx[i], (d, s) => { gx[d] = gx[s]; gy[d] = gy[s]; }, segs, K.idReach, reach);
  for (let t = 0; t < n; t++) {
    if (zoom[t] < 1e-4) zoom[t] = 0;
    if (idA[t] < 0) wA[t] = 0;
    if (idB[t] < 0) wB[t] = 0;
    if (idC[t] < 0) wC[t] = 0;
    if (gx[t] !== gx[t]) wG[t] = 0;
  }

  // centro base: promedio de la pelota en los próximos `lookAhead` ticks (sin cruzar un corte)
  const look = (t, out) => {
    const x0 = tr.bx[t], y0 = tr.by[t];
    if (!(x0 === x0 && y0 === y0)) return false;
    let sx = x0, sy = y0, c = 1;
    for (let k = t + 1; k <= Math.min(n - 1, t + K.lookAhead) && tr.game[k] && !isCut(k); k++) { sx += tr.bx[k]; sy += tr.by[k]; c++; }
    out.x = sx / c; out.y = sy / c;
    return true;
  };

  return {
    n, goals, LEVEL,
    // ¿hubo un corte entre dos ticks? (la cámara salta en vez de deslizarse)
    hasCut(t0, t1) {
      if (t1 - t0 > 600) return true;
      for (let t = t0 + 1; t <= t1; t++) if (isCut(t)) return true;
      return false;
    },
    at(tick, out = {}) {
      out.x = NaN; out.y = NaN; out.zoom = 0; out.goal = -1;
      out.a = -1; out.aw = 0; out.b = -1; out.bw = 0; out.c = -1; out.cw = 0; out.gx = NaN; out.gy = NaN; out.gw = 0;
      const t = clampTick(tick);
      if (!tr.game[t]) return out;
      out.zoom = zoom[t]; out.goal = goalAt[t];
      out.a = idA[t]; out.aw = wA[t]; out.b = idB[t]; out.bw = wB[t]; out.c = idC[t]; out.cw = wC[t];
      if (wG[t] > 0) { out.gx = gx[t]; out.gy = gy[t]; out.gw = wG[t]; }
      look(t, out);
      return out;
    },
  };
}

// Une dos planos separados por un hueco corto (con el valor menor de los dos) y alarga los planos
// más cortos que minRun. Solo sobre ticks "estables" (jugando y sin cortes).
function fillZoom(z, n, ok) {
  let i = 0, prevEnd = -1, runStart = -1;
  while (i < n) {
    if (z[i] <= 0) { i++; continue; }
    const s = i;
    while (i < n && z[i] > 0) i++;
    let merged = false;
    if (prevEnd >= 0 && s - prevEnd - 1 < K.gapFill) {
      merged = true;
      for (let t = prevEnd + 1; t < s; t++) if (!ok(t)) { merged = false; break; }
      if (merged) { const v = Math.min(z[prevEnd], z[s]); for (let t = prevEnd + 1; t < s; t++) z[t] = v; }
    }
    if (!merged) runStart = s;
    let e = i - 1;
    while (e - runStart + 1 < K.minRun && e + 1 < n && z[e + 1] <= 0 && ok(e + 1)) { z[e + 1] = z[e]; e++; }
    prevEnd = e; i = e + 1;
  }
}

// Rellena los huecos cortos entre dos tramos de un peso (los dos tramos son del mismo foco).
function fillWeights(w, n, ok, copy) {
  let i = 0, prev = -1;
  while (i < n) {
    if (w[i] <= 0) { i++; continue; }
    const s = i;
    while (i < n && w[i] > 0) i++;
    if (prev >= 0 && s - prev - 1 < K.gapFill) {
      let all = true;
      for (let t = prev + 1; t < s; t++) if (!ok(t)) { all = false; break; }
      if (all) for (let t = prev + 1; t < s; t++) { w[t] = 1; copy(t, prev); }
    }
    prev = i - 1;
  }
}

// media móvil centrada (ventana 2*half+1), con los bordes del tramo repetidos
function boxBlur(src, dst, a, b, win) {
  const half = win >> 1, at = (i) => src[i < a ? a : i > b ? b : i];
  let sum = 0;
  for (let i = a - half; i <= a + half; i++) sum += at(i);
  const k = 1 / (2 * half + 1);
  for (let i = a; i <= b; i++) { dst[i] = sum * k; sum += at(i + half + 1) - at(i - half); }
}
// dos pasadas = ventana triangular; el resultado queda en `arr`
function smooth(arr, tmp, segs, win) {
  for (let s = 0; s < segs.length; s += 2) { boxBlur(arr, tmp, segs[s], segs[s + 1], win); boxBlur(tmp, arr, segs[s], segs[s + 1], win); }
}

// Hace que los huecos vacíos (isEmpty) tomen la identidad del dato vacío más cercano en un radio
// de `reach` ticks, sin cruzar tramos. Así el foco sigue apuntando al mismo jugador mientras su peso
// sube y baja, en vez de saltar a otro.
function propagate(isEmpty, copy, segs, reach, scratch) {
  for (let s = 0; s < segs.length; s += 2) {
    const a = segs[s], b = segs[s + 1];
    let last = -1;
    for (let i = a; i <= b; i++) {
      if (!isEmpty(i)) { last = i; scratch[i] = i; } else scratch[i] = last >= 0 && i - last <= reach ? last : -1;
    }
    let next = -1;
    for (let i = b; i >= a; i--) {
      if (scratch[i] === i) { next = i; continue; }
      let src = scratch[i];
      if (next >= 0 && next - i <= reach && (src < 0 || next - i < i - src)) src = next;
      if (src >= 0) copy(i, src);
    }
  }
}

module.exports = { createDirector, LEVEL };
