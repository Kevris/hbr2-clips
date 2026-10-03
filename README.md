# hbr2-clips

![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![ffmpeg](https://img.shields.io/badge/ffmpeg-incluido-informational)
![Licencia](https://img.shields.io/badge/licencia-ISC-blue)

Saca clips en mp4 (o gif) de los goles de una grabación de HaxBall (`.hbr2`), con el renderer y los
sonidos del propio juego, y arma resúmenes de partido con todos los goles seguidos.

Qué hace:

- Detecta los partidos que hay dentro de una grabación (una grabación puede traer varios) y los goles
  de cada uno, con autor y asistente.
- Renderiza cada gol con una cámara que se acerca a la jugada antes del remate y deja centrado al autor
  durante el festejo.
- Junta los goles en un solo video, con transiciones. Puede ser uno por partido, y si un partido quedó
  repartido en varias grabaciones, las junta en un único resumen.

Se puede usar de tres maneras: por línea de comandos, como librería dentro de otro proyecto (por ejemplo
un bot de Discord) o como API HTTP.

**Índice:** [Requisitos](#requisitos) · [Uso rápido](#uso-rápido) · [Qué goles se renderizan](#qué-goles-se-renderizan) ·
[Resúmenes de partidos](#resúmenes-de-partidos) · [Usarlo desde otro proyecto](#usarlo-desde-otro-proyecto-el-bot) ·
[API HTTP](#api-http) · [La cámara](#la-cámara) · [Opciones](#opciones) · [Cuánto tarda](#cuánto-tarda) ·
[Notas](#notas) · [Pendientes](#pendientes) · [Pruebas](#pruebas) · [Licencia](#licencia)

---

## Requisitos

- Node.js 18 o superior.
- `assets/res.dat`: el zip que descarga el cliente de HaxBall al abrir haxball.com/play (lo ves en la
  pestaña Network del navegador). Es contenido de HaxBall, así que no viene en el repo: cada quien pone
  su copia en `assets/res.dat`. Está en el `.gitignore` para que no se suba por accidente.
- ffmpeg no hay que instalarlo: viene como dependencia de npm (`ffmpeg-static`), así que funciona igual
  en Windows, Linux, Mac y en hostings de bots donde solo hay `npm install` y `npm start`. Si prefieres
  el ffmpeg del sistema, define `FFMPEG_PATH` con la ruta al binario.

```bash
npm install
```

---

## Uso rápido

```bash
node src/extractGoalClip.js replay.hbr2 --list              # qué trae la grabación (no renderiza nada)
node src/extractGoalClip.js replay.hbr2 --goal 3            # un gol
node src/extractGoalClip.js replay.hbr2 --goal seg-1 --merge  # el partido 1 entero, en un solo video
node src/extractGoalClip.js replay.hbr2 --merge-per-match   # un video por partido
```

Sin `--goal` renderiza todos los goles. Todo sale en `out/`: un `goal_N.mp4` por gol, más `all.mp4`
(con `--merge`) o `match_1.mp4`, `match_2.mp4`... (con `--merge-per-match`).

`--list` muestra los partidos y los goles con su autor y asistente, que es lo que necesitas para decidir
qué pedir:

```
10 goal(s), 2 match(es), 27:38 of replay

Match 1  (10:25, final 0-4, 4 goal(s))   --goal seg-1
  #1  1:17  0-1  blue  Frxddy, assist TUKU LEON
  ...
```

Todas las opciones de la CLI:

```
node src/extractGoalClip.js replay.hbr2 [--list]
    [--goal all | N | 1,3,4 | seg-2] [--segment 1,2] [--team red|blue] [--scorer nombre]
    [--merge | --merge-per-match] [--transition fadeblack|fade|none|...] [--transition-ms 500]
    [--before S] [--after S] [--fps 30] [--zoom 1.6] [--size 1280x720]
    [--format mp4|gif] [--gif-width 640]
    [--camera cinema|game|ball|player] [--follow playerId] [--smooth 0.2] [--handoff 400] [--blend 500]
    [--watermark "texto"] [--watermark-image logo.png] [--watermark-position bottom-right] [--watermark-opacity 0.7]
    [--music song.mp3] [--music-volume 0.35]
    [--no-poster] [--no-sound] [--no-crowd] [--no-overlays] [--res ruta.dat] [--skip-speed 9999]
```

Qué hace cada una está en la [tabla de opciones](#opciones).

---

## Qué goles se renderizan

Una grabación puede traer varios partidos: se corta el juego y se empieza otro con el marcador en 0. El
proyecto los detecta solo con los eventos de inicio y fin de juego y los numera 1, 2, 3... Una prueba suelta
(sin goles y de menos de 30 s) no cuenta como partido.

Cada gol conserva su número dentro de toda la grabación: `goal_5.mp4` es el quinto gol del replay, aunque
sea el primero del partido 2. Además cada gol trae `segment` (el partido) y `segmentGoal` (qué número es
dentro de ese partido).

Para elegir goles se usa una lista de fichas que se suman:

| Ficha | Qué elige |
|---|---|
| `all`, `all-goal`, `all-goals` | todos los goles (es lo que pasa si no pones nada) |
| `3` | el gol 3 de la grabación |
| `seg-2` (también `seg2`, `match-2`, `partido-2`, `p2`) | todos los goles del partido 2 |

`--goal seg-1,7` es todo el partido 1 más el gol 7. Encima de eso hay dos filtros que acotan:
`--team red|blue` (el equipo que convirtió) y `--scorer nombre` (parte del nombre del autor, sin importar
mayúsculas). Por ejemplo, `--goal seg-2 --team red` son los goles del rojo en el partido 2.

`--segment 1,2` es un atajo para `seg-1,seg-2`. Se suma a `--goal`, no lo cruza: `--segment 2 --goal 1`
da todo el partido 2 más el gol 1 de la grabación.

Si el filtro no deja ningún gol, la CLI lo avisa y la API responde 400. Una ficha que no se entiende da un
error que dice cuáles se aceptan.

En un autogol, `team` es el equipo al que le suman el gol y `scorer` el jugador que lo metió en contra
(`ownGoal: true`). Si un rival desvía un remate al arco sin querer, el gol es del que remató y
`deflectedBy` dice quién lo desvió.

---

## Resúmenes de partidos

Para el resumen de un partido, solo con goles, lo más cómodo es pedir un video por partido:

```bash
node src/extractGoalClip.js grabacion.hbr2 --merge-per-match
# out/match_1.mp4, out/match_2.mp4 ... (uno por cada partido de la grabación)
```

Sale todo de una sola pasada por el replay, así que es bastante más barato que pedir cada partido por
separado. Si solo quieres uno: `--goal seg-2 --merge` deja los goles del partido 2 en `out/all.mp4`.

### Si el partido quedó en dos grabaciones

Con `summarizeMatch` le das las grabaciones en orden, cada una con los segmentos que cuentan, y devuelve
un solo video:

```js
const { summarizeMatch } = require('./src');

const r = await summarizeMatch(
  [
    { replay: 'jornada3_a.hbr2', segments: [2] },       // de la primera grabación, el partido 2
    { replay: 'jornada3_b.hbr2', segments: [1] },       // de la segunda, el partido 1
  ],
  'resumenes/jornada3.mp4',
  { width: 1280, height: 720 },
);
// r.file       ruta del video
// r.goalCount  cuántos goles entraron
// r.goals      los goles en orden, con scorer, assist, red, blue, part (de qué grabación)
```

Cada parte acepta `segments` (un número o una lista), o `goals`, `team` y `scorer` si quieres afinar más (es
lo mismo que en [Qué goles se renderizan](#qué-goles-se-renderizan)). Sin ninguno entran todos sus goles.
Una lista vacía (`segments: []`) significa que de esa grabación no entra nada y se salta. Si no queda ningún
gol en total, lanza un error en vez de generar un video vacío. Las demás opciones son las de la
[tabla](#opciones); `keepClips: true` deja también los clips sueltos junto al video.

### Transiciones

Entre un gol y el siguiente hay una transición de 0.5 s. La que viene por defecto, `fadeblack`, baja a
negro y sube al gol siguiente, y el audio se funde igual. Las opciones son `fadeblack`, `fade`, `fadewhite`,
`dissolve`, `wipeleft`, `wiperight`, `slideleft`, `slideright` y `none`. `none` pega los clips en seco, sin
recodificar, y es más rápido.

Los clips se solapan durante la transición, así que el video dura la suma de los goles menos lo que dure
cada unión. La transición se acorta sola si es más larga que casi la mitad del clip más corto. La música de
fondo (`--music`) se mezcla por debajo, en cada video de partido.

### Portada

Este proyecto no la genera. Para poner una imagen de 1.5 s antes de un `match_N.mp4` (ajusta `W`, `H` y
`FPS` a los del video):

```bash
ffmpeg -loop 1 -framerate FPS -t 1.5 -i portada.png \
       -f lavfi -t 1.5 -i anullsrc=r=48000:cl=stereo \
       -i match_1.mp4 \
       -filter_complex "[0:v]scale=W:H,setsar=1,format=yuv420p[c];[2:v]setsar=1,format=yuv420p[v];[c][1:a][v][2:a]concat=n=2:v=1:a=1[outv][outa]" \
       -map "[outv]" -map "[outa]" -c:v libx264 -profile:v high -crf 18 -c:a aac -b:a 160k -ar 48000 \
       -movflags +faststart resumen.mp4
```

Si el video salió sin sonido (`--no-sound`), quita la entrada de `anullsrc` y usa `concat=n=2:v=1:a=0`. El
ffmpeg que ya trae el proyecto sirve: `require('ffmpeg-static')`. Los videos salen por defecto a 960x540 y
60 fps; si usas `--size` o `--fps`, usa esos valores.

---

## Usarlo desde otro proyecto (el bot)

Copia la carpeta del proyecto entera dentro del bot (o súbela como paquete propio). `src/` no depende de
nada que esté fuera de esa carpeta, y de las dependencias solo usa `node-haxball`, `canvas`, `adm-zip` y
`ffmpeg-static`: `express`, `multer` y `dotenv` son solo del servidor, así que si no lo vas a usar no hacen
falta. Pon `res.dat` en `assets/` o pasa su ruta en la opción `resDat`.

```js
const { listReplay, summarizeMatch, extractGoalClips } = require('./hbr2-clips');

// 1) qué trae una grabación (no renderiza nada; son unos 1.5 s por cada 100 mil ticks, que son unos 28 minutos de grabación)
const info = await listReplay('grabaciones/partido.hbr2');
// info.segments -> [{ index, goals, red, blue, durationS }, ...]   (durationS = tiempo de juego, sin pausas)
// info.goals    -> [{ index, segment, segmentGoal, team, scorer, assist, ownGoal, red, blue, timeS }, ...]

// 2) el resumen, con los segmentos que el bot dio por válidos (una o varias grabaciones)
const r = await summarizeMatch([{ replay: 'grabaciones/partido.hbr2', segments: [1] }], 'resumen.mp4', {
  width: 1280, height: 720, resDat: '/ruta/a/res.dat',
});

// 3) o los clips sueltos, para más control
const clips = await extractGoalClips('grabaciones/partido.hbr2', './out', { onlyGoal: 'seg-1', merge: true });
// clips: [{ file, poster, index, segment, segmentGoal, team, scorer, assist, ownGoal, red, blue, timeS }, ...]
// clips.merged: ruta de all.mp4 con merge; clips.matches: [{ segment, goals, file }] con mergeBy: 'match'
```

Las opciones de `extractGoalClips` y `summarizeMatch` son las de la [tabla](#opciones), con los nombres de
la columna "Librería / API". También se exportan `mergeClips` (une clips con transición), `selectGoals` y
`readGoalIndex` (la lista de goles que trae el propio `.hbr2`, al instante pero sin autor ni partidos).

Un render usa bastante CPU y memoria. El servidor de este proyecto limita a 2 a la vez
(`MAX_CONCURRENT_RENDERS`); en el bot conviene hacer algo parecido, con una cola.

---

## API HTTP

```bash
npm start          # arranca en el puerto 3000 (configurable con PORT)
```

Variables de entorno opcionales: `PORT`, `DATA_DIR` (dónde guarda archivos temporales), `MAX_UPLOAD_MB`
(50 por defecto), `MAX_CONCURRENT_RENDERS` (2; súbelo solo si el servidor tiene CPU de sobra),
`MAX_AGE_MINUTES` (120; a los cuántos minutos se borran replays y renders), `CORS_ORIGIN` (`*` por
defecto; en producción pon el dominio de tu web), `WATERMARK_TEXT` / `WATERMARK_IMAGE` y
`WATERMARK_FORCE=true` (el cliente ya no puede apagarla ni cambiar el texto).

`index.html` es un panel de prueba en un solo archivo: ábrelo con doble clic, pon la dirección del servidor
en `api_base` y sube un replay. Permite elegir goles o partidos enteros, la cámara, las transiciones y
un video por partido.

| Método | Ruta | Qué hace |
|:---:|---|---|
| `GET` | `/health` | chequeo simple, devuelve `{ ok: true }` |
| `POST` | `/api/replays` | sube un `.hbr2` (campo multipart `replay`) y devuelve partidos y goles |
| `GET` | `/api/replays/:id` | vuelve a consultar un replay ya subido |
| `POST` | `/api/replays/:id/render` | encola el render |
| `GET` | `/api/jobs/:id` | progreso y URLs de descarga |
| `GET` | `/files/:jobId/:filename` | descarga un archivo ya renderizado |
| `DELETE` | `/api/replays/:id` | borra un replay antes de que expire solo |

**a) Subir el replay** (todavía no renderiza nada):

```bash
curl -F "replay=@replay.hbr2" http://localhost:3000/api/replays
# { "replayId": "abc123", "totalGoals": 10, "durationS": 1658,
#   "segments": [ { "index": 1, "goals": 4, "red": 0, "blue": 4, "durationS": 624 }, ... ],
#   "goals": [ { "index": 1, "segment": 1, "segmentGoal": 1, "team": "blue", "scorer": "Frxddy",
#                "assist": "TUKU LEON", "ownGoal": false, "red": 0, "blue": 1, "timeS": 77, "replayS": 48 }, ... ] }
# timeS es el reloj del partido, replayS el punto de la grabación
```

**b) Pedir el render:**

```bash
curl -X POST http://localhost:3000/api/replays/abc123/render \
  -H "Content-Type: application/json" \
  -d '{"goals": "seg-2", "merge": true}'
# { "jobId": "xyz789", "status": "processing" }
```

En `goals` va lo mismo que en la CLI: `"all"`, `[1,3]`, `"seg-2"`, `["seg-1", 7]`; y además `team`,
`scorer` y `segment`. Para un video por partido: `{"mergeBy": "match", "transition": "fadeblack"}`. Si algo no
coincide (una selección vacía, una transición que no existe) responde 400 de inmediato. El resto de
opciones del body son las de la [tabla](#opciones), por ejemplo `before` y `after`.

Para agregar música de fondo al video combinado, el mismo endpoint acepta `multipart/form-data`: un campo
`music` con el audio y un campo `options` con el JSON de arriba como texto.

```bash
curl -X POST http://localhost:3000/api/replays/abc123/render \
  -F "music=@song.mp3" -F 'options={"goals":"all","merge":true}'
```

**c) Consultar y descargar:**

```bash
curl http://localhost:3000/api/jobs/xyz789
# mientras procesa: { "jobId": "xyz789", "status": "processing" }
# al terminar:      { "status": "done",
#                     "files": [{ "index": 1, "segment": 1, "team": "blue", "scorer": "...", "assist": "...", "url": "http://.../files/xyz789/goal_1.mp4" }, ...],
#                     "mergedUrl": "http://localhost:3000/files/xyz789/all.mp4",
#                     "matches": null }   # con mergeBy "match": [{ "segment": 1, "goals": 4, "url": ".../match_1.mp4" }, ...]
```

---

## La cámara

`--camera cinema` es la que viene por defecto. No sigue la pelota: sigue un plano que se decide de antemano.
Antes de renderizar hay una pasada silenciosa por el replay (`src/scan.js`) que detecta toques, remates y
goles. Con eso, el director (`src/director.js`) decide en cada momento qué mirar y cuánto acercarse, y la
cámara (`src/cinemaCamera.js`) solo sigue esa decisión con suavidad.

En un gol pasa esto:

1. Empieza en plano general, con la cancha casi entera, adelantándose un poco a la pelota.
2. Se va cerrando unos 2.6 s antes del gol (o 1.1 s antes del remate, lo que ocurra primero). En el
   encuadre entran la pelota, el que va a rematar, el asistente mientras da el pase y el arco al que va. Si
   están muy lejos entre sí, la cámara se abre sola para que entren todos.
3. Desde 0.35 s después del gol se acerca más y pasa al autor, que queda centrado aunque siga corriendo
   (la cámara apunta un poco por delante de él para compensar el retraso del suavizado).

Un tiro fuerte al arco o una pelota rápida hacia un arco también cierran el plano unos instantes, y la
pelota rondando un arco con atacantes cerca activa un plano de peligro más suave.

Para que no se sienta pegada a la pelota:

- El foco en cada jugador, en el asistente y en el arco sube y baja gradualmente (unos 0.7 s), así que la
  cámara nunca cambia de objetivo de un frame al siguiente.
- El centro sigue al objetivo con un resorte con velocidad (SmoothDamp). Si el objetivo cambia de golpe, la
  cámara frena y gira en curva en lugar de cambiar de dirección en seco.
- El zoom se hace hacia lo que se está mirando: mientras cambia la escala, el centro del encuadre se queda
  quieto en pantalla.
- Ante un corte (saque de centro, cambio de mapa, la pelota teletransportada) la cámara salta al nuevo
  encuadre, como un corte de edición, en vez de deslizarse.
- Siempre se queda dentro de los límites del mapa y respeta el `maxViewWidth` del estadio.

Los tiempos y niveles de zoom son constantes con nombre al principio de `src/director.js` y
`src/cinemaCamera.js`, para ajustarlos sin leer el resto. La idea de la cámara viene de cómo se mueve el
reproductor del analizador de replays de Spike. `--camera ball` conserva la cámara anterior (sigue la
pelota y luego pasa al autor), y `player` y `game` también siguen disponibles.

---

## Opciones

Valen para la CLI, la librería y la API, aunque no todas están en los tres lados (la columna queda vacía
cuando no aplica).

| Qué hace | CLI | Librería / API | Por defecto |
|---|---|---|---|
| Qué goles | `--goal all\|N\|1,2,3\|seg-2` (se puede repetir) | `onlyGoal` / `goals` | todos |
| Goles de ciertos partidos | `--segment 1,2` (o `--match`) | `segment` | todos |
| Goles de un equipo (el que convirtió) | `--team red\|blue` | `team` | ambos |
| Goles de un jugador (parte del nombre) | `--scorer nombre` | `scorer` | todos |
| Ver partidos y goles sin renderizar | `--list` | `listReplay()` / `POST /api/replays` | |
| Un video con todos los goles | `--merge` | `merge` | `false` |
| Un video por partido (implica `--merge`) | `--merge-per-match` | `mergeBy: "match"` | `"all"` |
| Transición entre goles | `--transition fadeblack\|fade\|dissolve\|slideleft\|none...` | `transition` | `fadeblack` |
| Duración de la transición | `--transition-ms N` | `transitionMs` | 500 |
| Formato | `--format mp4\|gif` | `format` | `mp4` |
| Cuadros por segundo | `--fps N` | `fps` | 60 (se ajusta a un divisor de 60; en gif, máximo 30) |
| Margen antes del gol | `--before S` | `preS` / `before` | 5 s |
| Margen después del gol | `--after S` | `postS` / `after` | 2.5 s (justo cuando el juego reposiciona jugadores y pelota) |
| Tamaño del video | `--size ANCHOxALTO` | `width` y `height` / `size` | `960x540` |
| Zoom (en `cinema`, el plano de juego: entre la cancha entera y el festejo) | `--zoom N` | `zoom` | 1.5 |
| Cámara | `--camera cinema\|game\|ball\|player` | `camera` | `cinema` |
| Jugador fijo a seguir (`camera: player`) | `--follow playerId` | `followPlayerId` | el autor de cada gol |
| Suavizado (solo `ball` y `player`; `cinema` ya viene afinada) | `--smooth N` | `smooth` | 0.2 (de 0 a 1: más bajo es más lento) |
| Espera tras el gol antes del traspaso (`ball`) | `--handoff ms` | `handoffMs` | 400 |
| Duración del giro hacia el autor (`ball`) | `--blend ms` | `blendMs` | 500 |
| Ancho del gif | `--gif-width N` | `gifWidth` | 640 |
| Miniatura por clip (`goal_N.jpg`) | `--no-poster` | `poster` | `true` (solo mp4; `summarizeMatch` la desactiva) |
| Marca de agua, texto | `--watermark "texto"` | `watermarkText` | apagada |
| Marca de agua, logo (PNG; gana sobre el texto) | `--watermark-image ruta.png` | `watermarkImage` (la API no lo expone, solo el `.env` del servidor) | apagada |
| Posición de la marca de agua | `--watermark-position pos` | `watermarkPosition` | `bottom-right` (o `bottom-left`, `top-right`, `top-left`) |
| Opacidad de la marca de agua | `--watermark-opacity N` | `watermarkOpacity` | 0.7 |
| Sonido | `--no-sound` | `sound` | `true` |
| Marcador y "¡Gol!" en pantalla | `--no-overlays` | `overlays` | `true` |
| Ambiente de público | `--no-crowd` | `crowd` | `true` |
| Música de fondo del video combinado (necesita `merge`) | `--music ruta.mp3` | `music` (en la API, campo multipart `music`) | apagada |
| Volumen de esa música | `--music-volume N` | `musicVolume` | 0.35 |
| Conservar los clips sueltos (solo `summarizeMatch`) | | `keepClips` | `false` |
| `res.dat` en otra ruta | `--res ruta` | `resDat` (solo librería) | `assets/res.dat` |
| Velocidad del replay mientras dibuja | | `speed` | 60 |
| Velocidad del replay entre goles, donde no dibuja | `--skip-speed N` | `skipSpeed` | 9999 (igual a `speed` lo desactiva) |

La marca de agua con logo solo se configura en el servidor (`WATERMARK_IMAGE=/ruta/logo.png` o
`WATERMARK_TEXT="tu marca"` en el `.env`), nunca la manda el cliente, para que nadie haga que el servidor
lea un archivo cualquiera del disco. Con `WATERMARK_FORCE=true` el cliente tampoco puede apagarla.

La música se pone desde el segundo 0, recortada si es más larga que el video o con silencio de relleno si
es más corta. No se repite en bucle.

---

## Cuánto tarda

Un render tiene dos partes: una pasada de análisis (alrededor de 1.5 s por cada 100 mil ticks, que son unos
28 minutos de grabación) y la pasada que dibuja. Esta última recorre el replay hasta el último gol pedido,
a velocidad máxima entre goles y a la normal cuando dibuja, y se detiene al terminar el último. Por eso el
primer gol parece tardar más: hasta que el replay no llega a él no hay nada que dibujar, y los siguientes
ya están cerca.

Como referencia, en una máquina de un solo núcleo y a 480x270, tres goles repartidos por una grabación de 27
minutos salieron en unos 7 s, y el último gol de esa misma grabación en unos 4 s. Con tamaños y fps por
defecto (960x540, 60) y goles más seguidos va a tardar más; depende sobre todo del CPU. La velocidad entre
goles no cambia el resultado: probé el mismo gol con y sin ella y el mp4 sale idéntico.

---

## Notas

- Los replays y renders subidos a la API se guardan solo en memoria y disco temporal, y se borran solos
  pasado `MAX_AGE_MINUTES`.
- La API no tiene autenticación. Si la vas a exponer fuera de tu red, ponle algo delante (un proxy con API
  key, o tu propio middleware en `server/index.js`).
- Cada frame va del renderer directo a ffmpeg como pixeles crudos, sin PNGs de por medio; así no se
  comprime y descomprime dos veces. El encode sigue siendo por CPU (`libx264`). Si hace falta más velocidad
  con volúmenes grandes, se puede usar aceleración por GPU (`h264_nvenc`, `qsv`, `vaapi`) con `FFMPEG_PATH`
  apuntando a un ffmpeg del sistema que la traiga.
- Los tramos sin ticks de juego dentro de un partido (una pausa larga, por ejemplo) cuentan como corte para
  la cámara. Si una ventana de gol cruzara uno se vería un salto; en la grabación de ejemplo ninguna lo hace.

### Cómo detecta las cosas

Son reglas simples y explicables, no una verdad absoluta:

- Toque: la distancia entre centros es menor o igual que el radio del jugador más el de la pelota más 0.01.
  Cuenta uno nuevo si pasaron más de 6 ticks sin contacto o si toca otro jugador cuando el anterior ya
  soltó. Las patadas del replay se pegan al toque del mismo jugador (a menos de 6 ticks).
- Tiro: la pelota 2 ticks después de la patada sale a 2.5 u/tick o más (4 si fue solo un toque de cuerpo),
  desde la mitad rival, y llega a la línea de gol antes de frenarse (fricción 0.99). Entre los palos cuenta
  como al arco; hasta un 25% del ancho del arco afuera, como desviado.
- Autor y asistente: el autor es quien tocó último antes del gol, y el asistente el toque inmediatamente
  anterior de otro jugador, si es del mismo equipo. Si toca último un rival sin patear y justo antes hubo un
  remate al arco del equipo que anotó (menos de 1 s), cuenta como desvío y el gol es del que remató. Si no,
  es autogol.

### Cómo está armado

- `src/scan.js`: la pasada de análisis (partidos, goles, toques, tiros y una serie por tick).
- `src/director.js` y `src/cinemaCamera.js`: la cámara.
- `src/select.js`: las fichas y filtros de selección.
- `src/mergeClips.js`: une clips; con transición recodifica con `xfade` y `acrossfade` de ffmpeg, sin
  transición los pega sin recodificar.
- `src/summarize.js`: `summarizeMatch`, el resumen de un partido desde una o varias grabaciones.
- `src/extractGoalClip.js`: el render y la CLI. `src/index.js` es lo que se importa desde otro proyecto.
- `src/hbr2Index.js` lee la lista de goles que trae el propio `.hbr2`, al instante.

---

## Pendientes

- Resúmenes con más jugadas (atajadas, bloqueos, remates), pensados para partidos importantes como una
  final. Hoy el resumen es solo de goles, que además es lo que más rápido se renderiza. El análisis ya
  detecta los remates (`timeline.shots`); falta clasificarlos y armar los clips. Una propuesta de prioridad
  y ventana (segundos antes y después): gol 6 y 2.5, autogol 5 y 2.5, atajada 4 y 2, bloqueo 3.5 y 1.5,
  remate 3.5 y 1.5, juntando los clips que se solapan o quedan a menos de 0.5 s. Bloqueo sería que el
  siguiente toque tras un remate es de un rival, y atajada que además iba al arco y quien lo detuvo era el
  arquero.
- Arquero inferido (HaxBall no tiene ese rol): el jugador de cada equipo más cercano a su propio arco, y
  para reemplazar al actual tendría que serlo 3 s seguidos. Daría tiempo en el arco, goles recibidos,
  atajadas y vallas invictas.
- Resumen estadístico del partido para un visor: momentum (posesión, posición de la pelota y remates),
  nota por jugador y MVP, posesión, pases. El visor quedó en pausa; `scan.js` ya da la base.
- Un cartel del gol con autor y asistente (ya están en `scorer` y `assist`) y una apertura con el marcador.
- Clips por jugador de cualquier jugada (hoy `--scorer` solo filtra goles).
- Elegir un partido por su posición en la grabación sin depender del número global del gol.

Límites conocidos: los tiros desde campo propio no se cuentan, y un pase largo que termina en gol cuenta
como remate de quien lo dio.

---

## Pruebas

```bash
npm test
```

Las pruebas del análisis y de la cámara usan `1.hbr2`, una grabación de ejemplo con dos partidos y 10 goles
que va en la raíz del repo; si no está, esas se saltan solas. Las de transiciones y de `summarizeMatch`
generan sus propios clips con ffmpeg.

---

## Licencia

ISC, ver [LICENSE](LICENSE). El contenido de `res.dat` (imágenes y sonidos del juego) es de HaxBall, no de
este proyecto.
