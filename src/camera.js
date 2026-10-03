'use strict';

// A dónde debe apuntar la cámara, tick a tick, para los modos 'ball' y 'player' ('game' usa el
// seguimiento propio del renderer y no pasa por acá). Cada ventana de gol tiene su propio
// tracker: si dos goles se solapan, cada uno sigue a su propio jugador sin pisarse.
//
// 'player' apunta siempre al jugador fijo. 'ball' apunta a la pelota hasta handoffTicks después
// del gol, y ahí pasa a ser el autor. El objetivo puede cambiar de golpe (de la pelota al
// jugador), pero la cámara nunca lo hace: usa SmoothDamp (Game Programming Gems 4, el mismo
// algoritmo detrás de Unity's SmoothDamp) en vez de un simple lerp proporcional a la distancia.
// La diferencia importa acá: un lerp común mueve la cámara una fracción de la distancia al
// objetivo en cada frame, así que si el objetivo salta a otro lado, la velocidad de la cámara
// también salta de golpe - eso se ve como un cambio de dirección brusco. SmoothDamp suaviza la
// velocidad además de la posición, así que ante el mismo salto de objetivo la cámara frena y
// gira gradualmente, nunca de un frame a otro.
function smoothDampStep(pos, vel, target, smoothTime, dt) {
  const omega = 2 / Math.max(smoothTime, 0.0001);
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const dx = pos.x - target.x, dy = pos.y - target.y;
  const tx = (vel.x + omega * dx) * dt, ty = (vel.y + omega * dy) * dt;
  return {
    pos: { x: target.x + (dx + tx) * decay, y: target.y + (dy + ty) * decay },
    vel: { x: (vel.x - omega * tx) * decay, y: (vel.y - omega * ty) * decay },
  };
}

// smooth (0-1, como antes): 1 = prácticamente pegada al objetivo, valores bajos = más lenta y
// cinematográfica. Se traduce a un smoothTime en segundos para SmoothDamp.
function smoothTimeFromFraction(smooth) {
  return Math.max(0.05, 0.08 + (1 - Math.min(1, Math.max(0, smooth))) * 0.6);
}

function createCameraTracker({ mode, smooth, ticksPerFrame, followPlayerId = null, handoffTicks = 24, blendTicks = 30 }) {
  const dtS = ticksPerFrame / 60;
  const baseSmoothTime = smoothTimeFromFraction(smooth);
  const handoffSmoothTime = Math.max(0.05, blendTicks / 60); // "duración del traspaso" = smoothTime del SmoothDamp en ese tramo

  let pos = null, vel = { x: 0, y: 0 };
  let lastTick = null;
  let goalTick = null; // tick del gol de esta ventana, null hasta que avisa onGoal()
  let scorerId = followPlayerId;

  function ballPos(state) { return state.gameState.physicsState.discs[0].pos; }

  function playerPos(state, id) {
    if (id == null) return null;
    const p = state.getPlayer?.(id)?.disc?.pos;
    return p ? { x: p.x, y: p.y } : null; // sin disco (se fue / lobby): null, cae a la pelota
  }

  function targetAndTime(state, tick) {
    if (mode === 'player') return { target: playerPos(state, scorerId) || ballPos(state), smoothTime: baseSmoothTime };
    // mode === 'ball'
    if (goalTick == null || tick < goalTick + handoffTicks) return { target: ballPos(state), smoothTime: baseSmoothTime };
    const player = playerPos(state, scorerId);
    if (!player) return { target: ballPos(state), smoothTime: baseSmoothTime }; // autor sin disco (raro): seguimos con la pelota
    return { target: player, smoothTime: handoffSmoothTime };
  }

  function onGoal(tick, playerId) {
    goalTick = tick;
    if (mode === 'ball') scorerId = playerId;
  }

  return {
    step(state, tick) {
      const { target, smoothTime } = targetAndTime(state, tick);
      // salta directo al objetivo en el primer frame y tras cualquier salto grande entre
      // ventanas, igual que antes de tener cámaras por ventana - sin esto arrancaría con
      // velocidad de golpe desde (0,0)
      if (pos === null || lastTick === null || tick - lastTick > ticksPerFrame * 2) {
        pos = { x: target.x, y: target.y };
        vel = { x: 0, y: 0 };
      } else {
        const r = smoothDampStep(pos, vel, target, smoothTime, dtS);
        pos = r.pos; vel = r.vel;
      }
      lastTick = tick;
      return pos;
    },
    onGoal,
  };
}

module.exports = { createCameraTracker };
