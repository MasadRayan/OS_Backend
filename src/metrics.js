/**
 * Performance metrics -- mirrors the "Performance Analyzer" module of a
 * classic OS scheduling report: average waiting time, throughput, and a
 * fairness measure, computed per severity level so scheduling trade-offs
 * (e.g. "does aging cost critical patients any time?") are visible.
 */

function summarize(completedEvents, ambulances, windowMinutes = 60) {
  // completedEvents: [{ type: 'patient'|'ambulance', severity, waitMinutes, completedAt }]
  const now = Date.now();
  const windowStart = now - windowMinutes * 60000;
  const recent = completedEvents.filter((e) => e.completedAt >= windowStart);

  const bySeverity = {};
  for (let s = 1; s <= 5; s++) {
    const items = recent.filter((e) => e.severity === s);
    bySeverity[s] = {
      count: items.length,
      avgWaitMinutes: items.length
        ? Number(
            (items.reduce((sum, e) => sum + e.waitMinutes, 0) / items.length).toFixed(1)
          )
        : 0,
    };
  }

  const allWaits = recent.map((e) => e.waitMinutes);
  const avgWaitMinutes = allWaits.length
    ? Number((allWaits.reduce((a, b) => a + b, 0) / allWaits.length).toFixed(1))
    : 0;

  // Fairness: coefficient of variation of avg wait across severities that
  // have at least one sample -- lower = fairer spread of waiting burden.
  const activeAverages = Object.values(bySeverity)
    .filter((s) => s.count > 0)
    .map((s) => s.avgWaitMinutes);
  let fairnessIndex = 1; // 1 = perfectly even, lower = less fair
  if (activeAverages.length > 1) {
    const mean = activeAverages.reduce((a, b) => a + b, 0) / activeAverages.length;
    const variance =
      activeAverages.reduce((a, b) => a + (b - mean) ** 2, 0) / activeAverages.length;
    const stdDev = Math.sqrt(variance);
    fairnessIndex = mean > 0 ? Number((1 - Math.min(1, stdDev / mean)).toFixed(2)) : 1;
  }

  const busyAmbulances = ambulances.filter((a) => a.status !== 'available').length;
  const ambulanceUtilization = ambulances.length
    ? Number(((busyAmbulances / ambulances.length) * 100).toFixed(1))
    : 0;

  const throughputPerHour = Number(
    ((recent.length / windowMinutes) * 60).toFixed(1)
  );

  return {
    windowMinutes,
    avgWaitMinutes,
    bySeverity,
    fairnessIndex,
    ambulanceUtilization,
    throughputPerHour,
    totalCompleted: recent.length,
  };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return Number((sorted[lower] * (upper - index) + sorted[upper] * (index - lower)).toFixed(1));
}

/**
 * Response-time statistics computed from completed trip history.
 * Returns { byHour, bySeverity, overall } with p50/p95 percentiles.
 */
function computeResponseTimeStats(tripHistory) {
  const trips = tripHistory.filter((t) => t.status === 'arrived' && t.responseTimeMin > 0);

  const bySeverityMap = {};
  for (const trip of trips) {
    const s = trip.severity;
    if (!bySeverityMap[s]) bySeverityMap[s] = [];
    bySeverityMap[s].push(trip.responseTimeMin);
  }
  const bySeverity = Object.entries(bySeverityMap)
    .map(([severity, times]) => ({
      severity: Number(severity),
      count: times.length,
      avgMinutes: Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)),
      p50: percentile(times, 50),
      p95: percentile(times, 95),
    }))
    .sort((a, b) => a.severity - b.severity);

  const byHourMap = {};
  for (const trip of trips) {
    const hour = new Date(trip.dispatchedAt).getHours();
    if (!byHourMap[hour]) byHourMap[hour] = [];
    byHourMap[hour].push(trip.responseTimeMin);
  }
  const byHour = Object.entries(byHourMap)
    .map(([hour, times]) => ({
      hour: Number(hour),
      count: times.length,
      avgMinutes: Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)),
      p50: percentile(times, 50),
      p95: percentile(times, 95),
    }))
    .sort((a, b) => a.hour - b.hour);

  const allTimes = trips.map((t) => t.responseTimeMin);
  const overall = {
    avgMinutes: allTimes.length
      ? Number((allTimes.reduce((a, b) => a + b, 0) / allTimes.length).toFixed(1))
      : 0,
    p50: percentile(allTimes, 50),
    p95: percentile(allTimes, 95),
    totalTrips: allTimes.length,
  };

  return { byHour, bySeverity, overall };
}

module.exports = { summarize, computeResponseTimeStats, percentile };
