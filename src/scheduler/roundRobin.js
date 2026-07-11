const { enrichBase } = require('./util');

function createSorter(params) {
  var quantumMinutes = (params && params.quantumMinutes) || 1;

  return function sort(entries, now) {
    return Array.from(entries.values())
      .map(function (entry) {
        var e = enrichBase(entry, now);
        var lastServedAt = entry.lastServedAt || entry.arrivalTime;
        var quantumElapsed = (now - lastServedAt) / 60000 >= quantumMinutes;
        e.lastServedAt = lastServedAt;
        e.quantumElapsed = quantumElapsed;
        e.sortKey = quantumElapsed ? lastServedAt : Infinity;
        return e;
      })
      .sort(function (a, b) {
        if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
        return a.arrivalTime - b.arrivalTime;
      });
  };
}

module.exports = { createSorter };
