/**
 * Banker's Algorithm, adapted from classic OS deadlock-avoidance to hospital
 * resource admission control.
 *
 * OS mapping:
 *   - Resources (beds, doctors, ICU slots, ventilators) = the resource types.
 *   - Each admitted patient = a "process" holding an Allocation vector and
 *     declaring a Max vector (the most of each resource their condition
 *     could escalate to require, e.g. a stable patient might still need
 *     a ventilator if they deteriorate).
 *   - Before admitting a NEW patient, we simulate granting their initial
 *     request and run the standard Safety Algorithm: can every currently
 *     admitted patient (plus the new one) still be brought to completion
 *     (discharged) using only the resources that remain available, one at
 *     a time, in some order?
 *   - If yes -> safe state -> admit. If no -> unsafe state -> the system
 *     REFUSES the admission (keeps the patient in the waiting/transfer
 *     queue) rather than risking a state where a currently-admitted
 *     critical patient could later be unable to get a ventilator/bed they
 *     might need. This is exactly deadlock AVOIDANCE, not detection: we
 *     never let the system enter a state that could deadlock.
 */

const RESOURCE_TYPES = ['beds', 'doctors', 'icu', 'ventilators'];

class ResourcePool {
  constructor(capacity) {
    // capacity: { beds, doctors, icu, ventilators }
    this.capacity = { ...capacity };
    this.allocations = new Map(); // patientId -> allocation vector
    this.maxClaims = new Map(); // patientId -> max vector
  }

  available() {
    const used = RESOURCE_TYPES.reduce(
      (acc, r) => ({ ...acc, [r]: 0 }),
      {}
    );
    for (const alloc of this.allocations.values()) {
      for (const r of RESOURCE_TYPES) used[r] += alloc[r] || 0;
    }
    const avail = {};
    for (const r of RESOURCE_TYPES) avail[r] = this.capacity[r] - used[r];
    return avail;
  }

  /**
   * Runs the Banker's Safety Algorithm assuming `newPatient` (with
   * allocation + maxClaim) is added on top of current state.
   * Returns { safe: boolean, safeSequence: string[] | null }
   */
  _isSafe(hypotheticalAllocations, hypotheticalMax) {
    const work = { ...this.capacity };
    for (const ids of hypotheticalAllocations.values()) {
      // subtract nothing yet, computed below
    }
    // work = capacity - sum(allocations)
    for (const r of RESOURCE_TYPES) {
      let used = 0;
      for (const alloc of hypotheticalAllocations.values()) used += alloc[r] || 0;
      work[r] = this.capacity[r] - used;
    }

    const finished = new Set();
    const patientIds = Array.from(hypotheticalAllocations.keys());
    const sequence = [];

    let progress = true;
    while (progress && finished.size < patientIds.length) {
      progress = false;
      for (const id of patientIds) {
        if (finished.has(id)) continue;
        const max = hypotheticalMax.get(id) || {};
        const alloc = hypotheticalAllocations.get(id) || {};
        // need = max - allocation (what they might still additionally require)
        const canFinish = RESOURCE_TYPES.every((r) => {
          const need = (max[r] || 0) - (alloc[r] || 0);
          return need <= work[r];
        });
        if (canFinish) {
          // Textbook Banker's: a "finishing" patient is simulated as
          // acquiring up to their full max claim, completing treatment,
          // then releasing everything (their max), returning it to the
          // pool -- not just what they currently hold.
          for (const r of RESOURCE_TYPES) work[r] += max[r] || 0;
          finished.add(id);
          sequence.push(id);
          progress = true;
        }
      }
    }

    return {
      safe: finished.size === patientIds.length,
      safeSequence: finished.size === patientIds.length ? sequence : null,
    };
  }

  /**
   * Attempt to admit a patient with an initial resource allocation and a
   * declared max claim. Returns { granted, reason, safeSequence, available }.
   */
  tryAdmit(patientId, allocation, maxClaim) {
    const avail = this.available();
    const fits = RESOURCE_TYPES.every((r) => (allocation[r] || 0) <= (avail[r] || 0));
    if (!fits) {
      return { granted: false, reason: 'insufficient_available_resources', available: avail };
    }

    const hypotheticalAllocations = new Map(this.allocations);
    hypotheticalAllocations.set(patientId, allocation);
    const hypotheticalMax = new Map(this.maxClaims);
    hypotheticalMax.set(patientId, maxClaim);

    const { safe, safeSequence } = this._isSafe(hypotheticalAllocations, hypotheticalMax);

    if (!safe) {
      return { granted: false, reason: 'unsafe_state', available: avail };
    }

    this.allocations.set(patientId, allocation);
    this.maxClaims.set(patientId, maxClaim);
    return { granted: true, safeSequence, available: this.available() };
  }

  /** Release all resources held by a patient (discharge/transfer). */
  release(patientId) {
    this.allocations.delete(patientId);
    this.maxClaims.delete(patientId);
    return this.available();
  }

  /**
   * Banker's REQUEST Algorithm, used here for department transfers (e.g. ER
   * -> ICU): a patient who is already admitted and holding some allocation
   * asks to replace it with a different allocation (their new department's
   * footprint). This is the textbook "process requests additional
   * resources during execution" case, not just the initial-admission case.
   *
   * Steps (classic Banker's request procedure):
   *   1. Compute the incremental request against resources not already
   *      held by this same patient (so releasing their own ER doctor while
   *      claiming an ICU bed nets out correctly).
   *   2. If the request exceeds what's available -> deny, patient stays
   *      put (this is the natural backpressure that queues ICU transfers
   *      when ICU is full, without needing a separate data structure).
   *   3. Otherwise, provisionally grant it and re-run the Safety Algorithm.
   *      Only commit if the resulting state is still safe.
   *
   * Returns { granted, reason, safeSequence }.
   */
  transfer(patientId, newAllocation, newMaxClaim) {
    const maxClaim = newMaxClaim || this.maxClaims.get(patientId) || newAllocation;

    const availableExcludingSelf = {};
    for (const r of RESOURCE_TYPES) {
      let used = 0;
      for (const [id, alloc] of this.allocations) {
        if (id === patientId) continue;
        used += alloc[r] || 0;
      }
      availableExcludingSelf[r] = this.capacity[r] - used;
    }

    const fits = RESOURCE_TYPES.every(
      (r) => (newAllocation[r] || 0) <= availableExcludingSelf[r]
    );
    if (!fits) {
      return { granted: false, reason: 'insufficient_available_resources' };
    }

    const hypotheticalAllocations = new Map(this.allocations);
    hypotheticalAllocations.set(patientId, newAllocation);
    const hypotheticalMax = new Map(this.maxClaims);
    hypotheticalMax.set(patientId, maxClaim);

    const { safe, safeSequence } = this._isSafe(hypotheticalAllocations, hypotheticalMax);
    if (!safe) {
      return { granted: false, reason: 'unsafe_state' };
    }

    this.allocations.set(patientId, newAllocation);
    this.maxClaims.set(patientId, maxClaim);
    return { granted: true, safeSequence };
  }

  state() {
    return {
      capacity: this.capacity,
      available: this.available(),
      allocations: Object.fromEntries(this.allocations),
      maxClaims: Object.fromEntries(this.maxClaims),
    };
  }
}

module.exports = { ResourcePool, RESOURCE_TYPES };
