const { PriorityQueue } = require('./priorityQueue');
const { ResourcePool } = require('./bankersAlgorithm');
const { dispatchNext } = require('./ambulanceDispatch');
const { summarize } = require('./metrics');
const { createAlgorithm, getAvailableAlgorithms } = require('./scheduler');

// Hospital anchor point (Chattogram, Bangladesh) -- used to seed ambulance
// starting positions and as the map center on the frontend.
const HOSPITAL = { id: 'hospital-1', name: 'City General Hospital', lat: 22.3569, lng: 91.7832 };

const SEVERITY_LABELS = {
  1: 'Critical',
  2: 'Serious',
  3: 'Moderate',
  4: 'Minor',
  5: 'Non-urgent',
};

// ---------------------------------------------------------------------------
// Multilevel queue pipeline: ER -> ICU -> WARD -> discharged.
//
// This is a multilevel (feedback) queue: each department is effectively its
// own queue with its own scheduling character --
//   ER    : preemptive priority + aging + EDF   (see priorityQueue.js)
//   ICU   : strict priority, backpressure-limited by capacity (see below)
//   WARD  : FCFS recovery slot, no contention for doctors
// Severity 1-2 (Critical/Serious) patients pass through all three levels;
// severity 3-5 patients skip ICU and go straight from ER to WARD.
//
// Timings below are compressed for classroom demonstration -- multiply by
// roughly 15-20x to read them as realistic hour-scale hospital durations
// (e.g. a 3-minute demo ER stay ~ a 45-60 minute real one).
// ---------------------------------------------------------------------------

function departmentSequence(severity) {
  return severity <= 2 ? ['ER', 'ICU', 'WARD'] : ['ER', 'WARD'];
}

function stageAllocation(department, severity) {
  if (department === 'ER') return { beds: 1, doctors: 1, icu: 0, ventilators: 0 };
  if (department === 'ICU') return { beds: 1, doctors: 1, icu: 1, ventilators: severity === 1 ? 1 : 0 };
  return { beds: 1, doctors: 0, icu: 0, ventilators: 0 }; // WARD: recovery, doctor freed
}

const STAGE_BASE_MINUTES = {
  ER: { 1: 3, 2: 2.5, 3: 2, 4: 1.5, 5: 1 },
  ICU: { 1: 4, 2: 3 },
  WARD: { 1: 3, 2: 2, 3: 2, 4: 1, 5: 1 },
};

function stageBurstMinutes(department, severity) {
  const base = STAGE_BASE_MINUTES[department][severity];
  const jitter = 0.85 + Math.random() * 0.3; // +/-15% so timers don't feel robotic
  return base * jitter;
}

// Declared max claim across the *whole* stay (used by Banker's Algorithm) --
// the worst-case resource footprint this patient could ever hold at once.
function defaultMaxClaim(severity) {
  if (severity <= 1) return { beds: 1, doctors: 1, icu: 1, ventilators: 1 };
  if (severity === 2) return { beds: 1, doctors: 1, icu: 1, ventilators: 0 };
  return { beds: 1, doctors: 1, icu: 0, ventilators: 0 };
}

// ---- Condition auto-escalation (waiting patients only) ----
const ESCALATION_INTERVAL_MIN = 6; // every N minutes waiting, condition worsens one level
// ---- EDF "golden window" deadlines for already-severe waiting patients ----
const DEADLINE_MINUTES = { 1: 10, 2: 15 };

function deadlineMinutesFor(severity) {
  return DEADLINE_MINUTES[severity] || null;
}

class HospitalStore {
  constructor() {
    this.activeScheduler = createAlgorithm('preemptivePriority', {
      agingIntervalMin: 5,
      agingStep: 0.5,
    });
    this.waitingQueue = new PriorityQueue(this.activeScheduler.sort); // patients not yet admitted
    this.admitted = new Map(); // patientId -> patient record (holding resources)
    this.resourcePool = new ResourcePool({ beds: 10, doctors: 5, icu: 3, ventilators: 2 });

    this.callsQueue = new PriorityQueue(); // pending ambulance calls (always uses default preemptive priority aging)
    this.ambulances = [
      { id: 'amb-1', name: 'Ambulance 1', lat: 22.365, lng: 91.795, speedKmh: 45, status: 'available' },
      { id: 'amb-2', name: 'Ambulance 2', lat: 22.34, lng: 91.81, speedKmh: 45, status: 'available' },
      { id: 'amb-3', name: 'Ambulance 3', lat: 22.372, lng: 91.765, speedKmh: 45, status: 'available' },
      { id: 'amb-4', name: 'Ambulance 4', lat: 22.33, lng: 91.77, speedKmh: 45, status: 'available' },
    ];
    this.activeTrips = new Map(); // ambulanceId -> { call, distanceKm, etaMin, startedAt }

    this.completedEvents = []; // for metrics: {type, severity, waitMinutes, completedAt}
    this.eventLog = []; // human-readable feed for the UI

    // ---- Analysis tracking ----
    this.admissionLog = []; // {patientId, name, severity, granted, reason, waitedMinutes, at}
    this.dispatchLog = []; // {callId, callerName, severity, ambulanceId, distanceKm, etaMin, waitedMinutes, at}
    this.severityTotals = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; // every patient ever added, by severity
    this.metricsHistory = []; // rolling snapshots for trend charts: {at, avgWaitMinutes, ambulanceUtilization, throughputPerHour, fairnessIndex, waitingCount, admittedCount, pendingCalls}
    this.agingEvents = 0; // count of times a waiting-list peek found an aged (starvation-prevented) entry
    this.escalationEvents = 0; // count of condition auto-escalations
    this.deadlineMet = 0; // patients treated before their golden-window deadline
    this.deadlineMissed = 0; // patients treated after their golden-window deadline lapsed
    this.transferBlocks = 0; // count of ICU/WARD transfer attempts blocked by Banker's Algorithm

    this._idCounter = 1;
  }

  nextId(prefix) {
    return `${prefix}-${this._idCounter++}`;
  }

  log(message) {
    this.eventLog.unshift({ id: this.nextId('log'), message, at: Date.now() });
    this.eventLog = this.eventLog.slice(0, 50);
  }

  // ---------- Scheduler ----------

  getSchedulerConfig() {
    return {
      activeAlgorithm: this.activeScheduler.algorithmName,
      availableAlgorithms: getAvailableAlgorithms(),
      params: { ...this.activeScheduler.params },
    };
  }

  setScheduler(algorithmName, params) {
    this.activeScheduler = createAlgorithm(algorithmName, params);
    this.waitingQueue.setSorter(this.activeScheduler.sort);
    this.log(
      'Scheduler changed to ' +
        this.activeScheduler.name +
        ' (' +
        algorithmName +
        ')'
    );
  }

  // ---------- Patients ----------

  admitToWaitingList({ name, age, condition, severity }) {
    const id = this.nextId('patient');
    const now = Date.now();
    const deadlineMin = deadlineMinutesFor(severity);
    const entry = this.waitingQueue.add({
      id,
      name,
      age,
      condition,
      basePriority: severity,
      originalSeverity: severity,
      arrivalTime: now,
      deadlineAt: deadlineMin ? now + deadlineMin * 60000 : null,
    });
    this.severityTotals[severity] = (this.severityTotals[severity] || 0) + 1;
    this.log(`${name} added to waiting list (${SEVERITY_LABELS[severity]})`);
    return entry;
  }

  /** Pull the most urgent waiting patient and attempt to admit via Banker's Algorithm. */
  treatNextPatient() {
    const top = this.waitingQueue.peek();
    if (!top) return { ok: false, reason: 'queue_empty' };

    if (top.aged) this.agingEvents += 1;
    if (top.deadlineAt) {
      if (top.deadlineMissed) this.deadlineMissed += 1;
      else this.deadlineMet += 1;
    }

    const allocation = stageAllocation('ER', top.basePriority);
    const maxClaim = defaultMaxClaim(top.basePriority);
    const result = this.resourcePool.tryAdmit(top.id, allocation, maxClaim);

    this.admissionLog.unshift({
      id: this.nextId('admission'),
      patientId: top.id,
      name: top.name,
      severity: top.basePriority,
      granted: result.granted,
      reason: result.granted ? 'safe_state' : result.reason,
      waitedMinutes: top.waitMinutes,
      at: Date.now(),
    });
    this.admissionLog = this.admissionLog.slice(0, 100);

    if (!result.granted) {
      var entry = this.waitingQueue.get(top.id);
      if (entry) entry.lastServedAt = Date.now();
      this.log(
        `Admission of ${top.name} BLOCKED (${result.reason}) -- staying on waiting list`
      );
      return { ok: false, reason: result.reason, patient: top };
    }

    this.waitingQueue.remove(top.id);
    const now = Date.now();
    const sequence = departmentSequence(top.basePriority);
    const burstMinutes = stageBurstMinutes('ER', top.basePriority);
    this.admitted.set(top.id, {
      ...top,
      admittedAt: now,
      allocation,
      maxClaim,
      department: 'ER',
      departmentSequence: sequence,
      stageStartedAt: now,
      dischargeAt: now + burstMinutes * 60000,
      transferBlocked: false,
      deadlineWasMissed: !!top.deadlineMissed,
    });
    this.log(
      `${top.name} admitted to ER (${SEVERITY_LABELS[top.basePriority]}) after waiting ${top.waitMinutes}m` +
        (top.deadlineMissed ? ' -- past golden-window deadline' : '')
    );
    return { ok: true, patient: top, safeSequence: result.safeSequence };
  }

  dischargePatient(patientId) {
    const patient = this.admitted.get(patientId);
    if (!patient) return { ok: false, reason: 'not_found' };
    this.resourcePool.release(patientId);
    this.admitted.delete(patientId);
    const waitMinutes = Math.round((Date.now() - patient.admittedAt) / 60000);
    this.completedEvents.push({
      type: 'patient',
      severity: patient.basePriority,
      waitMinutes: patient.waitMinutes ?? 0,
      completedAt: Date.now(),
    });
    this.log(`${patient.name} discharged from ${patient.department} after ${waitMinutes}m total stay`);
    return { ok: true };
  }

  // ---------- Multilevel queue pipeline: escalation + department transitions ----------

  /** Condition auto-escalation: patients waiting too long without treatment get worse. */
  _escalateWaitingPatients() {
    const now = Date.now();
    for (const entry of this.waitingQueue.items.values()) {
      const waitMinutes = (now - entry.arrivalTime) / 60000;
      const stepsDue = Math.floor(waitMinutes / ESCALATION_INTERVAL_MIN);
      const targetSeverity = Math.max(1, entry.originalSeverity - stepsDue);
      if (targetSeverity < entry.basePriority) {
        const from = entry.basePriority;
        entry.basePriority = targetSeverity;
        entry.escalated = true;
        this.escalationEvents += 1;
        if (!entry.deadlineAt) {
          const deadlineMin = deadlineMinutesFor(targetSeverity);
          if (deadlineMin) entry.deadlineAt = now + deadlineMin * 60000;
        }
        this.log(
          `${entry.name}'s condition worsened while waiting: ${SEVERITY_LABELS[from]} -> ${SEVERITY_LABELS[targetSeverity]}`
        );
      }
    }
  }

  /** Advances admitted patients through ER -> ICU -> WARD -> discharge as their stage timer completes. */
  _progressAdmittedPatients() {
    const now = Date.now();
    for (const patient of this.admitted.values()) {
      if (now < patient.dischargeAt) continue;

      const seqIndex = patient.departmentSequence.indexOf(patient.department);
      const nextDepartment = patient.departmentSequence[seqIndex + 1];

      if (!nextDepartment) {
        // Final stage complete -- full discharge.
        this.dischargePatient(patient.id);
        continue;
      }

      const newAllocation = stageAllocation(nextDepartment, patient.basePriority);
      const result = this.resourcePool.transfer(patient.id, newAllocation, patient.maxClaim);

      if (!result.granted) {
        this.transferBlocks += 1;
        if (!patient.transferBlocked) {
          patient.transferBlocked = true;
          this.log(
            `${patient.name}'s transfer from ${patient.department} to ${nextDepartment} BLOCKED (${result.reason}) -- holding current bed`
          );
        }
        // Stay put; retry next tick. Nudge the discharge clock forward a
        // little so we don't re-attempt (and re-log) every single tick.
        patient.dischargeAt = now + 15000;
        continue;
      }

      if (patient.transferBlocked) {
        this.log(`${patient.name} moved from ${patient.department} to ${nextDepartment} (bed freed up)`);
      } else {
        this.log(`${patient.name} transferred from ${patient.department} to ${nextDepartment}`);
      }

      patient.department = nextDepartment;
      patient.allocation = newAllocation;
      patient.stageStartedAt = now;
      patient.dischargeAt = now + stageBurstMinutes(nextDepartment, patient.basePriority) * 60000;
      patient.transferBlocked = false;
    }
  }

  /** Called on every server tick: escalation, department progression, ambulance dispatch. */
  tick() {
    this._escalateWaitingPatients();
    this._progressAdmittedPatients();
    this.runDispatchLoop();
  }

  // ---------- Ambulance calls ----------

  requestAmbulance({ callerName, lat, lng, severity, note }) {
    const id = this.nextId('call');
    const entry = this.callsQueue.add({
      id,
      callerName,
      lat,
      lng,
      note,
      basePriority: severity,
      arrivalTime: Date.now(),
    });
    this.severityTotals[severity] = (this.severityTotals[severity] || 0) + 1;
    this.log(`Emergency call from ${callerName} (${SEVERITY_LABELS[severity]}) queued for dispatch`);
    this.runDispatchLoop();
    return entry;
  }

  /** Repeatedly assign the most urgent pending call to the best free ambulance. */
  runDispatchLoop() {
    const assignments = [];
    let assignment = dispatchNext(this.callsQueue, this.ambulances);
    while (assignment) {
      const { call, ambulance, distanceKm, etaMin } = assignment;
      ambulance.status = 'dispatched';
      this.activeTrips.set(ambulance.id, {
        call,
        distanceKm,
        etaMin,
        startedAt: Date.now(),
      });
      this.log(
        `${ambulance.name} dispatched to ${call.callerName} (${SEVERITY_LABELS[call.basePriority]}, ETA ${etaMin.toFixed(1)}m)`
      );
      assignments.push(assignment);
      this.dispatchLog.unshift({
        id: this.nextId('dispatch'),
        callId: call.id,
        callerName: call.callerName,
        severity: call.basePriority,
        ambulanceId: ambulance.id,
        ambulanceName: ambulance.name,
        distanceKm: Number(distanceKm.toFixed(2)),
        etaMin: Number(etaMin.toFixed(1)),
        waitedMinutes: Math.round((Date.now() - call.arrivalTime) / 60000),
        at: Date.now(),
      });
      this.dispatchLog = this.dispatchLog.slice(0, 100);
      assignment = dispatchNext(this.callsQueue, this.ambulances);
    }
    return assignments;
  }

  /** Mark an ambulance's trip complete (arrived + patient handed off); ambulance returns to service. */
  completeTrip(ambulanceId) {
    const trip = this.activeTrips.get(ambulanceId);
    const ambulance = this.ambulances.find((a) => a.id === ambulanceId);
    if (!trip || !ambulance) return { ok: false, reason: 'no_active_trip' };

    const waitMinutes = Math.round((Date.now() - trip.call.arrivalTime) / 60000);
    this.completedEvents.push({
      type: 'ambulance',
      severity: trip.call.basePriority,
      waitMinutes,
      completedAt: Date.now(),
    });

    // Ambulance "returns" to the hospital and becomes available again.
    ambulance.lat = HOSPITAL.lat + (Math.random() - 0.5) * 0.02;
    ambulance.lng = HOSPITAL.lng + (Math.random() - 0.5) * 0.02;
    ambulance.status = 'available';
    this.activeTrips.delete(ambulanceId);
    this.log(`${ambulance.name} completed transport of ${trip.call.callerName}, back in service`);

    // Freeing an ambulance may let another queued call be served.
    this.runDispatchLoop();
    return { ok: true };
  }

  // ---------- Analysis ----------

  /** Called periodically by the server to build trend history for the Analysis page. */
  pushMetricsSnapshot() {
    const m = summarize(this.completedEvents, this.ambulances);
    this.metricsHistory.push({
      at: Date.now(),
      avgWaitMinutes: m.avgWaitMinutes,
      ambulanceUtilization: m.ambulanceUtilization,
      throughputPerHour: m.throughputPerHour,
      fairnessIndex: m.fairnessIndex,
      waitingCount: this.waitingQueue.size(),
      admittedCount: this.admitted.size,
      pendingCalls: this.callsQueue.size(),
    });
    // Keep roughly the last ~30 minutes at a 5s sampling interval.
    this.metricsHistory = this.metricsHistory.slice(-360);
  }

  getAnalysis() {
    const admissionsGranted = this.admissionLog.filter((a) => a.granted).length;
    const admissionsBlocked = this.admissionLog.filter((a) => !a.granted).length;
    const blockedReasons = this.admissionLog
      .filter((a) => !a.granted)
      .reduce((acc, a) => {
        acc[a.reason] = (acc[a.reason] || 0) + 1;
        return acc;
      }, {});

    return {
      history: this.metricsHistory,
      dispatchLog: this.dispatchLog.slice(0, 25),
      admissionLog: this.admissionLog.slice(0, 25),
      severityTotals: this.severityTotals,
      admissionsGranted,
      admissionsBlocked,
      blockedReasons,
      agingEvents: this.agingEvents,
      escalationEvents: this.escalationEvents,
      deadlineMet: this.deadlineMet,
      deadlineMissed: this.deadlineMissed,
      transferBlocks: this.transferBlocks,
      totalDispatches: this.dispatchLog.length,
      avgDispatchEtaMin: this.dispatchLog.length
        ? Number(
            (this.dispatchLog.reduce((sum, d) => sum + d.etaMin, 0) / this.dispatchLog.length).toFixed(1)
          )
        : 0,
    };
  }

  // ---------- Snapshot for broadcasting ----------

  getState() {
    const now = Date.now();
    return {
      hospital: HOSPITAL,
      severityLabels: SEVERITY_LABELS,
      waitingQueue: this.waitingQueue.snapshot(now),
      admitted: Array.from(this.admitted.values()).map((p) => ({
        ...p,
        stageRemainingMin: Math.max(0, Number(((p.dischargeAt - now) / 60000).toFixed(1))),
        stageIsFinal: p.departmentSequence.indexOf(p.department) === p.departmentSequence.length - 1,
      })),
      resources: this.resourcePool.state(),
      callsQueue: this.callsQueue.snapshot(now),
      ambulances: this.ambulances.map((a) => ({
        ...a,
        trip: this.activeTrips.get(a.id) || null,
      })),
      metrics: summarize(this.completedEvents, this.ambulances),
      eventLog: this.eventLog,
      scheduler: this.getSchedulerConfig(),
    };
  }
}

module.exports = { HospitalStore, SEVERITY_LABELS, HOSPITAL };
