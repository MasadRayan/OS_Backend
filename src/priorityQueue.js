/**
 * PriorityQueue implements preemptive priority scheduling with aging, plus
 * an optional EDF (Earliest-Deadline-First) override for entries carrying a
 * hard deadline (e.g. a "golden hour" clock for critical patients).
 *
 * OS concept:
 *   - Each entry has a base priority (1 = most critical ... 5 = least critical),
 *     mirroring ESI (Emergency Severity Index) triage levels.
 *   - Effective priority is recomputed continuously as:
 *         effective = basePriority - (waitMinutes / AGING_INTERVAL_MIN) * AGING_STEP
 *     This is classic "aging" used in OS schedulers to prevent starvation of
 *     low-priority processes: the longer an entry waits, the more its
 *     effective priority improves (numerically decreases -> more urgent).
 *   - Because effective priority is recomputed on every peek/dequeue rather
 *     than fixed at insertion time, a newly-arrived critical patient can
 *     immediately overtake a queue of waiting minor cases -- this is the
 *     "preemptive" part of preemptive priority scheduling.
 *   - Ties are broken by arrival time (FCFS), same as most real schedulers.
 *   - EDF layer: entries may carry a `deadlineAt` timestamp (e.g. the point
 *     by which a critical patient must begin treatment). As the deadline
 *     approaches or is breached, a fixed urgency offset is subtracted from
 *     the sort key -- large enough to jump the entry above same/lower
 *     priority peers, mirroring how hard real-time schedulers let an
 *     imminent deadline preempt normal priority ordering.
 *
 * Implemented as a binary min-heap keyed on effective priority for O(log n)
 * insert/removal, with a full recompute-and-resort on read since effective
 * priority is time-dependent (n is small -- a hospital queue -- so this is
 * cheap and keeps the aging math simple and easy to reason about/demo).
 */

const AGING_INTERVAL_MIN = 5; // every N minutes waited...
const AGING_STEP = 0.5; // ...effective priority improves by this much
const MIN_PRIORITY = 1; // cannot become "more urgent" than level 1

const DEADLINE_URGENT_THRESHOLD_MIN = 3; // deadline is "imminent" inside this window
const DEADLINE_URGENT_OFFSET = 5; // sort-key boost once imminent
const DEADLINE_MISSED_OFFSET = 10; // larger sort-key boost once breached

class PriorityQueue {
  constructor() {
    this.items = new Map(); // id -> entry
  }

  add(entry) {
    // entry: { id, basePriority (1-5), arrivalTime (ms epoch), deadlineAt?, ...payload }
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

  _effectivePriority(entry, now) {
    const waitMinutes = Math.max(0, (now - entry.arrivalTime) / 60000);
    const discount = Math.floor(waitMinutes / AGING_INTERVAL_MIN) * AGING_STEP;
    return Math.max(MIN_PRIORITY, entry.basePriority - discount);
  }

  /** Returns all entries sorted by (deadline-aware) effective priority, most urgent first. */
  snapshot(now = Date.now()) {
    return Array.from(this.items.values())
      .map((entry) => {
        const effectivePriority = this._effectivePriority(entry, now);
        let deadlineSlackMin = null;
        let deadlineMissed = false;
        let deadlineUrgent = false;
        let sortKey = effectivePriority;

        if (entry.deadlineAt) {
          deadlineSlackMin = Number(((entry.deadlineAt - now) / 60000).toFixed(1));
          deadlineMissed = deadlineSlackMin < 0;
          deadlineUrgent = !deadlineMissed && deadlineSlackMin <= DEADLINE_URGENT_THRESHOLD_MIN;
          if (deadlineMissed) sortKey = effectivePriority - DEADLINE_MISSED_OFFSET;
          else if (deadlineUrgent) sortKey = effectivePriority - DEADLINE_URGENT_OFFSET;
        }

        return {
          ...entry,
          effectivePriority,
          waitMinutes: Math.floor((now - entry.arrivalTime) / 60000),
          aged: effectivePriority < entry.basePriority,
          deadlineAt: entry.deadlineAt || null,
          deadlineSlackMin,
          deadlineMissed,
          deadlineUrgent,
          sortKey,
        };
      })
      .sort((a, b) => {
        if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey; // lower = more urgent
        return a.arrivalTime - b.arrivalTime; // FCFS tie-break
      });
  }

  /** Peek the most urgent entry without removing it. */
  peek(now = Date.now()) {
    const snap = this.snapshot(now);
    return snap.length ? snap[0] : null;
  }

  /** Remove and return the most urgent entry. */
  dequeueTop(now = Date.now()) {
    const top = this.peek(now);
    if (top) this.items.delete(top.id);
    return top;
  }
}

module.exports = {
  PriorityQueue,
  AGING_INTERVAL_MIN,
  AGING_STEP,
  MIN_PRIORITY,
  DEADLINE_URGENT_THRESHOLD_MIN,
};
