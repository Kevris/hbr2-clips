'use strict';

// Cámara cinematográfica: convierte la intención del director (src/director.js) en un origen y un
// zoom reales para el renderer. Una instancia por ventana de clip (cada clip tiene su propia cámara,
// como en src/camera.js).
//
// Cada frame:
//   1. Arma una CAJA que contiene lo que importa: la pelota y, en proporción a sus pesos, el
//      jugador en foco, el asistente, el autor del gol (festejo) y la boca del arco. El centro de
//      la caja es hacia donde mira la cámara. Con poco zoom también se adelanta a la pelota.
//   2. Elige la escala: entre "cancha entera" (zoom 0) y "plano de juego" (zoom 1, el `--zoom`),
//      más cerca todavía en el festejo. Nunca más cerca de lo que deja ver la caja completa, así que
//      si el autor del gol está lejos de la pelota la cámara se aleja sola en vez de perderlo.
//   3. La escala cambia suavemente (exponencial) y mientras cambia el centro de la caja queda fijo
//      en pantalla: el zoom se hace "hacia" lo que se mira.
//   4. La posición sigue al objetivo con SmoothDamp (resorte críticamente amortiguado, con
//      velocidad): si el objetivo cambia de golpe (de la pelota al autor del gol) la cámara frena y
//      gira en curva en vez de cambiar de dirección de un frame a otro.
//   5. Siempre se mantiene dentro de los límites de la cancha y con la caja a la vista.
// Ante un corte (saque de centro, cambio de mapa...) la cámara salta en seco al nuevo encuadre.

function smoothDamp(pos, vel, target, smoothTime, dt) {
  const omega = 2 / Math.max(smoothTime, 1e-4);
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = pos - target;
  const temp = (vel + omega * change) * dt;
  return { pos: target + (change + temp) * decay, vel: (vel - omega * temp) * decay };
}

// mantiene el intervalo [lo, hi] (con margen) dentro de una vista de ancho `view` centrada en c
function keepInView(c, lo, hi, view, pad) {
  const half = view / 2;
  if (hi - lo + 2 * pad >= view) return (lo + hi) / 2;
  if (c - half > lo - pad) return lo - pad + half;
  if (c + half < hi + pad) return hi + pad - half;
  return c;
}

// limita el centro para que la vista no se salga de [-ext, ext] (si la vista es más ancha, centra)
function clampBounds(c, view, ext) {
  if (!(ext > 0) || view >= 2 * ext) return 0;
  const half = view / 2;
  return c + half > ext ? ext - half : c - half < -ext ? -ext + half : c;
}

function viewOf(stadium, width, height, close) {
  const hw = Math.max(stadium.width > 0 ? stadium.width : 0, stadium.bgWidth > 0 ? stadium.bgWidth + 30 : 0) || 420;
  const hh = Math.max(stadium.height > 0 ? stadium.height : 0, stadium.bgHeight > 0 ? stadium.bgHeight + 30 : 0) || 200;
  const fhw = stadium.bgWidth > 0 ? stadium.bgWidth : hw;   // mitad de la cancha dibujada
  const fhh = stadium.bgHeight > 0 ? stadium.bgHeight : hh;
  const minScale = stadium.maxViewWidth > 0 ? width / stadium.maxViewWidth : 0; // el renderer no deja ver más ancho que esto
  const floor = Math.max(Math.min(width / (2 * hw), height / (2 * hh)), minScale); // cancha entera a la vista
  const fit = Math.max(floor, Math.min(width / (2 * fhw * 0.74), height / (2 * fhh * 0.8))); // plano general (zoom 0)
  return { hw, hh, floor, fit, close: Math.max(close, fit * 1.15), pr: 15 };
}

function createCinemaCamera({ director, width, height, zoom }) {
  let cam = null;            // { x, y, vx, vy, scale }
  let lastTick = null;
  let stadiumRef = null, view = null;
  const dv = {};
  const box = { x0: 0, x1: 0, y0: 0, y1: 0 };

  const fitBox = (bw, bh, margin) => {
    const l = 1 - 2 * margin;
    return Math.min(bw > 0 ? width * l / bw : Infinity, bh > 0 ? height * l / bh : Infinity);
  };
  const extend = (x, y) => {
    if (x < box.x0) box.x0 = x; else if (x > box.x1) box.x1 = x;
    if (y < box.y0) box.y0 = y; else if (y > box.y1) box.y1 = y;
  };

  return {
    // Devuelve { x, y, zoom }: el origen de cámara en coordenadas del mapa y la escala (px por unidad)
    step(st, tick) {
      const gs = st.gameState;
      const stadium = gs.stadium;
      let hard = cam === null || lastTick === null || tick - lastTick > 120;
      if (stadium !== stadiumRef) {
        if (stadiumRef !== null) hard = true;
        stadiumRef = stadium; view = viewOf(stadium, width, height, zoom);
        const p = st.players.find((q) => q.disc);
        view.pr = p ? p.disc.radius : 15;
      }
      const ball = gs.physicsState.discs[0].pos;
      director.at(tick, dv);
      if (!hard && director.hasCut(lastTick, tick)) hard = true;
      const frames = hard || lastTick === null ? 1 : Math.max(1, tick - lastTick);
      lastTick = tick;

      const discOf = (id) => { const p = id >= 0 ? st.getPlayer(id) : null; return p && p.disc ? p.disc : null; };
      const posOf = (id) => { const d = discOf(id); return d ? d.pos : null; };
      const zl = dv.zoom > 0 ? dv.zoom : 0;
      const smoothTime = 0.55 - 0.21 * Math.min(zl, 1);  // más ágil cuanto más cerca

      // 1) la caja
      let px = ball.x, py = ball.y, p, lead = null;
      if (dv.cw > 0 && (p = discOf(dv.c))) {
        lead = p.speed;
        px += (p.pos.x - px) * dv.cw; py += (p.pos.y - py) * dv.cw;
      }
      box.x0 = box.x1 = px; box.y0 = box.y1 = py;
      if (dv.aw > 0 && (p = posOf(dv.a))) extend(px + (p.x - px) * dv.aw, py + (p.y - py) * dv.aw);
      if (dv.bw > 0 && (p = posOf(dv.b))) extend(px + (p.x - px) * dv.bw, py + (p.y - py) * dv.bw);
      if (dv.gw > 0 && dv.gx === dv.gx) extend(px + (dv.gx - px) * dv.gw, py + (dv.gy - py) * dv.gw);
      const boxCx = (box.x0 + box.x1) / 2, boxCy = (box.y0 + box.y1) / 2;
      let cx = boxCx, cy = boxCy;
      const ahead = 1 - Math.min(zl, 1);           // con poco zoom la cámara se adelanta a la pelota
      if (ahead > 0 && dv.x === dv.x) { cx += (dv.x - ball.x) * ahead; cy += (dv.y - ball.y) * ahead; }
      // Un resorte siempre llega tarde a lo que se mueve: con 0.34 s de suavizado el autor del gol, que
      // sigue corriendo, quedaría ~40 unidades detrás del centro. Durante el festejo se apunta un poco
      // delante, donde va a estar, para que quede centrado de verdad (el peso sube con el festejo).
      if (lead) { const k = smoothTime * 60 * dv.cw * dv.cw; cx += lead.x * k; cy += lead.y * k; }

      // 2) la escala
      const pad = view.pr + 4;
      const bw = box.x1 - box.x0 + 2 * pad, bh = box.y1 - box.y0 + 2 * pad;
      const wanted = view.fit * Math.pow(view.close / view.fit, Math.min(zl, 2));
      const ceiling = Math.max(fitBox(bw, bh, 0.06), view.floor);        // tope duro: la caja siempre entra
      let target = Math.max(Math.min(fitBox(bw, bh, 0.12), wanted), view.floor);
      let scale = target;
      const prev = cam ? cam.scale : 0;
      if (!hard && prev > 0) {
        scale = prev * Math.pow(target / prev, 1 - Math.pow(1 - 0.07, frames)); // 7% por frame hacia el objetivo
        if (Math.abs(scale / target - 1) < 0.002) scale = target;
      }
      if (scale > ceiling) scale = ceiling;
      if (!hard && prev > 0 && scale !== prev) {     // el centro de la caja se queda quieto en pantalla mientras se hace zoom
        cam.x = boxCx - (boxCx - cam.x) * (prev / scale);
        cam.y = boxCy - (boxCy - cam.y) * (prev / scale);
      }

      // 3) la posición
      const vw = width / scale, vh = height / scale;
      const padX = pad + 0.04 * vw, padY = pad + 0.04 * vh;
      const goalX = clampBounds(keepInView(cx, box.x0, box.x1, vw, padX), vw, view.hw);
      const goalY = clampBounds(keepInView(cy, box.y0, box.y1, vh, padY), vh, view.hh);
      let x = goalX, y = goalY, vx = 0, vy = 0;
      if (!hard) {
        const dt = frames / 60;
        const rx = smoothDamp(cam.x, cam.vx, goalX, smoothTime, dt);
        const ry = smoothDamp(cam.y, cam.vy, goalY, smoothTime, dt);
        x = rx.pos; vx = rx.vel; y = ry.pos; vy = ry.vel;
      }
      x = clampBounds(keepInView(x, box.x0, box.x1, vw, padX), vw, view.hw);
      y = clampBounds(keepInView(y, box.y0, box.y1, vh, padY), vh, view.hh);

      cam = { x, y, vx, vy, scale };
      return { x, y, zoom: scale, goalX, goalY, boxCx, boxCy, vx, vy };
    },
  };
}

module.exports = { createCinemaCamera };
