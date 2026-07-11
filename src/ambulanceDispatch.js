/**
 * Ambulance dispatch matching.
 *
 * OS mapping: this is a resource-allocation matching problem, structurally
 * similar to assigning the best available "device" (ambulance) to the
 * highest-priority pending "request" (emergency call), factoring in
 * expected service time (ETA) the way SJF/SRTF factor in burst time.
 *
 * Algorithm:
 *   1. Pending calls live in the same PriorityQueue (with aging) used for
 *      patients, so a call that's been waiting for a free ambulance also
 *      ages toward higher urgency -- no call is starved indefinitely.
 *   2. On every dispatch tick, we always try to serve the MOST URGENT call
 *      first (priority-first). For that call, among currently available
 *      ambulances we pick the one with the lowest ETA (haversine distance /
 *      speed) -- this is the resource-matching / shortest-response part.
 *   3. If no ambulance is available, the call stays queued (and keeps
 *      aging) until one frees up.
 */

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two lat/lng points, in km. */
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_KM * c;
}

function etaMinutes(distanceKm, speedKmh) {
  if (speedKmh <= 0) return Infinity;
  return (distanceKm / speedKmh) * 60;
}

/**
 * Given the top (most urgent) pending call and a list of ambulances,
 * choose the best available ambulance by lowest ETA.
 * Returns { ambulance, distanceKm, etaMin } or null if none available.
 */
function findBestAmbulance(call, ambulances) {
  let best = null;
  for (const amb of ambulances) {
    if (amb.status !== 'available') continue;
    const distanceKm = haversineKm(
      { lat: amb.lat, lng: amb.lng },
      { lat: call.lat, lng: call.lng }
    );
    const etaMin = etaMinutes(distanceKm, amb.speedKmh);
    if (!best || etaMin < best.etaMin) {
      best = { ambulance: amb, distanceKm, etaMin };
    }
  }
  return best;
}

/**
 * Runs one dispatch pass: for the single most urgent pending call, try to
 * assign the best available ambulance. Returns the assignment or null.
 * (Called repeatedly by the server whenever calls/ambulances change.)
 */
function dispatchNext(callsQueue, ambulances, now = Date.now()) {
  const topCall = callsQueue.peek(now);
  if (!topCall) return null;

  const match = findBestAmbulance(topCall, ambulances);
  if (!match) return null; // no ambulance free -- call keeps waiting (and aging)

  callsQueue.remove(topCall.id);
  return {
    call: topCall,
    ambulance: match.ambulance,
    distanceKm: match.distanceKm,
    etaMin: match.etaMin,
  };
}

module.exports = { haversineKm, etaMinutes, findBestAmbulance, dispatchNext };
