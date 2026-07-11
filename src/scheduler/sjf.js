const { enrichBase } = require('./util');

var STAGE_BASE_MINUTES = {
  ER: { 1: 3, 2: 2.5, 3: 2, 4: 1.5, 5: 1 },
};

function createSorter(_params) {
  return function sort(entries, now) {
    return Array.from(entries.values())
      .map(function (entry) {
        var e = enrichBase(entry, now);
        var severity = entry.basePriority;
        e.burstMinutes = STAGE_BASE_MINUTES['ER'][severity] || 2;
        e.sortKey = e.burstMinutes;
        return e;
      })
      .sort(function (a, b) {
        if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
        return a.arrivalTime - b.arrivalTime;
      });
  };
}

module.exports = { createSorter };
