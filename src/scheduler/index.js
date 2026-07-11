var fcfs = require('./fcfs');
var sjf = require('./sjf');
var priority = require('./priority');
var preemptivePriority = require('./preemptivePriority');
var roundRobin = require('./roundRobin');
var mlfq = require('./mlfq');
var edf = require('./edf');

var REGISTRY = {
  fcfs: {
    create: fcfs.createSorter,
    name: 'First-Come, First-Served',
    defaultParams: {},
  },
  sjf: {
    create: sjf.createSorter,
    name: 'Shortest Job First',
    defaultParams: {},
  },
  priority: {
    create: priority.createSorter,
    name: 'Priority (Non-preemptive)',
    defaultParams: {},
  },
  preemptivePriority: {
    create: preemptivePriority.createSorter,
    name: 'Preemptive Priority with Aging',
    defaultParams: { agingIntervalMin: 5, agingStep: 0.5 },
  },
  roundRobin: {
    create: roundRobin.createSorter,
    name: 'Round Robin',
    defaultParams: { quantumMinutes: 1 },
  },
  mlfq: {
    create: mlfq.createSorter,
    name: 'Multilevel Feedback Queue',
    defaultParams: { quantumByLevel: { 1: 3, 2: 3, 3: 2, 4: 2, 5: 1 } },
  },
  edf: {
    create: edf.createSorter,
    name: 'Earliest Deadline First',
    defaultParams: {},
  },
};

function createAlgorithm(name, params) {
  var entry = REGISTRY[name];
  if (!entry) throw new Error('Unknown algorithm: ' + name);
  var mergedParams = { ...entry.defaultParams, ...(params || {}) };
  var sort = entry.create(mergedParams);
  return {
    sort: sort,
    name: entry.name,
    algorithmName: name,
    params: mergedParams,
  };
}

function getAvailableAlgorithms() {
  return Object.keys(REGISTRY).map(function (key) {
    return {
      id: key,
      name: REGISTRY[key].name,
      params: REGISTRY[key].defaultParams,
    };
  });
}

module.exports = { createAlgorithm, getAvailableAlgorithms, REGISTRY };
