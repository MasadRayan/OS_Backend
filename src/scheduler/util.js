function enrichBase(entry, now) {
  const waitMinutes = Math.floor((now - entry.arrivalTime) / 60000);
  let deadlineSlackMin = null;
  let deadlineMissed = false;
  if (entry.deadlineAt) {
    deadlineSlackMin = Number(((entry.deadlineAt - now) / 60000).toFixed(1));
    deadlineMissed = deadlineSlackMin < 0;
  }
  return { ...entry, waitMinutes, deadlineSlackMin, deadlineMissed };
}

module.exports = { enrichBase };
