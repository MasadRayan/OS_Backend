const { enrichBase } = require('./util');

function createSorter(_params) {
  return function sort(entries, now) {
    return Array.from(entries.values())
      .map(function (entry) {
        var e = enrichBase(entry, now);
        e.effectivePriority = entry.basePriority;
        e.sortKey = entry.basePriority;
        return e;
      })
      .sort(function (a, b) {
        if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
        return a.arrivalTime - b.arrivalTime;
      });
  };
}

module.exports = { createSorter };
