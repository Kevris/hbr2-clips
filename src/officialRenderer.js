'use strict';

// Envuelve el defaultRenderer de node-haxball (un port del renderer propio del juego) sobre un
// canvas de node-canvas. El renderer solo le pide a su room extrapolate(), currentPlayerId y
// librariesMap, así que alcanza con una room falsa que siempre devuelve el estado actual del
// replay.
const { createCanvas } = require('canvas');

// sin pérdida, mínima compresión: los frames son temporales y ffmpeg los lee una sola vez
const PNG_OPTS = { compressionLevel: 1 };

function createOfficialRenderer({ API, domShim, images, width, height, zoom = 1.5, overlays = true, camera = 'game' }) {
  const DefaultRenderer = require('node-haxball/examples/renderers/defaultRenderer.js');
  const canvas = createCanvas(width, height);
  canvas.style = {};

  const renderer = new DefaultRenderer(API, { canvas, images, paintGame: true });
  let currentState = null;
  renderer.room = { currentPlayerId: -1, librariesMap: {}, extrapolate: () => currentState };
  renderer.initialize();
  renderer.zoomCoeff = zoom;

  // cámara 'game': el seguimiento propio del juego (se acerca a la pelota 4% por frame, así que
  // se queda atrás en jugadas rápidas). cámaras 'ball'/'player': el origen lo calcula el que
  // llama (ver src/camera.js, una instancia por ventana de gol) y se lo pasa a draw().
  renderer.followMode = camera === 'game';

  return {
    // avanza el reloj falso que anima la cámara/overlays del renderer - llamar una vez por tick
    // renderizado, antes de draw() (aunque draw() se llame varias veces para ese tick, una por
    // cada ventana de gol activa con su propia cámara)
    advance(dtMs) { domShim.advanceClock(dtMs); },
    // origin: { x, y, zoom? } en coordenadas del mapa (zoom opcional: escala en px por unidad, la
    // usa la cámara 'cinema'), o null para dejar que el renderer siga solo (cámara 'game').
    // Devuelve píxeles crudos BGRA (canvas.toBuffer('raw')), no un PNG: evita
    // el costo de comprimir y luego descomprimir cada frame, que era buena parte del tiempo de
    // render entero - ffmpeg los lee directo como rawvideo (ver src/framesToVideo.js).
    draw(state, origin) {
      currentState = state;
      if (origin) {
        renderer.setOrigin(origin);
        renderer.zoomCoeff = origin.zoom > 0 ? origin.zoom : zoom;
      }
      renderer.render();
      return canvas.toBuffer('raw');
    },
    onTeamGoal(...args) { if (overlays) renderer.onTeamGoal(...args); },
    onGameStart(...args) { renderer.onGameStart(...args); },
  };
}

module.exports = { createOfficialRenderer };
