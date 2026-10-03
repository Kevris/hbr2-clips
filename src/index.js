'use strict';

// Punto de entrada de la librería: lo que hay que usar desde otro proyecto (por ejemplo el bot).
//   const { summarizeMatch, extractGoalClips, listReplay } = require('./hbr2-clips');
const { extractGoalClips, listReplay, listReplayData, readGoalIndex } = require('./extractGoalClip');
const { summarizeMatch } = require('./summarize');
const { mergeClips, TRANSITIONS } = require('./mergeClips');
const { selectGoals, parseSelector } = require('./select');

module.exports = { summarizeMatch, extractGoalClips, listReplay, listReplayData, readGoalIndex, mergeClips, TRANSITIONS, selectGoals, parseSelector };
