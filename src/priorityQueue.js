var preemptivePriority = require('./scheduler/preemptivePriority');

var DEFAULT_SORTER = preemptivePriority.createSorter({
  agingIntervalMin: 5,
  agingStep: 0.5,
});

var AGING_INTERVAL_MIN = 5;
var AGING_STEP = 0.5;
var MIN_PRIORITY = 1;
var DEADLINE_URGENT_THRESHOLD_MIN = 3;

class PriorityQueue {
  constructor(sorter) {
    this.items = new Map();
    this.sorter = sorter || DEFAULT_SORTER;
  }

  setSorter(sorter) {
    this.sorter = sorter;
  }

  add(entry) {
    this.items.set(entry.id, { ...entry });
    return entry;
  }

  remove(id) {
    return this.items.delete(id);
  }

  get(id) {
    return this.items.get(id);
  }

  has(id) {
    return this.items.has(id);
  }

  size() {
    return this.items.size;
  }

  snapshot(now) {
    now = now || Date.now();
    return this.sorter(this.items, now);
  }

  peek(now) {
    now = now || Date.now();
    var snap = this.snapshot(now);
    return snap.length ? snap[0] : null;
  }

  dequeueTop(now) {
    now = now || Date.now();
    var top = this.peek(now);
    if (top) this.items.delete(top.id);
    return top;
  }
}

module.exports = {
  PriorityQueue: PriorityQueue,
  AGING_INTERVAL_MIN: AGING_INTERVAL_MIN,
  AGING_STEP: AGING_STEP,
  MIN_PRIORITY: MIN_PRIORITY,
  DEADLINE_URGENT_THRESHOLD_MIN: DEADLINE_URGENT_THRESHOLD_MIN,
};
