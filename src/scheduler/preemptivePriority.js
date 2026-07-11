const { enrichBase } = require('./util');
var DEADLINE_URGENT_THRESHOLD_MIN = 3;
var DEADLINE_URGENT_OFFSET = 5;
var DEADLINE_MISSED_OFFSET = 10;
var MIN_PRIORITY = 1;

function createSorter(params) {
  var agingIntervalMin = (params && params.agingIntervalMin) || 5;
  var agingStep = (params && params.agingStep) || 0.5;

  return function sort(entries, now) {
    return Array.from(entries.values())
      .map(function (entry) {
        var e = enrichBase(entry, now);
        var waitMinutesFloat = Math.max(0, (now - entry.arrivalTime) / 60000);
        var discount =
          Math.floor(waitMinutesFloat / agingIntervalMin) * agingStep;
        var effectivePriority = Math.max(
          MIN_PRIORITY,
          entry.basePriority - discount
        );

        e.effectivePriority = effectivePriority;
        e.aged = effectivePriority < entry.basePriority;

        var sortKey = effectivePriority;
        if (e.deadlineMissed) {
          sortKey = effectivePriority - DEADLINE_MISSED_OFFSET;
        }
        if (!e.deadlineMissed && e.deadlineSlackMin != null && e.deadlineSlackMin <= DEADLINE_URGENT_THRESHOLD_MIN) {
          sortKey = effectivePriority - DEADLINE_URGENT_OFFSET;
        }
        e.sortKey = sortKey;
        return e;
      })
      .sort(function (a, b) {
        if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
        return a.arrivalTime - b.arrivalTime;
      });
  };
}

module.exports = { createSorter };
