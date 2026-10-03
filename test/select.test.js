'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSelector, selectGoals } = require('../src/select');

const goals = [
  { index: 1, segment: 1, teamId: 2, scorer: 'Frxddy' },
  { index: 2, segment: 1, teamId: 2, scorer: 'Trx!' },
  { index: 3, segment: 2, teamId: 1, scorer: 'maz' },
  { index: 4, segment: 2, teamId: 2, scorer: null },
];
const ids = (list) => list.map((g) => g.index);

test('sin selector se toman todos los goles', () => {
  assert.deepEqual(ids(selectGoals(goals, {})), [1, 2, 3, 4]);
  assert.deepEqual(ids(selectGoals(goals, { onlyGoal: 'all' })), [1, 2, 3, 4]);
  for (const alias of ['all-goal', 'all-goals', 'ALL', 'all_goals']) assert.equal(parseSelector(alias).all, true, alias);
});

test('números de gol, sueltos, en lista y en texto', () => {
  assert.deepEqual(ids(selectGoals(goals, { onlyGoal: 3 })), [3]);
  assert.deepEqual(ids(selectGoals(goals, { onlyGoal: [1, 4] })), [1, 4]);
  assert.deepEqual(ids(selectGoals(goals, { onlyGoal: '2,3' })), [2, 3]);
});

test('seg-N elige un partido entero', () => {
  assert.deepEqual(ids(selectGoals(goals, { onlyGoal: 'seg-1' })), [1, 2]);
  for (const alias of ['seg-2', 'seg2', 'match-2', 'partido 2', 'p2', 'SEG_2']) assert.deepEqual(ids(selectGoals(goals, { onlyGoal: alias })), [3, 4], alias);
});

test('las fichas se suman y --segment es un atajo de seg-N', () => {
  assert.deepEqual(ids(selectGoals(goals, { onlyGoal: ['seg-1', 4] })), [1, 2, 4]);
  assert.deepEqual(ids(selectGoals(goals, { segment: [2] })), [3, 4]);
  assert.deepEqual(ids(selectGoals(goals, { segment: 1, onlyGoal: 3 })), [1, 2, 3]);
});

test('team y scorer acotan la selección', () => {
  assert.deepEqual(ids(selectGoals(goals, { team: 'red' })), [3]);
  assert.deepEqual(ids(selectGoals(goals, { onlyGoal: 'seg-1', team: 'blue' })), [1, 2]);
  assert.deepEqual(ids(selectGoals(goals, { scorer: 'trx' })), [2]);
  assert.deepEqual(ids(selectGoals(goals, { scorer: 'nadie' })), []);
});

test('lo que no se entiende falla con un mensaje claro', () => {
  assert.throws(() => selectGoals(goals, { onlyGoal: 'banana' }), /unknown goal selector "banana"/);
  assert.throws(() => selectGoals(goals, { team: 'green' }), /red or blue/);
  assert.deepEqual(ids(selectGoals(goals, { onlyGoal: 'seg-9' })), []); // un partido que no existe no es un error, solo no hay goles
});
