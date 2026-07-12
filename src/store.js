const { PriorityQueue } = require('./priorityQueue');
const { ResourcePool } = require('./bankersAlgorithm');
const { dispatchNext, haversineKm, etaMinutes } = require('./ambulanceDispatch');
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
      { id: 'amb-1', name: 'Ambulance 1', lat: 22.365, lng: 91.795, speedKmh: 45, status: 'available', type: 'als', equipment: { defib: true, ventilator: true, stretcher: true, meds: true }, crew: [{ name: 'Rahim', role: 'paramedic', onShift: true }, { name: 'Karim', role: 'driver', onShift: true }], utilization: 0 },
      { id: 'amb-2', name: 'Ambulance 2', lat: 22.34, lng: 91.81, speedKmh: 45, status: 'available', type: 'bls', equipment: { defib: false, ventilator: false, stretcher: true, meds: false }, crew: [{ name: 'Fatima', role: 'emt', onShift: true }, { name: 'Hasan', role: 'driver', onShift: true }], utilization: 0 },
      { id: 'amb-3', name: 'Ambulance 3', lat: 22.372, lng: 91.765, speedKmh: 45, status: 'available', type: 'als', equipment: { defib: true, ventilator: true, stretcher: true, meds: true }, crew: [{ name: 'Nadia', role: 'paramedic', onShift: true }, { name: 'Tanvir', role: 'driver', onShift: false }], utilization: 0 },
      { id: 'amb-4', name: 'Ambulance 4', lat: 22.33, lng: 91.77, speedKmh: 45, status: 'available', type: 'bls', equipment: { defib: false, ventilator: false, stretcher: true, meds: false }, crew: [{ name: 'Shamim', role: 'emt', onShift: true }, { name: 'Jahid', role: 'driver', onShift: true }], utilization: 0 },
    ];
    this.activeTrips = new Map(); // ambulanceId -> full trip object

    this.hospitals = [
      { id: 'hosp-1', name: 'City General Hospital', lat: 22.3569, lng: 91.7832, bedsAvailable: 10, capacity: 50 },
      { id: 'hosp-2', name: 'Chittagong Medical Center', lat: 22.335, lng: 91.832, bedsAvailable: 7, capacity: 40 },
      { id: 'hosp-3', name: 'Parkview Hospital', lat: 22.375, lng: 91.755, bedsAvailable: 5, capacity: 30 },
    ];
    this.tripHistory = [];

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

  /** Called on every server tick: escalation, department progression, ambulance lifecycle, dispatch. */
  tick() {
    this._escalateWaitingPatients();
    this._progressAdmittedPatients();
    this._advanceTrips();
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
      const hospital = this._findNearestHospital(call.lat, call.lng);
      const distanceToHospital = haversineKm(
        { lat: call.lat, lng: call.lng },
        { lat: hospital.lat, lng: hospital.lng }
      );
      const etaToHospitalMin = etaMinutes(distanceToHospital, ambulance.speedKmh);
      const now = Date.now();
      const tripId = this.nextId('trip');

      const routePolyline = [
        [ambulance.lat, ambulance.lng],
        [(ambulance.lat + call.lat) / 2, (ambulance.lng + call.lng) / 2],
        [call.lat, call.lng],
      ];

      ambulance.status = 'dispatched';

      const trip = {
        id: tripId,
        status: 'dispatched',
        dispatchedAt: now,
        enRouteAt: null,
        onSceneAt: null,
        transportingAt: null,
        arrivedAt: null,
        call: {
          callerName: call.callerName,
          note: call.note,
          basePriority: call.basePriority,
          lat: call.lat,
          lng: call.lng,
          arrivalTime: call.arrivalTime,
        },
        hospital: { id: hospital.id, name: hospital.name, lat: hospital.lat, lng: hospital.lng },
        routePolyline,
        ambulanceId: ambulance.id,
        distanceKm,
        etaMin,
        etaToSceneSec: etaMin * 60,
        etaToHospitalSec: etaToHospitalMin * 60,
      };

      this.activeTrips.set(ambulance.id, trip);

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

  /** Advance a trip to arrived and return the ambulance to service. */
  completeTrip(ambulanceId) {
    const trip = this.activeTrips.get(ambulanceId);
    const ambulance = this.ambulances.find((a) => a.id === ambulanceId);
    if (!trip || !ambulance) return { ok: false, reason: 'no_active_trip' };

    const now = Date.now();
    trip.status = 'arrived';
    trip.arrivedAt = now;
    this._finishTrip(ambulanceId, trip);
    return { ok: true };
  }

  /** Cancel the current trip and return ambulance to service. Call stays in queue if still present (it was already dequeued on dispatch). */
  cancelTrip(ambulanceId, reason) {
    const trip = this.activeTrips.get(ambulanceId);
    const ambulance = this.ambulances.find((a) => a.id === ambulanceId);
    if (!trip || !ambulance) return { ok: false, reason: 'no_active_trip' };

    this.tripHistory.push({
      id: trip.id,
      ambulanceId,
      ambulanceName: ambulance.name,
      callerName: trip.call.callerName,
      note: trip.call.note,
      severity: trip.call.basePriority,
      status: 'cancelled',
      dispatchedAt: new Date(trip.dispatchedAt).toISOString(),
      enRouteAt: trip.enRouteAt ? new Date(trip.enRouteAt).toISOString() : null,
      onSceneAt: null,
      transportingAt: null,
      arrivedAt: null,
      responseTimeMin: 0,
      hospitalId: trip.hospital.id,
      hospitalName: trip.hospital.name,
    });

    ambulance.lat = HOSPITAL.lat + (Math.random() - 0.5) * 0.02;
    ambulance.lng = HOSPITAL.lng + (Math.random() - 0.5) * 0.02;
    ambulance.status = 'available';
    this.activeTrips.delete(ambulanceId);
    this.log(`${ambulance.name} trip cancelled${reason ? ': ' + reason : ''}`);

    this.runDispatchLoop();
    return { ok: true };
  }

  /** Reassign a trip from one ambulance to another. */
  reassignTrip(ambulanceId, targetAmbulanceId) {
    const sourceTrip = this.activeTrips.get(ambulanceId);
    const sourceAmbulance = this.ambulances.find((a) => a.id === ambulanceId);
    const targetAmbulance = this.ambulances.find((a) => a.id === targetAmbulanceId);

    if (!sourceTrip || !sourceAmbulance) return { ok: false, reason: 'no_active_trip' };
    if (!targetAmbulance) return { ok: false, reason: 'target_not_found' };
    if (targetAmbulance.status !== 'available') return { ok: false, reason: 'target_not_available' };

    const call = sourceTrip.call;
    this.cancelTrip(ambulanceId, 'Reassigned');

    const distanceKm = haversineKm(
      { lat: targetAmbulance.lat, lng: targetAmbulance.lng },
      { lat: call.lat, lng: call.lng }
    );
    const etaMin = etaMinutes(distanceKm, targetAmbulance.speedKmh);
    const hospital = this._findNearestHospital(call.lat, call.lng);
    const distanceToHospital = haversineKm(
      { lat: call.lat, lng: call.lng },
      { lat: hospital.lat, lng: hospital.lng }
    );
    const etaToHospitalMin = etaMinutes(distanceToHospital, targetAmbulance.speedKmh);
    const now = Date.now();
    const tripId = this.nextId('trip');

    const routePolyline = [
      [targetAmbulance.lat, targetAmbulance.lng],
      [(targetAmbulance.lat + call.lat) / 2, (targetAmbulance.lng + call.lng) / 2],
      [call.lat, call.lng],
    ];

    targetAmbulance.status = 'dispatched';

    const trip = {
      id: tripId,
      status: 'dispatched',
      dispatchedAt: now,
      enRouteAt: null,
      onSceneAt: null,
      transportingAt: null,
      arrivedAt: null,
      call: { callerName: call.callerName, note: call.note, basePriority: call.basePriority, lat: call.lat, lng: call.lng, arrivalTime: call.arrivalTime },
      hospital: { id: hospital.id, name: hospital.name, lat: hospital.lat, lng: hospital.lng },
      routePolyline,
      ambulanceId: targetAmbulance.id,
      distanceKm,
      etaMin,
      etaToSceneSec: etaMin * 60,
      etaToHospitalSec: etaToHospitalMin * 60,
    };

    this.activeTrips.set(targetAmbulance.id, trip);
    this.log(`Trip reassigned from ${sourceAmbulance.name} to ${targetAmbulance.name} for ${call.callerName}`);

    return { ok: true };
  }

  /** Return the list of hospitals. */
  getHospitals() {
    return this.hospitals;
  }

  /** Return paginated, filterable trip history. */
  getTripHistory({ from, to, ambulanceId, severity, status, page = 1, limit = 50 } = {}) {
    let filtered = this.tripHistory;
    if (from) filtered = filtered.filter((t) => new Date(t.dispatchedAt) >= new Date(from));
    if (to) filtered = filtered.filter((t) => new Date(t.dispatchedAt) <= new Date(to));
    if (ambulanceId) filtered = filtered.filter((t) => t.ambulanceId === ambulanceId);
    if (severity) filtered = filtered.filter((t) => t.severity === Number(severity));
    if (status) filtered = filtered.filter((t) => t.status === status);

    const total = filtered.length;
    const startIdx = (page - 1) * limit;
    const trips = filtered.slice(startIdx, startIdx + limit);

    return { trips, total, page: Number(page), limit: Number(limit) };
  }

  /** Pick the hospital closest to a given lat/lng. */
  _findNearestHospital(lat, lng) {
    let nearest = this.hospitals[0];
    let minDist = Infinity;
    for (const h of this.hospitals) {
      const d = haversineKm({ lat, lng }, { lat: h.lat, lng: h.lng });
      if (d < minDist) {
        minDist = d;
        nearest = h;
      }
    }
    return nearest;
  }

  /** Finish a trip: record history, completed events, mark ambulance available, try next dispatch. */
  _finishTrip(ambulanceId, trip) {
    const ambulance = this.ambulances.find((a) => a.id === ambulanceId);
    if (!ambulance) return;

    const responseTimeMin = trip.onSceneAt
      ? Math.round((trip.onSceneAt - trip.dispatchedAt) / 60000)
      : 0;
    const waitMinutes = Math.round((Date.now() - trip.call.arrivalTime) / 60000);

    this.completedEvents.push({
      type: 'ambulance',
      severity: trip.call.basePriority,
      waitMinutes,
      responseMinutes: responseTimeMin,
      completedAt: Date.now(),
    });

    this.tripHistory.push({
      id: trip.id,
      ambulanceId,
      ambulanceName: ambulance.name,
      callerName: trip.call.callerName,
      note: trip.call.note,
      severity: trip.call.basePriority,
      status: 'arrived',
      dispatchedAt: new Date(trip.dispatchedAt).toISOString(),
      enRouteAt: trip.enRouteAt ? new Date(trip.enRouteAt).toISOString() : null,
      onSceneAt: trip.onSceneAt ? new Date(trip.onSceneAt).toISOString() : null,
      transportingAt: trip.transportingAt ? new Date(trip.transportingAt).toISOString() : null,
      arrivedAt: new Date(trip.arrivedAt || Date.now()).toISOString(),
      responseTimeMin,
      hospitalId: trip.hospital.id,
      hospitalName: trip.hospital.name,
    });

    ambulance.lat = trip.hospital.lat + (Math.random() - 0.5) * 0.002;
    ambulance.lng = trip.hospital.lng + (Math.random() - 0.5) * 0.002;
    ambulance.status = 'available';
    this.activeTrips.delete(ambulanceId);
    this.log(`${ambulance.name} completed transport of ${trip.call.callerName}, back in service`);

    this.runDispatchLoop();
  }

  /** Auto-advance trip statuses on each tick: dispatched -> en_route -> on_scene -> transporting -> arrived. */
  _advanceTrips() {
    const now = Date.now();
    for (const [ambulanceId, trip] of this.activeTrips) {
      const ambulance = this.ambulances.find((a) => a.id === ambulanceId);
      if (!ambulance) continue;

      if (trip.status === 'dispatched') {
        const elapsedSec = (now - trip.dispatchedAt) / 1000;
        if (elapsedSec >= 5) {
          trip.status = 'en_route';
          trip.enRouteAt = now;
          this.log(`${ambulance.name} is now en route to ${trip.call.callerName}`);
        }
      } else if (trip.status === 'en_route') {
        const elapsedSec = (now - trip.enRouteAt) / 1000;
        if (elapsedSec >= trip.etaToSceneSec) {
          trip.status = 'on_scene';
          trip.onSceneAt = now;
          ambulance.lat = trip.call.lat;
          ambulance.lng = trip.call.lng;
          this.log(`${ambulance.name} arrived on scene for ${trip.call.callerName}`);
        } else {
          this._moveAmbulanceAlongRoute(ambulance, trip, elapsedSec, trip.etaToSceneSec);
        }
      } else if (trip.status === 'on_scene') {
        const elapsedSec = (now - trip.onSceneAt) / 1000;
        if (elapsedSec >= 10) {
          trip.status = 'transporting';
          trip.transportingAt = now;
          trip.routePolyline = [
            [trip.call.lat, trip.call.lng],
            [(trip.call.lat + trip.hospital.lat) / 2, (trip.call.lng + trip.hospital.lng) / 2],
            [trip.hospital.lat, trip.hospital.lng],
          ];
          trip.etaMin = trip.etaToHospitalSec / 60;
          this.log(`${ambulance.name} transporting ${trip.call.callerName} to ${trip.hospital.name}`);
        }
      } else if (trip.status === 'transporting') {
        const elapsedSec = (now - trip.transportingAt) / 1000;
        if (elapsedSec >= trip.etaToHospitalSec) {
          trip.status = 'arrived';
          trip.arrivedAt = now;
          this._finishTrip(ambulanceId, trip);
        } else {
          this._moveAmbulanceAlongRoute(ambulance, trip, elapsedSec, trip.etaToHospitalSec);
        }
      }
    }
  }

  /** Interpolate ambulance position along its route polyline. */
  _moveAmbulanceAlongRoute(ambulance, trip, elapsedSec, totalSec) {
    const from = trip.routePolyline[0];
    const to = trip.routePolyline[trip.routePolyline.length - 1];
    const ratio = Math.min(1, totalSec > 0 ? elapsedSec / totalSec : 0);
    ambulance.lat = from[0] + (to[0] - from[0]) * ratio;
    ambulance.lng = from[1] + (to[1] - from[1]) * ratio;
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

    // avgResponseTimeBySeverity from trip history
    const arrived = this.tripHistory.filter((t) => t.status === 'arrived' && t.responseTimeMin > 0);
    const severityMap = {};
    for (const t of arrived) {
      if (!severityMap[t.severity]) severityMap[t.severity] = [];
      severityMap[t.severity].push(t.responseTimeMin);
    }
    const avgResponseTimeBySeverity = Object.entries(severityMap)
      .map(([severity, times]) => ({
        severity: Number(severity),
        avgMinutes: Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)),
        count: times.length,
      }))
      .sort((a, b) => a.severity - b.severity);

    // callsByHour from trip history
    const hourMap = {};
    for (const t of arrived) {
      const hour = new Date(t.dispatchedAt).getHours();
      if (!hourMap[hour]) hourMap[hour] = { count: 0, totalMin: 0 };
      hourMap[hour].count += 1;
      hourMap[hour].totalMin += t.responseTimeMin;
    }
    const callsByHour = Object.entries(hourMap)
      .map(([hour, d]) => ({
        hour: Number(hour),
        count: d.count,
        avgResponseMin: Number((d.totalMin / d.count).toFixed(1)),
      }))
      .sort((a, b) => a.hour - b.hour);

    // callOutcomes
    const arrivedCount = this.tripHistory.filter((t) => t.status === 'arrived').length;
    const cancelledCount = this.tripHistory.filter((t) => t.status === 'cancelled').length;
    const callOutcomes = [
      { label: 'Transported', value: arrivedCount || 0 },
      { label: 'Cancelled', value: cancelledCount || 0 },
    ];

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
      avgResponseTimeBySeverity,
      callsByHour,
      callOutcomes,
    };
  }

  // ---------- Snapshot for broadcasting ----------

  getState() {
    const now = Date.now();
    const totalUnits = this.ambulances.length;
    const available = this.ambulances.filter((a) => a.status === 'available').length;
    const dispatched = this.ambulances.filter((a) => a.status === 'dispatched' || a.status === 'en_route').length;
    const onScene = this.ambulances.filter((a) => a.status === 'on_scene').length;

    for (const amb of this.ambulances) {
      amb.utilization = amb.status !== 'available' ? 1 : 0;
    }

    const completedTrips = this.tripHistory.filter((t) => t.status === 'arrived' && t.responseTimeMin > 0);
    const avgResponseTimeMin = completedTrips.length
      ? Number((completedTrips.reduce((sum, t) => sum + t.responseTimeMin, 0) / completedTrips.length).toFixed(1))
      : 0;

    const callSnapshots = this.callsQueue.snapshot(now);
    const avgWaitTimeMin = callSnapshots.length
      ? Number((callSnapshots.reduce((sum, c) => sum + (c.waitMinutes || 0), 0) / callSnapshots.length).toFixed(1))
      : 0;

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
      callsQueue: callSnapshots,
      ambulances: this.ambulances.map((a) => {
        const trip = this.activeTrips.get(a.id);
        return {
          ...a,
          trip: trip
            ? {
                ...trip,
                call: { ...trip.call },
                hospital: { ...trip.hospital },
                routePolyline: [...trip.routePolyline],
                dispatchedAt: new Date(trip.dispatchedAt).toISOString(),
                enRouteAt: trip.enRouteAt ? new Date(trip.enRouteAt).toISOString() : null,
                onSceneAt: trip.onSceneAt ? new Date(trip.onSceneAt).toISOString() : null,
                transportingAt: trip.transportingAt ? new Date(trip.transportingAt).toISOString() : null,
                arrivedAt: trip.arrivedAt ? new Date(trip.arrivedAt).toISOString() : null,
              }
            : null,
        };
      }),
      stats: {
        totalUnits,
        available,
        dispatched,
        onScene,
        avgResponseTimeMin,
        callsWaiting: this.callsQueue.size(),
        avgWaitTimeMin,
      },
      metrics: summarize(this.completedEvents, this.ambulances),
      eventLog: this.eventLog,
      scheduler: this.getSchedulerConfig(),
    };
  }
}

module.exports = { HospitalStore, SEVERITY_LABELS, HOSPITAL };
