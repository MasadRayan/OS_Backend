const express = require('express');
const cors = require('cors');
const { HospitalStore } = require('./src/store');
const { computeResponseTimeStats } = require('./src/metrics');

const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
app.use(express.json());

const store = new HospitalStore();

// Drives condition auto-escalation, ER->ICU->WARD department transitions,
// ambulance dispatch retries, and Analysis-page trend history -- all on one
// server-side clock so behavior keeps progressing even with no client polling.
setInterval(() => {
  store.tick();
  store.pushMetricsSnapshot();
}, 5000);

const router = express.Router();

router.get('/health', (_req, res) => res.json({ ok: true }));

router.get('/config/scheduler', (_req, res) => {
  res.json(store.getSchedulerConfig());
});

router.put('/config/scheduler', (req, res) => {
  var algorithm = req.body && req.body.algorithm;
  if (!algorithm) {
    return res.status(400).json({ error: 'algorithm is required' });
  }
  try {
    store.setScheduler(algorithm, req.body.params);
    res.json(store.getSchedulerConfig());
  } catch (e) {
    res.status(400).json({ error: 'unknown algorithm' });
  }
});

router.get('/state', (_req, res) => {
  res.json(store.getState());
});

router.get('/analysis', (_req, res) => {
  res.json(store.getAnalysis());
});

router.post('/patients', (req, res) => {
  const { name, age, condition, severity } = req.body || {};
  if (!name || !severity) {
    return res.status(400).json({ error: 'name and severity are required' });
  }
  store.admitToWaitingList({ name, age, condition, severity: Number(severity) });
  res.status(201).json(store.getState());
});

router.post('/patients/treat-next', (_req, res) => {
  const result = store.treatNextPatient();
  res.json({ result, state: store.getState() });
});

router.post('/patients/:id/discharge', (req, res) => {
  const result = store.dischargePatient(req.params.id);
  res.json({ result, state: store.getState() });
});

router.post('/patients/:id/transfer-to-icu', (req, res) => {
  const result = store.transferToIcu(req.params.id);
  res.json({ result, state: store.getState() });
});

router.post('/ambulance/request', (req, res) => {
  const { callerName, lat, lng, severity, note } = req.body || {};
  if (!callerName || lat == null || lng == null || !severity) {
    return res.status(400).json({ error: 'callerName, lat, lng and severity are required' });
  }
  store.requestAmbulance({ callerName, lat, lng, severity: Number(severity), note });
  res.status(201).json(store.getState());
});

router.post('/ambulance/:id/complete-trip', (req, res) => {
  const result = store.completeTrip(req.params.id);
  if (!result.ok) return res.status(400).json(result);
  res.json({ state: store.getState() });
});

router.post('/ambulance/:id/cancel', (req, res) => {
  const result = store.cancelTrip(req.params.id, req.body && req.body.reason);
  if (!result.ok) return res.status(400).json(result);
  res.json({ state: store.getState() });
});

router.post('/ambulance/:id/reassign', (req, res) => {
  const { targetAmbulanceId } = req.body || {};
  if (!targetAmbulanceId) return res.status(400).json({ error: 'targetAmbulanceId is required' });
  const result = store.reassignTrip(req.params.id, targetAmbulanceId);
  if (!result.ok) return res.status(400).json(result);
  res.json({ state: store.getState() });
});

router.get('/hospitals', (_req, res) => {
  res.json(store.getHospitals());
});

router.get('/ambulance/history', (req, res) => {
  const { from, to, ambulanceId, severity, status, page, limit } = req.query;
  res.json(store.getTripHistory({ from, to, ambulanceId, severity, status, page, limit }));
});

router.get('/analysis/response-times', (_req, res) => {
  res.json(computeResponseTimeStats(store.tripHistory));
});

app.use('/api', router);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Hospital triage REST API listening on http://localhost:${PORT}/api`);
});
