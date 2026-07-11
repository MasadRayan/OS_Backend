const { enrichBase } = require('./util');

function createSorter(params) {
  var quantumByLevel =
    (params && params.quantumByLevel) || {
      1: 3,
      2: 3,
      3: 2,
      4: 2,
      5: 1,
    };
  var promotedLevels = new Map();

  return function sort(entries, now) {
    return Array.from(entries.values())
      .map(function (entry) {
        var e = enrichBase(entry, now);
        var originalLevel = entry.basePriority;
        var currentLevel = promotedLevels.get(entry.id) || originalLevel;

        if (e.waitMinutes > (quantumByLevel[currentLevel] || 1) && currentLevel > 1) {
          currentLevel = Math.max(1, currentLevel - 1);
          promotedLevels.set(entry.id, currentLevel);
        }

        e.originalLevel = originalLevel;
        e.currentLevel = currentLevel;
        e.promoted = currentLevel < originalLevel;
        e.sortKey = currentLevel;
        return e;
      })
      .sort(function (a, b) {
        if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
        return a.arrivalTime - b.arrivalTime;
      });
  };
}

module.exports = { createSorter };
