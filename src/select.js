'use strict';

// Qué goles renderizar. Un selector es una lista (o un texto separado por comas) de "fichas":
//
//   all  |  all-goal  |  all-goals    todos los goles del replay
//   3                                  el gol número 3 (la numeración es la del replay entero)
//   seg-2                              todos los goles del partido 2 (seg-1, seg-2...)
//
// Las fichas se SUMAN: "seg-1,7" = todo el partido 1 más el gol 7. Sin selector, se renderiza todo.
// Encima del selector se pueden aplicar filtros que lo acotan: team ('red' | 'blue', el equipo que
// convirtió) y scorer (parte del nombre del autor, sin distinguir mayúsculas).
const SEG_RE = /^(?:seg|segment|match|partido|p)[-_: ]?(\d+)$/i;
const ALL_RE = /^all(?:[-_ ]?goals?)?$/i;

function parseSelector(value) {
  const sel = { all: false, goals: new Set(), segments: new Set() };
  const tokens = [].concat(value == null ? [] : value).flatMap((v) => (typeof v === 'string' ? v.split(',') : [v]));
  for (const raw of tokens) {
    const t = typeof raw === 'string' ? raw.trim() : raw;
    if (t === '' || t == null) continue;
    let m;
    if (typeof t === 'number' || /^\d+$/.test(t)) sel.goals.add(Number(t));
    else if (ALL_RE.test(t)) sel.all = true;
    else if ((m = SEG_RE.exec(t))) sel.segments.add(Number(m[1]));
    else throw new Error(`unknown goal selector "${t}" (use all, a goal number like 3, or seg-N for match N)`);
  }
  if (!sel.goals.size && !sel.segments.size) sel.all = true;
  return sel;
}

const teamName = (id) => (id === 1 ? 'red' : id === 2 ? 'blue' : null);

function selectGoals(goals, { onlyGoal, segment, team, scorer } = {}) {
  const tokens = [].concat(onlyGoal == null ? [] : onlyGoal);
  if (segment != null) for (const s of [].concat(segment)) tokens.push(`seg-${s}`);
  const sel = parseSelector(tokens);
  let out = goals.filter((g) => sel.all || sel.goals.has(g.index) || sel.segments.has(g.segment));
  if (team) {
    if (team !== 'red' && team !== 'blue') throw new Error('team has to be red or blue');
    out = out.filter((g) => teamName(g.teamId) === team);
  }
  if (scorer) {
    const q = String(scorer).toLowerCase();
    out = out.filter((g) => g.scorer && g.scorer.toLowerCase().includes(q));
  }
  return out;
}

module.exports = { parseSelector, selectGoals, teamName };
