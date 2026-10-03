'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { summarizeMatch } = require('../src');

const SAMPLE = path.join(__dirname, '..', '1.hbr2');

test('summarizeMatch valida lo que recibe antes de gastar tiempo', async () => {
  await assert.rejects(() => summarizeMatch([], 'x.mp4'), /at least one part/);
  await assert.rejects(() => summarizeMatch([{}], 'x.mp4'), /needs a "replay" path/);
  await assert.rejects(() => summarizeMatch([{ replay: '/no/existe.hbr2' }], 'x.mp4'), /replay not found/);
  await assert.rejects(() => summarizeMatch([{ replay: SAMPLE }], ''), /output file/);
  await assert.rejects(() => summarizeMatch([{ replay: SAMPLE }], 'x.mp4', { format: 'gif' }), /only works with mp4/);
});

test('si ninguna parte tiene segmentos válidos falla claro, sin renderizar', async () => {
  await assert.rejects(() => summarizeMatch([{ replay: SAMPLE, segments: [] }, { replay: SAMPLE, segments: [] }], 'x.mp4'), /no goals found/);
});
