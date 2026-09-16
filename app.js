// ============================================================
// Camp Travel Map — app logic
// ============================================================

const PLEASANTON = { lat: 37.6624, lng: -121.8747 };
const EDITS_KEY = 'campapp_edits_v1';
const CUSTOM_PINS_KEY = 'campapp_custom_pins_v1';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Cool season" months get a relaxed daytime-high floor (55°F instead of 60°F) per Laura's
// weather criteria — matches the same methodology used in her Campground Road Trip Planner
// spreadsheet's "Climate by Month" tab (58 curated regions, baked into AREAS below).
const COOL_SEASON_MONTHS = ['Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

const CATEGORY_ORDER = ['Camping', 'Things To Do', 'Food & Drink'];
const CAMPING_SUBCATS = ['Public', 'Private', 'Boondocking', 'Harvest Host'];
const THINGSTODO_SUBCATS = ['State / Nat Parks', 'Points of Interest', 'Hikes', 'Scenic Drives', 'Sites', 'Hot Springs', 'Swim Area', 'Adventures'];
const FOODDRINK_SUBCATS = ['Food', 'Drinks'];

const CATEGORY_SUBCATS = {
  'Camping': CAMPING_SUBCATS,
  'Things To Do': THINGSTODO_SUBCATS,
  'Food & Drink': FOODDRINK_SUBCATS
};

const CATEGORY_COLORS = {
  'Camping': '#2f5233',
  'Things To Do': '#8b6f47',
  'Food & Drink': '#b5493b'
};

// Emoji glyph per sub-category ("type"), grouped by category — the colored
// circle behind it (CATEGORY_COLORS) tells you the category, the glyph tells
// you the type within it.
const CATEGORY_FALLBACK_ICON = { 'Camping': '⛺', 'Things To Do': '📍', 'Food & Drink': '🍽️' };
const TYPE_ICONS = {
  'Camping': { 'Public': '⛺', 'Private': '🚐', 'Boondocking': '🌲', 'Harvest Host': '🚜' },
  'Things To Do': {
    'State / Nat Parks': '🌲',
    'Points of Interest': '📍',
    'Hikes': '🥾',
    'Scenic Drives': '🚗',
    'Sites': '🏛️',
    'Hot Springs': '♨️',
    'Swim Area': '🏊',
    'Adventures': '🧭'
  },
  'Food & Drink': { 'Food': '🍽️', 'Drinks': '🍺' }
};

function markerGlyph(p) {
  const byCat = TYPE_ICONS[p.category];
  return (byCat && byCat[p.subcategory]) || CATEGORY_FALLBACK_ICON[p.category] || '📍';
}

const markerIconCache = {};
function getMarkerIcon(p) {
  const color = CATEGORY_COLORS[p.category] || '#555';
  const glyph = markerGlyph(p);
  const key = color + '|' + glyph;
  if (!markerIconCache[key]) {
    markerIconCache[key] = L.divIcon({
      className: 'pin-icon',
      html: '<div class="pin-icon-inner" style="background:' + color + '">' + glyph + '</div>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -15]
    });
  }
  return markerIconCache[key];
}

// ---------- Local edits (localStorage) ----------
function loadEdits() {
  try { return JSON.parse(localStorage.getItem(EDITS_KEY) || '{}'); }
  catch (e) { return {}; }
}
function saveEdits(edits) {
  try { localStorage.setItem(EDITS_KEY, JSON.stringify(edits)); } catch (e) { /* ignore */ }
  scheduleCloudPush();
}
let EDITS = loadEdits();

// ---------- Custom pins the user added in-app (localStorage) ----------
function loadCustomPins() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_PINS_KEY) || '[]'); }
  catch (e) { return []; }
}
function saveCustomPins(pins) {
  try { localStorage.setItem(CUSTOM_PINS_KEY, JSON.stringify(pins)); } catch (e) { /* ignore */ }
  scheduleCloudPush();
}
let CUSTOM_PINS = loadCustomPins();

// ---------- Cloud sync (Firebase) ----------
// Keeps edits, custom pins, and trips in sync across devices by mirroring the exact
// same {edits, customPins, trips} shape used by Export/Import into one shared
// Firestore document, instead of leaving each device's localStorage as the only copy.
// If Firebase hasn't been configured yet (FIREBASE_CONFIG still has placeholder
// values), everything below quietly no-ops and the app behaves exactly as before —
// local-only, manual Export/Import still works either way.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDKfde6k5a8cm_rtZwXgl9GEkzpukllSWc',
  authDomain: 'map-app-e4424.firebaseapp.com',
  projectId: 'map-app-e4424',
  storageBucket: 'map-app-e4424.firebasestorage.app',
  messagingSenderId: '517323198346',
  appId: '1:517323198346:web:fb88b3566cd9692cbc8273'
};
const CLOUD_COLLECTION = 'campTravelMap';
const CLOUD_DOC_ID = 'sharedState';
const cloudSyncEnabled = typeof firebase !== 'undefined' &&
  !!FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey.indexOf('YOUR_') !== 0;

let cloudDb = null;
let cloudReady = Promise.resolve(false); // resolves true once signed in and usable

function setSyncStatus(text, isError) {
  const el = document.getElementById('cloud-sync-status');
  if (!el) return;
  if (!text) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = 'block';
  el.textContent = text;
  el.style.color = isError ? '#b5493b' : '';
}

if (cloudSyncEnabled) {
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    cloudDb = firebase.firestore();
    cloudReady = firebase.auth().signInAnonymously()
      .then(() => true)
      .catch(err => {
        console.error('Cloud sync sign-in failed:', err);
        setSyncStatus('Cloud sync unavailable (sign-in failed).', true);
        return false;
      });
  } catch (e) {
    console.error('Cloud sync init failed:', e);
    cloudReady = Promise.resolve(false);
  }
}

function currentCloudPayload() {
  return { edits: EDITS, customPins: CUSTOM_PINS, trips: TRIPS };
}

// Immediate, awaited push. Used right before every location.reload() so the write is
// actually sent (not merely scheduled) before the page navigates away — a debounced
// push alone would get cancelled by an immediately-following reload. Races a 4s
// timeout so a slow or offline connection never blocks the reload indefinitely.
function pushCloudStateNow() {
  if (!cloudSyncEnabled) return Promise.resolve();
  setSyncStatus('Syncing...');
  return cloudReady.then(ok => {
    if (!ok) return;
    const docRef = cloudDb.collection(CLOUD_COLLECTION).doc(CLOUD_DOC_ID);
    const write = docRef.set({
      payloadJson: JSON.stringify(currentCloudPayload()),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    const timeout = new Promise(resolve => setTimeout(resolve, 4000));
    return Promise.race([write, timeout]);
  }).then(() => { setSyncStatus('Synced just now.'); })
    .catch(err => {
      console.error('Cloud push failed:', err);
      setSyncStatus('Sync failed — will retry next visit.', true);
    });
}

// Debounced push for the common case (an isolated field edit, a checkbox toggle) with
// no immediately-following reload to race against.
let cloudPushTimer = null;
function scheduleCloudPush() {
  if (!cloudSyncEnabled) return;
  clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => { pushCloudStateNow(); }, 1200);
}

// Merges a payload pulled from the cloud into current local state. This only ever runs
// once, at page load, before the user has made any new local changes this session — so
// it's safe to simply adopt whatever the remote copy says whenever it differs from the
// local copy (matches her actual usage pattern: edit on one device, check the other
// later, never two devices editing at once). For each id that exists on both sides, this
// deep-replaces the local entry with the remote one when they differ — not just "bring
// in ids local doesn't have yet" — so edits to something ALREADY synced (e.g. a new
// activity added to a trip that already exists on both devices) actually come through,
// instead of only ever picking up brand-new trips/pins/edits.
// Returns true if anything actually changed (caller decides whether to reload).
function mergeCloudPayload(remote) {
  let changed = false;

  if (remote.edits) {
    let editsChanged = false;
    Object.keys(remote.edits).forEach(id => {
      if (JSON.stringify(EDITS[id]) !== JSON.stringify(remote.edits[id])) {
        EDITS[id] = remote.edits[id];
        editsChanged = true;
      }
    });
    if (editsChanged) { saveEdits(EDITS); changed = true; }
  }

  if (remote.customPins && remote.customPins.length) {
    const localById = new Map(CUSTOM_PINS.map(p => [p.id, p]));
    let pinsChanged = false;
    remote.customPins.forEach(p => {
      const existing = localById.get(p.id);
      if (!existing) {
        CUSTOM_PINS.push(p);
        localById.set(p.id, p);
        pinsChanged = true;
      } else if (JSON.stringify(existing) !== JSON.stringify(p)) {
        Object.assign(existing, p);
        pinsChanged = true;
      }
    });
    if (pinsChanged) { saveCustomPins(CUSTOM_PINS); changed = true; }
  }

  if (remote.trips && remote.trips.length) {
    const localById = new Map(TRIPS.map(t => [t.id, t]));
    let tripsChanged = false;
    remote.trips.forEach(t => {
      const existing = localById.get(t.id);
      if (!existing) {
        TRIPS.push(t);
        localById.set(t.id, t);
        tripsChanged = true;
      } else if (JSON.stringify(existing) !== JSON.stringify(t)) {
        Object.assign(existing, t);
        tripsChanged = true;
      }
    });
    if (tripsChanged) { saveTrips(TRIPS); changed = true; }
  }

  return changed;
}

// Pulled once per page load (from init()). Not a live listener by design — Laura's
// actual use pattern is "edit on one device, check the other later," not simultaneous
// editing on two devices at once, so a page-load sync is enough without the added
// complexity (and feedback-loop risk) of a real-time subscription.
function pullCloudStateOnce() {
  if (!cloudSyncEnabled) return;
  cloudReady.then(ok => {
    if (!ok) return;
    setSyncStatus('Checking for updates from your other devices...');
    return cloudDb.collection(CLOUD_COLLECTION).doc(CLOUD_DOC_ID).get();
  }).then(snap => {
    if (!snap) return;
    if (!snap.exists) { setSyncStatus('Cloud sync is on — no shared data yet.'); return; }
    const data = snap.data();
    let remote = {};
    try { remote = JSON.parse(data.payloadJson || '{}'); } catch (e) { remote = {}; }
    if (mergeCloudPayload(remote)) {
      setSyncStatus('Found updates from another device — refreshing...');
      location.reload();
    } else {
      setSyncStatus('Cloud sync is on — you\'re up to date.');
    }
  }).catch(err => {
    console.error('Cloud pull failed:', err);
    setSyncStatus('Cloud sync is on — could not reach the server just now.', true);
  });
}

// Manual "Sync now" button. The two automatic paths (a debounced push after any save,
// a pull-once on page load) normally keep devices in sync without her having to think
// about it -- but a push is a full overwrite of the shared doc with whatever THIS
// device's local data is (not a merge), so if something else ever pushes stale/empty
// data (as an unrelated bug once did during testing), the fix is to open the app on
// the device that actually has the right data and push it back up manually. Push what
// this device has, then immediately re-pull so this device also picks up anything new
// (a reload happens automatically if the pull finds something to merge in).
function syncNowClicked() {
  const btn = document.getElementById('cloud-sync-now-btn');
  if (btn) btn.disabled = true;
  pushCloudStateNow().then(() => pullCloudStateOnce()).finally(() => {
    if (btn) btn.disabled = false;
  });
}

// ---------- Nearby towns/cities (live lookup, cached in the browser) ----------
// Precomputed near_town/nearest_town_name/nearest_town_miles (from data.js) only ever
// captured the single closest match, which could hide a bigger city a bit further away
// (e.g. Henderson at 3mi hid Las Vegas at 8mi). This does a live lookup of every
// city/town within ~10mi from the user's own browser (which has normal internet access)
// and caches the result per-pin so it's fast on repeat visits.
const NEARBY_TOWNS_KEY = 'campapp_nearby_towns_v1';
const NEARBY_TOWNS_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 days — towns don't move
function loadNearbyTownsCache() {
  try { return JSON.parse(localStorage.getItem(NEARBY_TOWNS_KEY) || '{}'); }
  catch (e) { return {}; }
}
function saveNearbyTownsCache(cache) {
  try { localStorage.setItem(NEARBY_TOWNS_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ }
}
let NEARBY_TOWNS_CACHE = loadNearbyTownsCache();

async function fetchNearbyTowns(pinId, lat, lng) {
  const cached = NEARBY_TOWNS_CACHE[pinId];
  if (cached && (Date.now() - cached.fetchedAt) < NEARBY_TOWNS_TTL_MS) return cached.towns;

  const milesToDeg = 10.5 / 69; // ~10.5mi of latitude margin, in degrees
  const lngDeg = milesToDeg / Math.max(0.2, Math.cos(lat * Math.PI / 180));
  const south = lat - milesToDeg, north = lat + milesToDeg;
  const west = lng - lngDeg, east = lng + lngDeg;
  const query = '[out:json][timeout:20];node["place"~"^(city|town)$"](' +
    south + ',' + west + ',' + north + ',' + east + ');out body;';
  const url = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query);

  const resp = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined });
  if (!resp.ok) throw new Error('Overpass error ' + resp.status);
  const data = await resp.json();
  const seen = new Set();
  const towns = (data.elements || [])
    .filter(el => el.tags && el.tags.name && el.lat != null && el.lon != null)
    .map(el => ({ name: el.tags.name, miles: haversineMiles(lat, lng, el.lat, el.lon) }))
    .filter(t => t.miles <= 10)
    .sort((a, b) => a.miles - b.miles)
    .filter(t => {
      const key = t.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  NEARBY_TOWNS_CACHE[pinId] = { fetchedAt: Date.now(), towns: towns };
  saveNearbyTownsCache(NEARBY_TOWNS_CACHE);
  return towns;
}

// ---------- Best months by climate (live lookup, cached in the browser) ----------
// For the 58 curated areas in AREAS, month-level best-months data already comes straight
// from Laura's spreadsheet (months_that_pass — see getBestMonths). For any pin outside those
// areas, this fetches ~10 years of daily history from Open-Meteo (free, no key, CORS-open)
// straight from the user's browser and scores each calendar month against her 3 criteria:
//   1. Daytime high 60-80°F (relaxed to 55-80°F Nov-Mar)
//   2. Overnight low always above freezing
//   3. Monthly rainfall <= 2.5"
const CLIMATE_KEY = 'campapp_climate_v1';
const CLIMATE_TTL_MS = 1000 * 60 * 60 * 24 * 180; // 180 days — climate normals barely change
function loadClimateCache() {
  try { return JSON.parse(localStorage.getItem(CLIMATE_KEY) || '{}'); }
  catch (e) { return {}; }
}
function saveClimateCache(cache) {
  try { localStorage.setItem(CLIMATE_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ }
}
let CLIMATE_CACHE = loadClimateCache();

function monthsPassingWeatherCriteria(monthlyStats) {
  const passing = [];
  MONTH_ABBR.forEach(m => {
    const s = monthlyStats[m];
    if (!s || s.high == null || s.low == null || s.rainIn == null) return;
    const minHigh = COOL_SEASON_MONTHS.includes(m) ? 55 : 60;
    const tempOk = s.high >= minHigh && s.high <= 80;
    const frostOk = s.low > 32;
    const rainOk = s.rainIn <= 2.5;
    if (tempOk && frostOk && rainOk) passing.push(m);
  });
  return passing;
}

async function fetchClimateBestMonths(pinId, lat, lng) {
  const cached = CLIMATE_CACHE[pinId];
  if (cached && (Date.now() - cached.fetchedAt) < CLIMATE_TTL_MS) return cached.months;

  const url = 'https://archive-api.open-meteo.com/v1/archive?latitude=' + lat + '&longitude=' + lng +
    '&start_date=2015-01-01&end_date=2024-12-31&daily=temperature_2m_max,temperature_2m_min,precipitation_sum' +
    '&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto';
  const resp = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined });
  if (!resp.ok) throw new Error('Open-Meteo error ' + resp.status);
  const data = await resp.json();
  const days = data.daily;
  if (!days || !days.time) throw new Error('No climate data returned');

  const byMonth = {};
  MONTH_ABBR.forEach(m => byMonth[m] = { highs: [], lows: [], rainByYearMonth: {} });
  for (let i = 0; i < days.time.length; i++) {
    const parts = days.time[i].split('-'); // YYYY-MM-DD
    const m = MONTH_ABBR[parseInt(parts[1], 10) - 1];
    const hi = days.temperature_2m_max[i], lo = days.temperature_2m_min[i], rain = days.precipitation_sum[i];
    if (hi != null) byMonth[m].highs.push(hi);
    if (lo != null) byMonth[m].lows.push(lo);
    if (rain != null) {
      const key = parts[0] + '-' + parts[1];
      byMonth[m].rainByYearMonth[key] = (byMonth[m].rainByYearMonth[key] || 0) + rain;
    }
  }
  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const monthlyStats = {};
  MONTH_ABBR.forEach(m => {
    monthlyStats[m] = {
      high: avg(byMonth[m].highs),
      low: avg(byMonth[m].lows),
      rainIn: avg(Object.values(byMonth[m].rainByYearMonth))
    };
  });

  const months = monthsPassingWeatherCriteria(monthlyStats);
  CLIMATE_CACHE[pinId] = { fetchedAt: Date.now(), months: months };
  saveClimateCache(CLIMATE_CACHE);
  return months;
}

// One-time (per browser, ~180 days) background pass so pins outside the 58 curated areas
// get their live climate-based best-months WITHOUT Laura having to open each one individually
// — otherwise the "Best Month" sidebar/Nearby filters would silently miss them. Paced with a
// gap between requests so it never hammers Open-Meteo or the browser.
function prefetchClimateData() {
  const queue = allPins().filter(pin => {
    const p = effectivePin(pin);
    if (p.lat == null || p.lng == null) return false;
    if (p.best_months && p.best_months.length) return false;
    if (p.area && AREAS[p.area] && AREAS[p.area].months_that_pass) return false;
    const cached = CLIMATE_CACHE[p.id];
    return !(cached && (Date.now() - cached.fetchedAt) < CLIMATE_TTL_MS);
  });
  if (!queue.length) return;
  const total = queue.length;
  const statusEl = document.getElementById('climate-prefetch-status');
  let i = 0, sinceRefresh = 0;
  function updateStatus() {
    if (!statusEl) return;
    statusEl.style.display = '';
    statusEl.textContent = 'Checking climate data for ' + (total - i) + ' more pin' + (total - i === 1 ? '' : 's') + ' in the background…';
  }
  function step() {
    if (i >= total) {
      if (statusEl) statusEl.style.display = 'none';
      applyFilters();
      return;
    }
    updateStatus();
    const p = effectivePin(queue[i]);
    i++;
    fetchClimateBestMonths(p.id, p.lat, p.lng).catch(() => {}).then(() => {
      sinceRefresh++;
      if (sinceRefresh >= 15) { sinceRefresh = 0; applyFilters(); }
      setTimeout(step, 350);
    });
  }
  setTimeout(step, 2000); // let the initial map/list render first
}

function allPins() { return PINS.concat(CUSTOM_PINS); }

function getPin(id) { return allPins().find(p => p.id === id); }

function effectivePin(pin) {
  const e = EDITS[pin.id];
  return e ? Object.assign({}, pin, e) : pin;
}

function updatePinEdit(id, fields) {
  EDITS[id] = Object.assign({}, EDITS[id] || {}, fields);
  saveEdits(EDITS);
}

// ---------- Filter state ----------
const filters = {
  search: '',
  categories: new Set(),
  campingSubcats: new Set(),
  thingsToDoSubcats: new Set(),
  fooddrinkSubcats: new Set(),
  starlink: false,
  hatch: false,
  bookableOnly: false,
  nearTown: false,
  visited: 'all',
  done: 'all',
  state: '',
  within400: false,
  priceMin: null,
  priceMax: null,
  months: new Set()
};

function bestMonthsState(p) {
  // 1. A manual override (set via the Edit form) wins outright.
  if (p.best_months && p.best_months.length) return { months: p.best_months, pending: false };
  // 2. One of the 58 curated areas from Laura's spreadsheet — precise month-level data.
  if (p.area && AREAS[p.area] && AREAS[p.area].months_that_pass) {
    return { months: AREAS[p.area].months_that_pass, pending: false };
  }
  // 3. Anywhere else: live-computed from climate history against her 3 weather criteria,
  // once fetchClimateBestMonths() has resolved and cached it (see openDetail).
  const cached = CLIMATE_CACHE[p.id];
  if (cached) return { months: cached.months, pending: false };
  return { months: [], pending: true };
}
function getBestMonths(p) { return bestMonthsState(p).months; }

function passesFilters(pin) {
  const p = effectivePin(pin);

  if (filters.search && !p.name.toLowerCase().includes(filters.search)) return false;
  if (filters.categories.size && !filters.categories.has(p.category)) return false;

  if (p.category === 'Camping') {
    if (filters.campingSubcats.size && !filters.campingSubcats.has(p.subcategory)) return false;
    if (filters.starlink && !p.starlink_friendly) return false;
    if (filters.hatch && !p.good_for_hatch) return false;
    if (filters.bookableOnly && !p.bookable) return false;
    if (filters.nearTown && !p.near_town) return false;
  }
  if (p.category === 'Things To Do' && filters.thingsToDoSubcats.size && !filters.thingsToDoSubcats.has(p.subcategory)) return false;
  if (p.category === 'Food & Drink' && filters.fooddrinkSubcats.size && !filters.fooddrinkSubcats.has(p.subcategory)) return false;

  if (p.is_campground) {
    if (filters.visited === 'visited' && !p.visited) return false;
    if (filters.visited === 'not-visited' && p.visited) return false;
  } else {
    if (filters.done === 'done' && !p.done) return false;
    if (filters.done === 'not-done' && p.done) return false;
  }

  if (filters.state && p.state !== filters.state) return false;
  if (filters.within400 && !(p.driving_miles_from_pleasanton != null && p.driving_miles_from_pleasanton <= 400)) return false;
  if (filters.priceMin != null && !(p.price_usd != null && p.price_usd >= filters.priceMin)) return false;
  if (filters.priceMax != null && !(p.price_usd != null && p.price_usd <= filters.priceMax)) return false;

  if (filters.months.size) {
    const months = getBestMonths(p);
    if (!months || !months.some(m => filters.months.has(m))) return false;
  }

  return true;
}

// ---------- Helpers ----------
function escapeHtml(s) {
  return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function badgesHtml(p) {
  let out = '';
  if (p.is_campground && p.visited) out += '<span class="badge visited">Visited</span>';
  if (!p.is_campground && p.done) out += '<span class="badge visited">Done</span>';
  if (p.starlink_friendly) out += '<span class="badge starlink">Starlink</span>';
  if (p.good_for_hatch) out += '<span class="badge hatch">Hatch view</span>';
  if (p.bookable) out += '<span class="badge">Bookable</span>';
  if (p.near_town) out += '<span class="badge">Near Town</span>';
  if (p.nearby_alltrails_hikes && p.nearby_alltrails_hikes.length) out += '<span class="badge hatch">' + p.nearby_alltrails_hikes.length + ' top hike' + (p.nearby_alltrails_hikes.length > 1 ? 's' : '') + '</span>';
  if (p.is_custom) out += '<span class="badge starlink">Your Pin</span>';
  return out;
}

function metaLine(p) {
  const parts = [
    p.category + (p.subcategory ? ' · ' + p.subcategory : ''),
    p.state || null,
    p.driving_miles_from_pleasanton != null ? Math.round(p.driving_miles_from_pleasanton) + ' mi from home' : null,
    p.price_usd != null ? '$' + p.price_usd + '/night' : null
  ];
  return parts.filter(Boolean).join(' · ');
}

function nearbyTownsHtml(towns, p) {
  if (!towns || !towns.length) {
    return p.nearest_town_name
      ? escapeHtml(p.nearest_town_name) + ' (' + p.nearest_town_miles + ' mi)'
      : 'None found within 10 miles.';
  }
  return towns.map(t => escapeHtml(t.name) + ' (' + (Math.round(t.miles * 10) / 10) + ' mi)').join(', ');
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// ---------- Map ----------
let map, markersLayer, currentView = 'map';

function initMap() {
  map = L.map('map').setView([39.5, -119], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  L.marker([PLEASANTON.lat, PLEASANTON.lng])
    .addTo(map)
    .bindPopup('<b>Pleasanton, CA</b><br>Home base');
  markersLayer = L.layerGroup().addTo(map);
}

function renderMap(pins) {
  markersLayer.clearLayers();
  pins.forEach(pin => {
    const p = effectivePin(pin);
    if (p.lat == null || p.lng == null) return;
    const marker = L.marker([p.lat, p.lng], { icon: getMarkerIcon(p) });
    marker.bindTooltip(p.name, { direction: 'top', offset: [0, -14] });
    marker.on('click', () => openDetail(p.id));
    markersLayer.addLayer(marker);
  });
}

// ---------- List ----------
function renderList(pins) {
  const container = document.getElementById('list-view');
  container.innerHTML = '';
  const sorted = pins.slice().sort((a, b) => a.name.localeCompare(b.name));
  sorted.forEach(pin => {
    const p = effectivePin(pin);
    const card = document.createElement('div');
    card.className = 'list-card';
    card.innerHTML =
      '<div class="list-card-main">' +
        '<div class="list-card-name">' + escapeHtml(p.name) + '</div>' +
        '<div class="list-card-meta">' + escapeHtml(metaLine(p)) + '</div>' +
        '<div>' + badgesHtml(p) + '</div>' +
      '</div>';
    card.addEventListener('click', () => openDetail(p.id));
    container.appendChild(card);
  });
}

// ---------- Apply filters / render ----------
function applyFilters() {
  updateSubfilterSectionVisibility();
  // Synthetic hike-ref pins (mirrored from a campground's nearby-hikes list so they can be
  // added as trip activities) sit at the same coordinates as their campground and don't
  // belong in the main browse/search experience — they're reached from the trip planner only.
  const all = allPins().filter(p => !p.is_hike_ref);
  const filtered = all.filter(passesFilters);
  document.getElementById('result-count').textContent = filtered.length + ' of ' + all.length + ' shown';
  if (currentView === 'map') renderMap(filtered);
  else renderList(filtered);
}

// Only show a category's "type" sub-filter section (Camping / Things To Do / Food & Drink)
// in the sidebar when that category is relevant to what's currently checked above — i.e.
// no categories checked (showing everything) or that specific category is checked.
function updateSubfilterSectionVisibility() {
  const cats = filters.categories;
  const showAll = cats.size === 0;
  const sections = [
    ['camping-subfilter-section', 'Camping'],
    ['thingstodo-subfilter-section', 'Things To Do'],
    ['fooddrink-subfilter-section', 'Food & Drink']
  ];
  sections.forEach(([id, cat]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !showAll && !cats.has(cat));
  });
}

// ---------- Detail / edit panel ----------
function bestMonthsDisplayHtml(p) {
  const state = bestMonthsState(p);
  if (state.months.length) return state.months.join(', ');
  if (state.pending) return 'Checking typical climate for this spot&hellip;';
  return 'No months meet the mild-weather criteria here (60&ndash;80&deg;F days, no frost, &le;2.5&Prime; rain &mdash; relaxed to 55&deg;F Nov&ndash;Mar).';
}

function buildDetailHtml(p) {
  const bestMonths = getBestMonths(p);
  const rows = [];

  rows.push('<h2>' + escapeHtml(p.name) + '</h2>');
  rows.push('<div class="detail-badges">' + badgesHtml(p) + '</div>');

  const townsOverride = p.nearby_towns_override || '';
  const cachedTowns = NEARBY_TOWNS_CACHE[p.id] && NEARBY_TOWNS_CACHE[p.id].towns;
  const townsDisplay = townsOverride ? escapeHtml(townsOverride) :
    (cachedTowns ? nearbyTownsHtml(cachedTowns, p) : (p.nearest_town_name ? escapeHtml(p.nearest_town_name) + ' (' + p.nearest_town_miles + ' mi) — checking for more nearby…' : 'Checking nearby towns &amp; cities…'));
  const maxNightsText = [p.max_nights_stay ? p.max_nights_stay + ' nights per stay' : null, p.max_nights_year ? p.max_nights_year + ' nights per year' : null].filter(Boolean).join(' / ');

  // ---- Read-only view (default) — everything here is locked until "Edit" is clicked ----
  rows.push('<div id="detail-view">');
  rows.push('<div class="field-row"><label>Category</label><div class="field-static">' + escapeHtml(p.category + (p.subcategory ? ' · ' + p.subcategory : '')) + '</div></div>');
  rows.push('<div class="field-row"><label>State</label><div class="field-static">' + escapeHtml(p.state || '—') + '</div></div>');
  if (p.area) rows.push('<div class="field-row"><label>Area</label><div class="field-static">' + escapeHtml(p.area) + '</div></div>');
  rows.push('<div class="field-row"><label>Distance from Pleasanton</label><div class="field-static">' +
    (p.driving_miles_from_pleasanton != null
      ? Math.round(p.driving_miles_from_pleasanton) + ' mi' + (p.driving_minutes_from_pleasanton != null ? ' (~' + Math.round(p.driving_minutes_from_pleasanton / 6) / 10 + ' hr drive)' : '')
      : 'Not computed (likely over 400mi)') + '</div></div>');
  rows.push('<div class="field-row"><label>Best months</label><div id="best-months-box" class="field-static">' + bestMonthsDisplayHtml(p) + '</div></div>');
  if (p.category === 'Camping') rows.push('<div class="field-row"><label>Towns &amp; cities within 10mi</label><div id="nearby-towns-box" class="field-static">' + townsDisplay + '</div></div>');
  if (p.category === 'Camping' && p.park_type) rows.push('<div class="field-row"><label>Park type</label><div class="field-static">' + escapeHtml(p.park_type) + '</div></div>');
  if (p.category === 'Camping' && p.reservation_timing) rows.push('<div class="field-row"><label>Reservation timing</label><div class="field-static">' + escapeHtml(p.reservation_timing) + '</div></div>');
  if (p.category === 'Camping' && maxNightsText) rows.push('<div class="field-row"><label>Max nights</label><div class="field-static">' + escapeHtml(maxNightsText) + '</div></div>');
  const isHikePin = p.subcategory === 'Hikes';
  if (isHikePin && p.hike_rating != null) rows.push('<div class="field-row"><label>Rating</label><div class="field-static">★' + p.hike_rating + '</div></div>');
  if (isHikePin && p.hike_length_miles != null) rows.push('<div class="field-row"><label>Length</label><div class="field-static">' + p.hike_length_miles + ' mi</div></div>');
  if (isHikePin && p.hike_difficulty) rows.push('<div class="field-row"><label>Difficulty</label><div class="field-static">' + escapeHtml(p.hike_difficulty) + '</div></div>');
  if (isHikePin && p.hike_route_type) rows.push('<div class="field-row"><label>Route type</label><div class="field-static">' + escapeHtml(p.hike_route_type) + '</div></div>');
  rows.push('<div class="field-row"><label>' + (p.is_campground ? 'Visited' : 'Done') + '</label><div class="field-static">' + ((p.is_campground ? p.visited : p.done) ? 'Yes' : 'No') + '</div></div>');
  if (p.category === 'Camping') {
    rows.push('<div class="field-row"><label>Price per night</label><div class="field-static">' + (p.price_usd != null ? '$' + p.price_usd : '—') + '</div></div>');
    rows.push('<div class="field-row"><label>Hookups</label><div class="field-static">' + (escapeHtml((p.hookup_types || []).join(', ')) || '—') + '</div></div>');
  }
  rows.push('<div class="field-row"><label>' + (isHikePin ? 'AllTrails link' : 'Website / booking URL') + '</label><div class="field-static">' +
    (p.url ? '<a href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener">' + (isHikePin ? 'View on AllTrails &rarr;' : escapeHtml(p.url)) + '</a>' : '—') + '</div></div>');
  rows.push('<div class="field-row"><label>Notes / best sites</label><div class="field-static" style="white-space:pre-wrap;">' + (p.notes ? escapeHtml(p.notes) : '—') + '</div></div>');
  rows.push('<button id="detail-edit-toggle-btn" class="primary-btn" type="button">&#9998; Edit</button>');
  rows.push('</div>');

  // ---- Edit form (hidden until "Edit" is clicked) ----
  // Pre-check using the current EFFECTIVE best months (area/climate-derived if no manual
  // override exists yet) so Laura starts from a sensible baseline and can tweak from there.
  const currentBestMonths = bestMonths;
  const monthChecks = MONTH_ABBR.map(m =>
    '<label class="checkbox-row" style="display:inline-flex;width:31%;box-sizing:border-box;"><input type="checkbox" id="edit-month-' + m.toLowerCase() + '" ' + (currentBestMonths.includes(m) ? 'checked' : '') + '> ' + m + '</label>'
  ).join('');

  rows.push('<div id="detail-edit-form" class="hidden">');
  rows.push('<div class="field-row"><label>Category</label><select id="edit-category">' +
    CATEGORY_ORDER.map(c => '<option value="' + escapeHtml(c) + '"' + (c === p.category ? ' selected' : '') + '>' + escapeHtml(c) + '</option>').join('') +
    '</select></div>');
  rows.push('<div class="field-row" id="edit-subcat-row"><label>Type</label><select id="edit-subcategory"></select></div>');
  rows.push('<div class="field-row"><label>State</label><input type="text" id="edit-state" value="' + escapeHtml(p.state || '') + '"></div>');
  rows.push('<div class="field-row"><label>Area</label><input type="text" id="edit-area" value="' + escapeHtml(p.area || '') + '" placeholder="e.g. Big Sur Coast"></div>');
  rows.push('<div class="field-row"><label>Distance from Pleasanton (driving miles)</label><input type="number" id="edit-distance-miles" min="0" value="' + (p.driving_miles_from_pleasanton != null ? p.driving_miles_from_pleasanton : '') + '"></div>');
  rows.push('<div class="field-row"><label>Best months</label><div style="display:flex;flex-wrap:wrap;gap:4px 2%;">' + monthChecks + '</div>' +
    '<small class="hint">Pre-filled from the area\'s climate data (or a live weather check) where available &mdash; check/uncheck any month to override.</small></div>');
  rows.push('<div class="toggle-row"><span>' + (p.is_campground ? 'Visited' : 'Done') + '</span>' +
    '<input type="checkbox" id="detail-status-toggle" ' + ((p.is_campground ? p.visited : p.done) ? 'checked' : '') + '></div>');
  rows.push('<div id="detail-camping-fields">');
  rows.push('<div class="field-row"><label>Towns &amp; cities within 10mi</label><input type="text" id="edit-towns-override" value="' + escapeHtml(townsOverride) + '" placeholder="Leave blank to auto-detect, or type your own list"></div>');
  rows.push('<div class="field-row"><label>Park type</label><input type="text" id="edit-park-type" value="' + escapeHtml(p.park_type || '') + '"></div>');
  rows.push('<div class="field-row"><label>Reservation timing</label><input type="text" id="edit-reservation-timing" value="' + escapeHtml(p.reservation_timing || '') + '" placeholder="e.g. 6 months in advance, first-come first-served"></div>');
  rows.push('<div class="field-row"><label>Max nights</label><div class="price-row">' +
    '<input type="number" id="edit-max-nights-stay" min="0" placeholder="per stay" value="' + (p.max_nights_stay != null ? p.max_nights_stay : '') + '">' +
    '<input type="number" id="edit-max-nights-year" min="0" placeholder="per year" value="' + (p.max_nights_year != null ? p.max_nights_year : '') + '">' +
    '</div></div>');
  rows.push('<div class="field-row"><label>Price per night ($)</label><input type="number" id="detail-price" min="0" value="' + (p.price_usd != null ? p.price_usd : '') + '"></div>');
  rows.push('<div class="field-row"><label>Hookups</label><input type="text" id="detail-hookups" value="' + escapeHtml((p.hookup_types || []).join(', ')) + '" placeholder="e.g. FHU, W&E, Dry"></div>');
  rows.push('<div id="detail-tag-checks">' +
    '<label class="checkbox-row"><input type="checkbox" id="detail-starlink" ' + (p.starlink_friendly ? 'checked' : '') + '> Starlink Friendly</label>' +
    '<label class="checkbox-row"><input type="checkbox" id="detail-hatch" ' + (p.good_for_hatch ? 'checked' : '') + '> Good for Hatch</label>' +
    '<label class="checkbox-row"><input type="checkbox" id="detail-bookable" ' + (p.bookable ? 'checked' : '') + '> Bookable</label>' +
    '</div>');
  rows.push('</div>');
  rows.push('<div id="detail-hike-fields">' +
    '<div class="price-row">' +
      '<input type="number" id="edit-hike-rating" placeholder="Rating (0-5)" min="0" max="5" step="0.1" value="' + (p.hike_rating != null ? p.hike_rating : '') + '">' +
      '<input type="number" id="edit-hike-length" placeholder="Length (mi)" min="0" step="0.1" value="' + (p.hike_length_miles != null ? p.hike_length_miles : '') + '">' +
    '</div>' +
    '<div class="price-row">' +
      '<select id="edit-hike-difficulty"><option value="">Difficulty...</option>' +
        ['Easy', 'Moderate', 'Hard'].map(d => '<option value="' + d + '"' + (p.hike_difficulty === d ? ' selected' : '') + '>' + d + '</option>').join('') +
      '</select>' +
      '<input type="text" id="edit-hike-route-type" placeholder="Route type (e.g. Loop)" value="' + escapeHtml(p.hike_route_type || '') + '">' +
    '</div>' +
  '</div>');
  rows.push('<div class="field-row"><label id="detail-url-label">' + (isHikePin ? 'AllTrails (or other) link' : 'Website / booking URL') + '</label><input type="text" id="detail-url" value="' + escapeHtml(p.url || '') + '"></div>');
  rows.push('<div class="field-row"><label>Notes / best sites</label><textarea id="detail-notes">' + escapeHtml(p.notes || '') + '</textarea></div>');
  rows.push('<button id="detail-save-btn" class="primary-btn" type="button">Save changes</button>');
  rows.push('<button id="detail-cancel-btn" class="secondary-btn" type="button">Cancel</button>');
  rows.push('</div>');

  // ---- Always available, regardless of edit mode: hikes (has its own add/remove controls) ----
  {
    const hikes = (p.nearby_alltrails_hikes || []).slice().sort((a, b) => (b.rating || 0) - (a.rating || 0));
    const hikeRows = hikes.map((h, i) =>
        '<div class="list-card" style="cursor:default;">' +
          '<div class="list-card-main">' +
            '<div class="list-card-name">' + escapeHtml(h.name) + '</div>' +
            '<div class="list-card-meta">' + (h.rating != null ? '★' + h.rating + ' · ' : '') + (h.length_miles != null ? h.length_miles + ' mi · ' : '') +
              (h.difficulty ? escapeHtml(h.difficulty) + ' · ' : '') + (h.route_type ? escapeHtml(h.route_type) + ' · ' : '') +
              (h.trailhead_distance_miles != null ? h.trailhead_distance_miles + ' mi from campground' : '') + '</div>' +
            (h.url ? '<a href="' + escapeHtml(h.url) + '" target="_blank" rel="noopener">View on AllTrails &rarr;</a>' : '') +
          '</div>' +
          '<div class="hike-row-actions">' +
            '<div class="hike-add-menu-wrap">' +
              '<button class="hike-add-menu-btn" data-hike-index="' + i + '" title="Add to a trip, or as a map pin" type="button">+</button>' +
              '<div class="hike-add-menu hidden" data-hike-index="' + i + '">' +
                '<button class="hike-add-to-trip-btn" data-hike-index="' + i + '" type="button">Add to trip</button>' +
                '<button class="hike-add-pin-btn" data-hike-index="' + i + '" type="button">Add pin</button>' +
              '</div>' +
            '</div>' +
            '<button class="hike-remove-btn" data-hike-index="' + i + '" title="Remove this hike" style="background:none;border:none;color:#b5493b;font-size:18px;cursor:pointer;">&times;</button>' +
          '</div>' +
        '</div>'
      ).join('');
    rows.push('<div class="field-row"><label>Nearby hikes</label>' +
      (hikeRows || '<div class="field-static" style="margin-bottom:6px;">None added yet.</div>') +
      '<button id="hike-add-toggle-btn" class="secondary-btn" type="button">+ Add a hike</button>' +
      '<div id="hike-add-form" class="hidden" style="margin-top:8px;">' +
        '<div class="field-row"><label>Trail name</label><input type="text" id="hike-name" placeholder="e.g. Bridalveil Fall Trail"></div>' +
        '<div class="price-row">' +
          '<input type="number" id="hike-rating" placeholder="Rating (0-5)" min="0" max="5" step="0.1">' +
          '<input type="number" id="hike-length" placeholder="Length (mi)" min="0" step="0.1">' +
        '</div>' +
        '<div class="price-row">' +
          '<select id="hike-difficulty"><option value="">Difficulty...</option><option value="Easy">Easy</option><option value="Moderate">Moderate</option><option value="Hard">Hard</option></select>' +
          '<input type="text" id="hike-route-type" placeholder="Route type (e.g. Loop)">' +
        '</div>' +
        '<div class="field-row"><label>Distance from this pin (mi)</label><input type="number" id="hike-trailhead-distance" min="0" step="0.1"></div>' +
        '<div class="field-row"><label>AllTrails (or other) link</label><input type="text" id="hike-url" placeholder="https://..."></div>' +
        '<button id="hike-save-btn" class="secondary-btn" type="button">Save hike</button>' +
      '</div>' +
    '</div>');
  }

  rows.push('<button id="detail-nearby-btn" class="secondary-btn">Find campgrounds/sites near this pin</button>');
  rows.push('<button id="detail-addtrip-btn" class="secondary-btn">Add to a trip</button>');
  if (p.is_custom) {
    rows.push('<button id="detail-edit-pin-btn" class="secondary-btn">Edit name / category / location</button>');
    rows.push('<button id="detail-delete-pin-btn" class="secondary-btn" style="color:#b5493b;">Delete this pin</button>');
  }

  return rows.join('');
}

function wireDetailEvents(p) {
  // Read-only view <-> edit form toggle. Everything data-related lives behind this —
  // hikes (own add/remove controls) and the action buttons below are always available.
  const editToggleBtn = document.getElementById('detail-edit-toggle-btn');
  if (editToggleBtn) {
    editToggleBtn.onclick = () => {
      document.getElementById('detail-view').classList.add('hidden');
      document.getElementById('detail-edit-form').classList.remove('hidden');
    };
  }
  const cancelBtn = document.getElementById('detail-cancel-btn');
  if (cancelBtn) {
    cancelBtn.onclick = () => { openDetail(p.id); };
  }
  populateSubcatOptions(p.category, 'edit-subcat-row', 'edit-subcategory', false);
  const editSubcatSel = document.getElementById('edit-subcategory');
  if (editSubcatSel && p.subcategory) editSubcatSel.value = p.subcategory;
  const campingFieldsEl = document.getElementById('detail-camping-fields');
  const updateCampingFieldsVisibility = cat => { if (campingFieldsEl) campingFieldsEl.classList.toggle('hidden', cat !== 'Camping'); };
  updateCampingFieldsVisibility(p.category);
  const hikeFieldsEl = document.getElementById('detail-hike-fields');
  const urlLabelEl = document.getElementById('detail-url-label');
  const isHikeCombo = (cat, subcat) => cat === 'Things To Do' && subcat === 'Hikes';
  const updateHikeFieldsVisibility = (cat, subcat) => {
    const isHike = isHikeCombo(cat, subcat);
    if (hikeFieldsEl) hikeFieldsEl.classList.toggle('hidden', !isHike);
    if (urlLabelEl) urlLabelEl.textContent = isHike ? 'AllTrails (or other) link' : 'Website / booking URL';
  };
  updateHikeFieldsVisibility(p.category, p.subcategory);
  const editCategorySel = document.getElementById('edit-category');
  if (editCategorySel) {
    editCategorySel.addEventListener('change', e => {
      populateSubcatOptions(e.target.value, 'edit-subcat-row', 'edit-subcategory', false);
      updateCampingFieldsVisibility(e.target.value);
      updateHikeFieldsVisibility(e.target.value, document.getElementById('edit-subcategory') ? document.getElementById('edit-subcategory').value : null);
    });
  }
  if (editSubcatSel) {
    editSubcatSel.addEventListener('change', e => {
      updateHikeFieldsVisibility(document.getElementById('edit-category').value, e.target.value);
    });
  }

  document.getElementById('detail-save-btn').onclick = async () => {
    const fields = {};
    const newCategory = document.getElementById('edit-category').value;
    fields.category = newCategory;
    fields.is_campground = (newCategory === 'Camping');
    const subcatSel = document.getElementById('edit-subcategory');
    fields.subcategory = (subcatSel && subcatSel.value) ? subcatSel.value : null;
    fields.state = document.getElementById('edit-state').value.trim() || null;
    fields.area = document.getElementById('edit-area').value.trim() || null;
    const distVal = document.getElementById('edit-distance-miles').value;
    fields.driving_miles_from_pleasanton = distVal === '' ? null : parseFloat(distVal);
    fields.driving_minutes_from_pleasanton = null; // unknown after a manual mileage edit
    const months = [];
    MONTH_ABBR.forEach(m => {
      const cb = document.getElementById('edit-month-' + m.toLowerCase());
      if (cb && cb.checked) months.push(m);
    });
    fields.best_months = months.length ? months : null;
    fields.best_seasons = null; // clear out any legacy season-level override
    if (newCategory === 'Camping') {
      const townsOverrideInput = document.getElementById('edit-towns-override');
      if (townsOverrideInput) fields.nearby_towns_override = townsOverrideInput.value.trim() || null;
      fields.park_type = document.getElementById('edit-park-type').value.trim() || null;
      fields.reservation_timing = document.getElementById('edit-reservation-timing').value.trim() || null;
      const maxStayVal = document.getElementById('edit-max-nights-stay').value;
      fields.max_nights_stay = maxStayVal === '' ? null : parseFloat(maxStayVal);
      const maxYearVal = document.getElementById('edit-max-nights-year').value;
      fields.max_nights_year = maxYearVal === '' ? null : parseFloat(maxYearVal);
      const priceVal = document.getElementById('detail-price').value;
      fields.price_usd = priceVal === '' ? null : parseFloat(priceVal);
      const hookupsRaw = document.getElementById('detail-hookups').value;
      fields.hookup_types = hookupsRaw.split(',').map(s => s.trim()).filter(Boolean);
      fields.starlink_friendly = document.getElementById('detail-starlink').checked;
      fields.good_for_hatch = document.getElementById('detail-hatch').checked;
      fields.bookable = document.getElementById('detail-bookable').checked;
    } else {
      fields.nearby_towns_override = null;
      fields.park_type = null;
      fields.reservation_timing = null;
      fields.max_nights_stay = null;
      fields.max_nights_year = null;
      fields.price_usd = null;
      fields.hookup_types = [];
      fields.starlink_friendly = null;
      fields.good_for_hatch = null;
      fields.bookable = null;
    }
    if (isHikeCombo(newCategory, fields.subcategory)) {
      const hrVal = document.getElementById('edit-hike-rating').value;
      fields.hike_rating = hrVal === '' ? null : parseFloat(hrVal);
      const hlVal = document.getElementById('edit-hike-length').value;
      fields.hike_length_miles = hlVal === '' ? null : parseFloat(hlVal);
      fields.hike_difficulty = document.getElementById('edit-hike-difficulty').value || null;
      fields.hike_route_type = document.getElementById('edit-hike-route-type').value.trim() || null;
    } else {
      fields.hike_rating = null;
      fields.hike_length_miles = null;
      fields.hike_difficulty = null;
      fields.hike_route_type = null;
    }
    const urlVal = document.getElementById('detail-url').value.trim();
    fields.url = urlVal || null;
    fields.notes = document.getElementById('detail-notes').value;
    const statusChecked = document.getElementById('detail-status-toggle').checked;
    if (fields.is_campground) fields.visited = statusChecked; else fields.done = statusChecked;
    updatePinEdit(p.id, fields);
    await pushCloudStateNow();
    location.reload();
  };
  document.getElementById('detail-nearby-btn').onclick = () => {
    closeDetail();
    openDistanceTool({ id: 'custom_' + p.id, label: p.name, lat: p.lat, lng: p.lng, excludeId: p.id });
  };
  document.getElementById('detail-addtrip-btn').onclick = () => {
    closeDetail();
    openTripsTool(p.id);
  };

  const hikeToggleBtn = document.getElementById('hike-add-toggle-btn');
  if (hikeToggleBtn) {
    hikeToggleBtn.onclick = () => {
      document.getElementById('hike-add-form').classList.toggle('hidden');
    };
  }
  const hikeSaveBtn = document.getElementById('hike-save-btn');
  if (hikeSaveBtn) {
    hikeSaveBtn.onclick = () => {
      const name = document.getElementById('hike-name').value.trim();
      if (!name) { alert('Please enter a trail name.'); return; }
      const ratingVal = document.getElementById('hike-rating').value;
      const lengthVal = document.getElementById('hike-length').value;
      const distVal = document.getElementById('hike-trailhead-distance').value;
      const hike = {
        name: name,
        rating: ratingVal === '' ? null : parseFloat(ratingVal),
        length_miles: lengthVal === '' ? null : parseFloat(lengthVal),
        difficulty: document.getElementById('hike-difficulty').value || null,
        route_type: document.getElementById('hike-route-type').value.trim() || null,
        trailhead_distance_miles: distVal === '' ? null : parseFloat(distVal),
        url: document.getElementById('hike-url').value.trim() || null,
        manually_added: true
      };
      const currentHikes = (p.nearby_alltrails_hikes || []).slice();
      currentHikes.push(hike);
      updatePinEdit(p.id, { nearby_alltrails_hikes: currentHikes });
      openDetail(p.id);
    };
  }
  document.querySelectorAll('.hike-remove-btn').forEach(btn => {
    btn.onclick = () => {
      const displayedHikes = (p.nearby_alltrails_hikes || []).slice().sort((a, b) => (b.rating || 0) - (a.rating || 0));
      const toRemove = displayedHikes[parseInt(btn.getAttribute('data-hike-index'), 10)];
      if (!confirm('Remove "' + toRemove.name + '" from this pin\'s hikes?')) return;
      const currentHikes = (p.nearby_alltrails_hikes || []).filter(h => h !== toRemove);
      updatePinEdit(p.id, { nearby_alltrails_hikes: currentHikes });
      openDetail(p.id);
    };
  });

  // "+" next to each hike opens a tiny menu: "Add to trip" (a lightweight, hidden pin at
  // the campground's own location — quick, no map placement needed) or "Add pin" (a real,
  // visible map pin she places herself, prefilled with this hike's stats).
  const displayedHikesForMenu = (p.nearby_alltrails_hikes || []).slice().sort((a, b) => (b.rating || 0) - (a.rating || 0));
  document.querySelectorAll('.hike-add-menu-btn').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const menu = btn.parentElement.querySelector('.hike-add-menu');
      document.querySelectorAll('.hike-add-menu').forEach(m => { if (m !== menu) m.classList.add('hidden'); });
      menu.classList.toggle('hidden');
    };
  });
  document.querySelectorAll('.hike-add-to-trip-btn').forEach(btn => {
    btn.onclick = () => {
      const hike = displayedHikesForMenu[parseInt(btn.getAttribute('data-hike-index'), 10)];
      if (!hike) return;
      const hikePin = findOrCreateHikePin(p, hike);
      closeDetail();
      openTripsTool(hikePin.id);
    };
  });
  document.querySelectorAll('.hike-add-pin-btn').forEach(btn => {
    btn.onclick = () => {
      const hike = displayedHikesForMenu[parseInt(btn.getAttribute('data-hike-index'), 10)];
      if (!hike) return;
      closeDetail();
      openAddFormFromHike(hike, p);
    };
  });

  const editBtn = document.getElementById('detail-edit-pin-btn');
  if (editBtn) editBtn.onclick = () => { closeDetail(); openAddForm(p); };
  const delBtn = document.getElementById('detail-delete-pin-btn');
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm('Delete "' + p.name + '"? This can\'t be undone (unless you have an exported backup).')) return;
    CUSTOM_PINS = CUSTOM_PINS.filter(cp => cp.id !== p.id);
    saveCustomPins(CUSTOM_PINS);
    await pushCloudStateNow();
    location.reload();
  };
}

function openDetail(id) {
  const pin = getPin(id);
  if (!pin) return;
  const p = effectivePin(pin);
  document.getElementById('detail-content').innerHTML = buildDetailHtml(p);
  document.getElementById('detail-overlay').classList.remove('hidden');
  wireDetailEvents(p);

  if (p.category === 'Camping' && p.lat != null && p.lng != null && !p.nearby_towns_override) {
    fetchNearbyTowns(p.id, p.lat, p.lng).then(towns => {
      const box = document.getElementById('nearby-towns-box');
      if (box) box.innerHTML = nearbyTownsHtml(towns, p);
    }).catch(() => {
      const box = document.getElementById('nearby-towns-box');
      if (box && !NEARBY_TOWNS_CACHE[p.id]) {
        box.innerHTML = (p.nearest_town_name ? escapeHtml(p.nearest_town_name) + ' (' + p.nearest_town_miles + ' mi)' : 'Unavailable right now') + ' <span class="hint" style="display:inline;">— couldn\'t reach the map service for a fuller list (offline?)</span>';
      }
    });
  }

  if (bestMonthsState(p).pending && p.lat != null && p.lng != null) {
    fetchClimateBestMonths(p.id, p.lat, p.lng).then(() => {
      const box = document.getElementById('best-months-box');
      if (box) box.innerHTML = bestMonthsDisplayHtml(p);
    }).catch(() => {
      const box = document.getElementById('best-months-box');
      if (box) box.innerHTML = 'Couldn&rsquo;t check climate for this location right now (offline?). Click Edit to set months manually.';
    });
  }
}

function closeDetail() {
  document.getElementById('detail-overlay').classList.add('hidden');
}

// ---------- Distance tool ----------
let customOrigins = {};
let distanceSelectedSubcats = new Set();
let distanceViewMode = 'list';
let distanceMap = null;
let distanceMarkersLayer = null;
let lastDistanceResults = null; // [{pin, miles, estimated}], set after a search runs
let lastDistanceOrigin = null;

function openDistanceTool(custom) {
  const sel = document.getElementById('distance-origin');
  if (custom) {
    Array.from(sel.querySelectorAll('option[data-custom]')).forEach(o => o.remove());
    const opt = document.createElement('option');
    opt.value = custom.id;
    opt.textContent = custom.label + ' (this pin)';
    opt.setAttribute('data-custom', '1');
    sel.appendChild(opt);
    sel.value = custom.id;
    customOrigins[custom.id] = custom;
  } else if (!custom && sel.value === '') {
    sel.value = 'pleasanton';
  }
  document.getElementById('distance-results').innerHTML = '';
  document.getElementById('distance-status').textContent = '';
  lastDistanceResults = null;
  lastDistanceOrigin = null;
  populateDistanceSubcatChecks(document.getElementById('distance-category').value);
  setDistanceViewMode('list');
  document.getElementById('distance-overlay').classList.remove('hidden');
}

function closeDistanceTool() {
  document.getElementById('distance-overlay').classList.add('hidden');
}

function setDistanceViewMode(mode) {
  distanceViewMode = mode;
  document.getElementById('distance-view-list').classList.toggle('active', mode === 'list');
  document.getElementById('distance-view-map').classList.toggle('active', mode === 'map');
  document.getElementById('distance-results').classList.toggle('hidden', mode !== 'list');
  document.getElementById('distance-map').classList.toggle('hidden', mode !== 'map');
  if (mode === 'map' && lastDistanceResults) {
    setTimeout(() => renderDistanceMap(lastDistanceResults, lastDistanceOrigin), 50);
  }
}

function initOrResetDistanceMap(centerLat, centerLng, zoom) {
  if (!distanceMap) {
    distanceMap = L.map('distance-map').setView([centerLat, centerLng], zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(distanceMap);
    distanceMarkersLayer = L.layerGroup().addTo(distanceMap);
  } else {
    distanceMap.invalidateSize();
  }
}

function renderDistanceMap(within, origin) {
  initOrResetDistanceMap(origin.lat, origin.lng, 8);
  distanceMarkersLayer.clearLayers();
  L.marker([origin.lat, origin.lng]).addTo(distanceMarkersLayer).bindPopup('<b>Starting point</b>');
  const bounds = [[origin.lat, origin.lng]];
  within.forEach(c => {
    const p = effectivePin(c.pin);
    if (p.lat == null || p.lng == null) return;
    const marker = L.marker([p.lat, p.lng], { icon: getMarkerIcon(p) });
    marker.bindPopup('<b>' + escapeHtml(p.name) + '</b><br>' + Math.round(c.miles * 10) / 10 + ' mi' + (c.estimated ? ' (est.)' : ''));
    marker.on('click', () => { closeDistanceTool(); openDetail(p.id); });
    distanceMarkersLayer.addLayer(marker);
    bounds.push([p.lat, p.lng]);
  });
  if (bounds.length > 1) distanceMap.fitBounds(bounds, { padding: [24, 24] });
  else distanceMap.setView([origin.lat, origin.lng], 8);
}

async function runDistanceSearch() {
  const originVal = document.getElementById('distance-origin').value;
  const minMi = parseFloat(document.getElementById('distance-min').value) || 0;
  const maxRaw = document.getElementById('distance-max').value;
  const maxMi = maxRaw === '' ? Infinity : (parseFloat(maxRaw) || 50);
  const categoryVal = document.getElementById('distance-category').value;
  const monthVal = document.getElementById('distance-month').value;
  const useDriving = document.getElementById('distance-use-driving').checked;
  const statusEl = document.getElementById('distance-status');
  const resultsEl = document.getElementById('distance-results');
  resultsEl.innerHTML = '';

  let origin;
  if (originVal === 'pleasanton') origin = { lat: PLEASANTON.lat, lng: PLEASANTON.lng, isPleasanton: true };
  else origin = customOrigins[originVal];
  if (!origin) { statusEl.textContent = 'Pick a starting point.'; return; }

  statusEl.textContent = 'Calculating distances...';

  let basePins = allPins().filter(p => !(origin.excludeId && p.id === origin.excludeId));
  if (categoryVal) basePins = basePins.filter(p => effectivePin(p).category === categoryVal);
  if (distanceSelectedSubcats.size) basePins = basePins.filter(p => distanceSelectedSubcats.has(effectivePin(p).subcategory));
  if (monthVal) basePins = basePins.filter(p => { const bm = getBestMonths(effectivePin(p)); return bm && bm.includes(monthVal); });

  const prefilterCap = maxMi === Infinity ? 1000 : maxMi * 2;
  let candidates = basePins
    .map(p => ({ pin: p, straight: haversineMiles(origin.lat, origin.lng, p.lat, p.lng) }))
    .filter(c => c.straight <= prefilterCap)
    .sort((a, b) => a.straight - b.straight)
    .slice(0, 300);

  let usedDriving = false;

  if (useDriving) {
    if (origin.isPleasanton) {
      candidates = candidates.map(c => ({
        pin: c.pin,
        miles: c.pin.driving_miles_from_pleasanton != null ? c.pin.driving_miles_from_pleasanton : c.straight,
        estimated: c.pin.driving_miles_from_pleasanton == null
      }));
      usedDriving = true;
    } else if (candidates.length) {
      try {
        const coordsStr = [origin.lng + ',' + origin.lat]
          .concat(candidates.map(c => c.pin.lng + ',' + c.pin.lat))
          .join(';');
        const url = 'https://router.project-osrm.org/table/v1/driving/' + coordsStr + '?sources=0&annotations=distance';
        const resp = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
        if (!resp.ok) throw new Error('OSRM error ' + resp.status);
        const data = await resp.json();
        const distances = (data.distances && data.distances[0]) || [];
        candidates = candidates.map((c, i) => {
          const meters = distances[i + 1];
          return {
            pin: c.pin,
            miles: meters != null ? meters / 1609.34 : c.straight,
            estimated: meters == null
          };
        });
        usedDriving = true;
      } catch (err) {
        candidates = candidates.map(c => ({ pin: c.pin, miles: c.straight, estimated: true }));
        usedDriving = false;
      }
    }
  } else {
    candidates = candidates.map(c => ({ pin: c.pin, miles: c.straight, estimated: false }));
  }

  const within = candidates.filter(c => c.miles >= minMi && c.miles <= maxMi).sort((a, b) => a.miles - b.miles);

  lastDistanceResults = within;
  lastDistanceOrigin = origin;

  const rangeLabel = minMi > 0 ? (minMi + '–' + (maxMi === Infinity ? 'any' : maxMi) + ' mi') : ((maxMi === Infinity ? 'any distance' : 'within ' + maxMi + ' mi'));
  statusEl.textContent = within.length + ' found, ' + rangeLabel +
    (useDriving ? (usedDriving ? ' (driving distance)' : ' (straight-line — driving lookup unavailable, e.g. offline)') : ' (straight-line)');

  within.forEach(c => {
    const p = effectivePin(c.pin);
    const card = document.createElement('div');
    card.className = 'list-card';
    card.innerHTML =
      '<div class="list-card-main">' +
        '<div class="list-card-name">' + escapeHtml(p.name) + '</div>' +
        '<div class="list-card-meta">' + Math.round(c.miles * 10) / 10 + ' mi' + (c.estimated ? ' (est.)' : '') +
          ' · ' + escapeHtml(p.category + (p.subcategory ? ' · ' + p.subcategory : '')) + ' · ' + escapeHtml(p.state || '') +
        '</div>' +
      '</div>';
    card.addEventListener('click', () => { closeDistanceTool(); openDetail(p.id); });
    resultsEl.appendChild(card);
  });

  if (distanceViewMode === 'map') renderDistanceMap(within, origin);
}

// ---------- Trip planner ----------
const TRIPS_KEY = 'campapp_trips_v1';
function loadTrips() {
  try { return JSON.parse(localStorage.getItem(TRIPS_KEY) || '[]'); }
  catch (e) { return []; }
}
function saveTrips(trips) {
  try { localStorage.setItem(TRIPS_KEY, JSON.stringify(trips)); } catch (e) { /* ignore */ }
  scheduleCloudPush();
}
let TRIPS = loadTrips();

// One-time migration: older trips stored every stop (campgrounds AND sites/activities) in one
// combined ordered `stops` list. Sites now live in their own `sites` list, each tied to a
// specific campground stop or to the "drive day" between two consecutive campground stops —
// this splits any trip saved before that change, moving non-Camping stops into `sites`
// (unassigned) and giving every stop a stable id so associations survive reordering.
function migrateTripsIfNeeded() {
  let changed = false;
  TRIPS.forEach(trip => {
    (trip.options || []).forEach(option => {
      option.stops.forEach(s => { if (!s.id) { s.id = genId('stop'); changed = true; } });
      if (!option.sites) {
        const sites = [];
        const keptStops = [];
        option.stops.forEach(s => {
          const pin = getPin(s.pinId);
          const isCamp = pin && effectivePin(pin).category === 'Camping';
          if (isCamp || !pin) keptStops.push(s);
          else sites.push({ id: genId('site'), pinId: s.pinId, date: s.date, notes: s.notes || '', assoc: null });
        });
        option.stops = keptStops;
        option.sites = sites;
        changed = true;
      }
      // A campground stay is an arrival/departure range, not one date (so it can show
      // properly on the calendar view) — split any older single `date` field into
      // startDate/endDate (same day, if that's all we had).
      option.stops.forEach(s => {
        if (s.startDate === undefined) {
          s.startDate = s.date || null;
          s.endDate = s.date || null;
          delete s.date;
          changed = true;
        }
      });
    });
  });
  if (changed) saveTrips(TRIPS);
}
migrateTripsIfNeeded();

let activeTripId = null;
let activeOptionId = null;
let tripPickerPinId = null;
let tripViewMode = 'list';
let tripMap = null;
let tripMarkersLayer = null;
let tripLineLayer = null;
const legCache = {}; // "idA|idB" -> {miles, minutes, estimated}
// Which nested site groups ("camp:<stopId>" / "drive:<fromId>:<toId>") the user has
// collapsed in the trip view — persists across re-renders within the session so an
// unrelated edit (a date, a reorder) doesn't snap a collapsed group back open.
const collapsedTripGroups = new Set();

function genId(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

function openTripsTool(forPinId) {
  tripPickerPinId = forPinId || null;
  document.getElementById('trips-overlay').classList.remove('hidden');
  renderTripsListView();
}

function closeTripsTool() {
  document.getElementById('trips-overlay').classList.add('hidden');
  tripPickerPinId = null;
}

function renderTripsListView() {
  activeTripId = null;
  activeOptionId = null;
  document.getElementById('trip-detail-view').classList.add('hidden');
  document.getElementById('trips-list-view').classList.remove('hidden');
  const banner = document.getElementById('trip-picker-banner');
  if (tripPickerPinId) {
    const pin = getPin(tripPickerPinId);
    banner.classList.remove('hidden');
    banner.textContent = 'Choose a trip (and then an option) to add "' + (pin ? pin.name : 'this pin') + '" to.';
  } else {
    banner.classList.add('hidden');
    banner.textContent = '';
  }
  const list = document.getElementById('trips-list');
  list.innerHTML = '';
  if (!TRIPS.length) {
    list.innerHTML = '<div class="field-static" style="margin-bottom:8px;">No trips yet — create one below.</div>';
  }
  TRIPS.forEach(trip => {
    const stopCount = trip.options.reduce((sum, o) => sum + o.stops.length + (o.sites || []).length, 0);
    const card = document.createElement('div');
    card.className = 'list-card';
    card.innerHTML = '<div class="list-card-main"><div class="list-card-name">' + escapeHtml(trip.name) + '</div>' +
      '<div class="list-card-meta">' + trip.options.length + ' option' + (trip.options.length === 1 ? '' : 's') + ' · ' + stopCount + ' stop' + (stopCount === 1 ? '' : 's') + '</div></div>';
    card.addEventListener('click', () => openTripDetail(trip.id));
    list.appendChild(card);
  });
  document.getElementById('new-trip-name').value = '';
}

function createTrip() {
  const nameInput = document.getElementById('new-trip-name');
  const name = nameInput.value.trim();
  if (!name) { alert('Please enter a trip name.'); return; }
  const trip = { id: genId('trip'), name: name, options: [{ id: genId('opt'), name: 'Option 1', stops: [], sites: [] }] };
  TRIPS.push(trip);
  saveTrips(TRIPS);
  openTripDetail(trip.id);
}

function openTripDetail(tripId) {
  activeTripId = tripId;
  const trip = TRIPS.find(t => t.id === tripId);
  if (!trip) return;
  activeOptionId = trip.options[0].id;
  document.getElementById('trips-list-view').classList.add('hidden');
  document.getElementById('trip-detail-view').classList.remove('hidden');
  setTripViewMode('list');
  renderTripDetail();
}

function getActiveTrip() { return TRIPS.find(t => t.id === activeTripId); }
function getActiveOption() {
  const trip = getActiveTrip();
  if (!trip) return null;
  return trip.options.find(o => o.id === activeOptionId) || trip.options[0];
}

function renderTripDetail() {
  const trip = getActiveTrip();
  if (!trip) { renderTripsListView(); return; }
  if (!trip.options.find(o => o.id === activeOptionId)) activeOptionId = trip.options[0].id;
  const option = getActiveOption();

  document.getElementById('trip-name-input').value = trip.name;

  const tabsEl = document.getElementById('trip-options-tabs');
  tabsEl.innerHTML = '';
  trip.options.forEach(o => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = o.name;
    btn.className = o.id === activeOptionId ? 'active' : '';
    btn.addEventListener('click', () => { activeOptionId = o.id; renderTripDetail(); });
    tabsEl.appendChild(btn);
  });

  document.getElementById('trip-delete-option-btn').classList.toggle('hidden', trip.options.length <= 1);

  const pickerRow = document.getElementById('trip-picker-add-row');
  if (tripPickerPinId) {
    const pin = getPin(tripPickerPinId);
    pickerRow.classList.remove('hidden');
    pickerRow.innerHTML = '<button id="trip-add-picked-btn" class="primary-btn" type="button">+ Add "' + escapeHtml(pin ? pin.name : '') + '" to ' + escapeHtml(option.name) + '</button>';
    document.getElementById('trip-add-picked-btn').onclick = () => {
      addStopToOption(option, tripPickerPinId);
      tripPickerPinId = null;
      renderTripDetail();
    };
  } else {
    pickerRow.classList.add('hidden');
    pickerRow.innerHTML = '';
  }

  renderTripCampgrounds(option);
  renderTripSites(option);
  document.getElementById('trip-stop-search').value = '';
  document.getElementById('trip-stop-search-results').innerHTML = '';

  if (tripViewMode === 'map') renderTripMap(option);
  else if (tripViewMode === 'calendar') renderTripCalendar(option);
}

function addStopToOption(option, pinId, date) {
  const pin = getPin(pinId);
  const isCamp = pin && effectivePin(pin).category === 'Camping';
  if (!option.sites) option.sites = [];
  if (isCamp) {
    option.stops.push({ id: genId('stop'), pinId: pinId, startDate: date || null, endDate: date || null, notes: '' });
  } else {
    option.sites.push({ id: genId('site'), pinId: pinId, date: date || null, notes: '', assoc: null });
  }
  saveTrips(TRIPS);
}

// Builds the <option> list for a site's "tie this to..." dropdown: every campground
// stop in the trip, plus every consecutive-pair drive day, with the site's current
// association (if any) pre-selected.
function buildSiteAssocOptions(option, site) {
  const campOptions = option.stops.map(s => {
    const pin = getPin(s.pinId);
    const p = pin ? effectivePin(pin) : null;
    const range = s.startDate ? ' (' + s.startDate + (s.endDate && s.endDate !== s.startDate ? '–' + s.endDate : '') + ')' : '';
    return { stopId: s.id, label: (p ? p.name : '(removed pin)') + range };
  });
  const driveDayOptions = [];
  for (let i = 0; i < option.stops.length - 1; i++) {
    const a = option.stops[i], b = option.stops[i + 1];
    const pa = getPin(a.pinId), pb = getPin(b.pinId);
    driveDayOptions.push({
      fromStopId: a.id,
      toStopId: b.id,
      label: 'Drive day: ' + (pa ? effectivePin(pa).name : '(removed pin)') + ' → ' + (pb ? effectivePin(pb).name : '(removed pin)')
    });
  }
  return ['<option value="">Not yet assigned</option>']
    .concat(campOptions.map(o => '<option value="camp:' + o.stopId + '"' +
      (site.assoc && site.assoc.type === 'campground' && site.assoc.stopId === o.stopId ? ' selected' : '') +
      '>At: ' + escapeHtml(o.label) + '</option>'))
    .concat(driveDayOptions.map(o => '<option value="drive:' + o.fromStopId + ':' + o.toStopId + '"' +
      (site.assoc && site.assoc.type === 'driveday' && site.assoc.fromStopId === o.fromStopId && site.assoc.toStopId === o.toStopId ? ' selected' : '') +
      '>' + escapeHtml(o.label) + '</option>'))
    .join('');
}

// Builds one site/activity card — used both nested under its campground/drive day and
// in the "Unassigned" list. Changing its association moves it, so that always triggers
// a full re-render (renderTripDetail) rather than just updating this one card in place.
function renderTripSiteCard(option, site) {
  const pin = getPin(site.pinId);
  const p = pin ? effectivePin(pin) : null;
  const card = document.createElement('div');
  card.className = 'list-card';
  card.style.cursor = 'default';
  card.style.flexDirection = 'column';
  card.style.alignItems = 'stretch';

  const isHike = !!(p && p.subcategory === 'Hikes');
  const hikeMetaParts = [];
  if (isHike) {
    if (p.hike_rating != null) hikeMetaParts.push('★' + p.hike_rating);
    if (p.hike_length_miles != null) hikeMetaParts.push(p.hike_length_miles + ' mi');
    if (p.hike_difficulty) hikeMetaParts.push(escapeHtml(p.hike_difficulty));
    if (p.hike_route_type) hikeMetaParts.push(escapeHtml(p.hike_route_type));
  }

  card.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;">' +
      '<div class="list-card-main">' +
        '<div class="list-card-name">' + escapeHtml(p ? p.name : '(pin no longer available)') + '</div>' +
        '<div class="list-card-meta">' + (p ? escapeHtml(p.category + (p.subcategory ? ' · ' + p.subcategory : '')) : '') + '</div>' +
        (isHike && hikeMetaParts.length ? '<div class="list-card-meta">' + hikeMetaParts.join(' · ') + '</div>' : '') +
        (isHike && p.url ? '<a href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener">View on AllTrails &rarr;</a>' : '') +
      '</div>' +
      '<button data-act="remove" type="button" title="Remove" style="color:#b5493b;flex-shrink:0;background:none;border:none;font-size:18px;cursor:pointer;">&times;</button>' +
    '</div>' +
    '<div class="field-row" style="margin:6px 0 0;">' +
      '<select data-act="assoc">' + buildSiteAssocOptions(option, site) + '</select>' +
    '</div>' +
    '<div class="hint" data-act="distance" style="margin:2px 0 0;"></div>' +
    '<div class="price-row" style="margin-top:6px;">' +
      '<label style="align-self:center;font-size:12px;color:var(--brown);margin-right:4px;">Day:</label>' +
      '<input type="date" data-act="date" value="' + (site.date || '') + '">' +
    '</div>';

  card.querySelector('[data-act="remove"]').addEventListener('click', () => {
    option.sites = option.sites.filter(s => s !== site);
    saveTrips(TRIPS);
    renderTripDetail();
  });
  card.querySelector('[data-act="date"]').addEventListener('change', e => {
    site.date = e.target.value || null;
    saveTrips(TRIPS);
    if (tripViewMode === 'calendar') renderTripCalendar(option);
  });
  if (pin) {
    const mainEl = card.querySelector('.list-card-main');
    mainEl.style.cursor = 'pointer';
    mainEl.title = 'View pin details';
    mainEl.addEventListener('click', e => {
      if (e.target.tagName === 'A') return; // let the AllTrails link navigate on its own
      closeTripsTool();
      openDetail(pin.id);
    });
  }
  card.querySelector('[data-act="assoc"]').addEventListener('change', e => {
    const val = e.target.value;
    if (!val) {
      site.assoc = null;
    } else if (val.indexOf('camp:') === 0) {
      site.assoc = { type: 'campground', stopId: val.slice(5) };
    } else if (val.indexOf('drive:') === 0) {
      const parts = val.split(':');
      site.assoc = { type: 'driveday', fromStopId: parts[1], toStopId: parts[2] };
    }
    saveTrips(TRIPS);
    renderTripDetail();
  });

  updateSiteDistanceEl(card.querySelector('[data-act="distance"]'), site, option);
  return card;
}

// Sorts a list of trip sites/activities by date ascending, with undated ones pushed to
// the end (in whatever order they were already in) — used everywhere sites are listed
// (nested under a campground/drive day, unassigned, and the printable summary) so a
// dated activity always shows in its right place in the timeline.
function sortSitesByDate(list) {
  return list.slice().sort((a, b) => {
    if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    return 0;
  });
}

// Renders one collapsible group of nested sites (everything tied to one campground, or
// to one drive day) — a native <details> so the open/closed state needs no extra markup,
// remembered across re-renders via collapsedTripGroups so an unrelated edit doesn't
// snap it back open.
function renderTripSiteGroup(container, key, label, groupSites, option) {
  if (!groupSites.length) return;
  const details = document.createElement('details');
  details.className = 'trip-site-group';
  details.open = !collapsedTripGroups.has(key);
  details.addEventListener('toggle', () => {
    if (details.open) collapsedTripGroups.delete(key); else collapsedTripGroups.add(key);
  });
  const summary = document.createElement('summary');
  summary.textContent = label + ' (' + groupSites.length + ')';
  details.appendChild(summary);
  groupSites.forEach(site => details.appendChild(renderTripSiteCard(option, site)));
  container.appendChild(details);
}

// Nearby hikes live only as entries inside a campground pin's nearby_alltrails_hikes
// array (no coordinates or id of their own) — to quickly add one to a trip as an
// activity WITHOUT placing it as a real map pin, we mirror it into a small synthetic
// custom pin the first time it's added (reused after that, keyed off the campground +
// hike name), so it can ride along on every existing site mechanism: nested cards, map
// markers, click-through to a detail panel, distance calcs. It's flagged is_hike_ref so
// it stays out of the main map/list/search — the only way to reach one is "Add to trip"
// on the hike itself (in the campground pin's Nearby Hikes list) or a trip that already
// includes it. Hike stats live in the same hike_* fields a real hike pin uses (see
// saveAddForm/buildDetailHtml), so both kinds of hike pin render identically everywhere.
function findOrCreateHikePin(campPin, hike) {
  const slug = hike.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'hike';
  const hikeId = 'hikepin_' + campPin.id + '_' + slug;
  let existing = CUSTOM_PINS.find(cp => cp.id === hikeId);
  if (!existing) {
    existing = {
      id: hikeId,
      name: hike.name,
      category: 'Things To Do',
      subcategory: 'Hikes',
      lat: campPin.lat,
      lng: campPin.lng,
      state: campPin.state || null,
      area: campPin.area || null,
      driving_miles_from_pleasanton: campPin.driving_miles_from_pleasanton != null ? campPin.driving_miles_from_pleasanton : null,
      driving_minutes_from_pleasanton: campPin.driving_minutes_from_pleasanton != null ? campPin.driving_minutes_from_pleasanton : null,
      url: hike.url || null,
      hike_rating: hike.rating != null ? hike.rating : null,
      hike_length_miles: hike.length_miles != null ? hike.length_miles : null,
      hike_difficulty: hike.difficulty || null,
      hike_route_type: hike.route_type || null,
      notes: 'Nearby hike near ' + campPin.name + (hike.trailhead_distance_miles != null ? ' (' + hike.trailhead_distance_miles + ' mi from the campground)' : ''),
      is_custom: true,
      is_hike_ref: true,
      hike_source_pin_id: campPin.id
    };
    CUSTOM_PINS.push(existing);
    saveCustomPins(CUSTOM_PINS);
  }
  return existing;
}

// Campgrounds, each followed immediately by the sites/activities tied to it, then any
// sites tied to the drive day before the next campground — so the whole trip reads
// top-to-bottom in the order you'll actually experience it.
function renderTripCampgrounds(option) {
  const container = document.getElementById('trip-stops-list');
  container.innerHTML = '';
  if (!option.stops.length) {
    container.innerHTML = '<div class="field-static">No campgrounds yet — search below to add one.</div>';
    return;
  }
  const sites = option.sites || [];
  option.stops.forEach((stop, i) => {
    const pin = getPin(stop.pinId);
    const p = pin ? effectivePin(pin) : null;
    const card = document.createElement('div');
    card.className = 'list-card';
    card.style.cursor = 'default';
    card.style.flexDirection = 'column';
    card.style.alignItems = 'stretch';
    card.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;">' +
        '<div class="list-card-main">' +
          '<div class="list-card-name">' + (i + 1) + '. ' + escapeHtml(p ? p.name : '(pin no longer available)') + '</div>' +
          '<div class="list-card-meta">' + (p ? escapeHtml(p.category + (p.subcategory ? ' · ' + p.subcategory : '')) : '') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:4px;flex-shrink:0;">' +
          '<button data-act="up" type="button" ' + (i === 0 ? 'disabled' : '') + ' title="Move earlier">&uarr;</button>' +
          '<button data-act="down" type="button" ' + (i === option.stops.length - 1 ? 'disabled' : '') + ' title="Move later">&darr;</button>' +
          '<button data-act="remove" type="button" title="Remove" style="color:#b5493b;">&times;</button>' +
        '</div>' +
      '</div>' +
      '<div class="price-row" style="margin-top:6px;flex-wrap:wrap;">' +
        '<label style="align-self:center;font-size:12px;color:var(--brown);margin-right:4px;">Arrival:</label>' +
        '<input type="date" data-act="start-date" value="' + (stop.startDate || '') + '">' +
        '<label style="align-self:center;font-size:12px;color:var(--brown);margin:0 4px 0 8px;">Departure:</label>' +
        '<input type="date" data-act="end-date" value="' + (stop.endDate || '') + '">' +
      '</div>';
    card.querySelector('[data-act="up"]').addEventListener('click', () => moveStop(option, i, -1));
    card.querySelector('[data-act="down"]').addEventListener('click', () => moveStop(option, i, 1));
    card.querySelector('[data-act="remove"]').addEventListener('click', () => removeStop(option, i));
    card.querySelector('[data-act="start-date"]').addEventListener('change', e => {
      stop.startDate = e.target.value || null;
      if (stop.startDate && stop.endDate && stop.endDate < stop.startDate) stop.endDate = stop.startDate;
      saveTrips(TRIPS);
      if (tripViewMode === 'calendar') renderTripCalendar(option);
    });
    card.querySelector('[data-act="end-date"]').addEventListener('change', e => {
      stop.endDate = e.target.value || null;
      if (stop.endDate && stop.startDate && stop.endDate < stop.startDate) stop.startDate = stop.endDate;
      saveTrips(TRIPS);
      if (tripViewMode === 'calendar') renderTripCalendar(option);
    });
    if (pin) {
      const mainEl = card.querySelector('.list-card-main');
      mainEl.style.cursor = 'pointer';
      mainEl.title = 'View pin details';
      mainEl.addEventListener('click', () => { closeTripsTool(); openDetail(pin.id); });
    }
    container.appendChild(card);

    const hereSites = sortSitesByDate(sites.filter(s => s.assoc && s.assoc.type === 'campground' && s.assoc.stopId === stop.id));
    renderTripSiteGroup(container, 'camp:' + stop.id, 'Sites & activities here', hereSites, option);

    if (i < option.stops.length - 1) {
      const nextStop = option.stops[i + 1];
      const nextPin = getPin(nextStop.pinId);
      const legEl = document.createElement('div');
      legEl.className = 'hint';
      legEl.style.margin = '2px 0 2px 10px';
      container.appendChild(legEl);
      if (p && nextPin && p.lat != null && p.lng != null) {
        const nextP = effectivePin(nextPin);
        legEl.textContent = 'Calculating drive day...';
        computeLegDistance(p, nextP).then(leg => {
          legEl.textContent = '↓ Drive day: ' + Math.round(leg.miles) + ' mi' +
            (leg.minutes != null ? ' (~' + Math.round(leg.minutes / 6) / 10 + ' hr)' : '') +
            (leg.estimated ? ' — straight-line est.' : ' drive');
        });
      }

      const driveSites = sortSitesByDate(sites.filter(s => s.assoc && s.assoc.type === 'driveday' && s.assoc.fromStopId === stop.id && s.assoc.toStopId === nextStop.id));
      renderTripSiteGroup(container, 'drive:' + stop.id + ':' + nextStop.id, 'Along the drive day', driveSites, option);
    }
  });
}

function moveStop(option, index, dir) {
  const newIndex = index + dir;
  if (newIndex < 0 || newIndex >= option.stops.length) return;
  const tmp = option.stops[index];
  option.stops[index] = option.stops[newIndex];
  option.stops[newIndex] = tmp;
  saveTrips(TRIPS);
  renderTripDetail();
}

function removeStop(option, index) {
  const removed = option.stops[index];
  option.stops.splice(index, 1);
  (option.sites || []).forEach(site => {
    if (!site.assoc) return;
    if (site.assoc.type === 'campground' && site.assoc.stopId === removed.id) {
      site.assoc = null;
    } else if (site.assoc.type === 'driveday' && (site.assoc.fromStopId === removed.id || site.assoc.toStopId === removed.id)) {
      site.assoc = null;
    }
  });
  saveTrips(TRIPS);
  renderTripDetail();
}

// ---- Unassigned sites & activities: anything not yet tied to a campground or drive day
// (new additions start here) — everything already tied shows nested above instead.
function renderTripSites(option) {
  const container = document.getElementById('trip-sites-list');
  container.innerHTML = '';
  const sites = option.sites || [];
  const unassigned = sites.filter(s => !s.assoc);
  if (!sites.length) {
    container.innerHTML = '<div class="field-static">No sites or activities added yet — search below to add one.</div>';
    return;
  }
  if (!unassigned.length) {
    container.innerHTML = '<div class="field-static">Everything is assigned — see each one listed under its campground or drive day above.</div>';
    return;
  }
  sortSitesByDate(unassigned).forEach(site => container.appendChild(renderTripSiteCard(option, site)));
}

// ---- Printable trip summary: campground stays in trip order (with their dates),
// each followed by its tied activities sorted by date, drive-day-tied activities shown
// as their own "Drive day: A -> B" section in the right spot in the timeline (between
// the two campgrounds), and anything not yet assigned to either listed at the end so
// nothing gets silently left off the page.
function formatDateForPrint(d) {
  if (!d) return null;
  const parts = d.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatStopDateRangeForPrint(stop) {
  if (!stop.startDate && !stop.endDate) return 'Dates not set';
  if (!stop.endDate || stop.endDate === stop.startDate) return formatDateForPrint(stop.startDate);
  return formatDateForPrint(stop.startDate) + ' – ' + formatDateForPrint(stop.endDate);
}

function buildPrintBulletsHtml(sortedSites) {
  if (!sortedSites.length) return '<div class="print-empty">No activities scheduled.</div>';
  return '<ul>' + sortedSites.map(site => {
    const pin = getPin(site.pinId);
    const p = pin ? effectivePin(pin) : null;
    const name = p ? p.name : '(removed pin)';
    const dateLabel = site.date ? formatDateForPrint(site.date) : 'No date';
    return '<li>' + escapeHtml(dateLabel) + ' — ' + escapeHtml(name) + '</li>';
  }).join('') + '</ul>';
}

function buildTripPrintHtml(trip, option) {
  const sites = option.sites || [];
  const parts = [];
  parts.push('<h1>' + escapeHtml(trip.name) + '</h1>');
  parts.push('<div class="print-subtitle">' + escapeHtml(option.name) + '</div>');

  if (!option.stops.length) {
    parts.push('<div class="print-empty">No campgrounds added to this trip option yet.</div>');
  }

  option.stops.forEach((stop, i) => {
    const pin = getPin(stop.pinId);
    const p = pin ? effectivePin(pin) : null;
    const hereSites = sortSitesByDate(sites.filter(s => s.assoc && s.assoc.type === 'campground' && s.assoc.stopId === stop.id));
    parts.push('<div class="print-group">');
    parts.push('<h2>' + escapeHtml(p ? p.name : '(removed pin)') + ' — ' + escapeHtml(formatStopDateRangeForPrint(stop)) + '</h2>');
    parts.push(buildPrintBulletsHtml(hereSites));
    parts.push('</div>');

    if (i < option.stops.length - 1) {
      const nextStop = option.stops[i + 1];
      const nextPin = getPin(nextStop.pinId);
      const nextP = nextPin ? effectivePin(nextPin) : null;
      const driveSites = sortSitesByDate(sites.filter(s => s.assoc && s.assoc.type === 'driveday' && s.assoc.fromStopId === stop.id && s.assoc.toStopId === nextStop.id));
      if (driveSites.length) {
        parts.push('<div class="print-group print-driveday">');
        parts.push('<h2>Drive day: ' + escapeHtml(p ? p.name : '?') + ' &rarr; ' + escapeHtml(nextP ? nextP.name : '?') + '</h2>');
        parts.push(buildPrintBulletsHtml(driveSites));
        parts.push('</div>');
      }
    }
  });

  const unassigned = sortSitesByDate(sites.filter(s => !s.assoc));
  if (unassigned.length) {
    parts.push('<div class="print-group">');
    parts.push('<h2>Not Yet Assigned</h2>');
    parts.push(buildPrintBulletsHtml(unassigned));
    parts.push('</div>');
  }

  return parts.join('');
}

function openTripPrintSummary() {
  const trip = getActiveTrip();
  const option = getActiveOption();
  if (!trip || !option) return;
  document.getElementById('trip-print-view').innerHTML = buildTripPrintHtml(trip, option);
  window.print();
}

async function updateSiteDistanceEl(el, site, option) {
  const pin = getPin(site.pinId);
  if (!pin) { el.textContent = ''; return; }
  const p = effectivePin(pin);
  if (!site.assoc) {
    el.textContent = 'Not yet assigned to a campground or drive day — pick one above.';
    return;
  }
  if (p.lat == null || p.lng == null) { el.textContent = ''; return; }

  if (site.assoc.type === 'campground') {
    const stop = option.stops.find(s => s.id === site.assoc.stopId);
    const campPin = stop && getPin(stop.pinId);
    if (!campPin) { el.textContent = 'That campground is no longer in this trip — pick another.'; return; }
    const cp = effectivePin(campPin);
    if (cp.lat == null) { el.textContent = ''; return; }
    el.textContent = 'Calculating distance…';
    const leg = await computeLegDistance(p, cp);
    el.textContent = Math.round(leg.miles) + ' mi from ' + cp.name + (leg.estimated ? ' (straight-line est.)' : '');
  } else if (site.assoc.type === 'driveday') {
    const stopA = option.stops.find(s => s.id === site.assoc.fromStopId);
    const stopB = option.stops.find(s => s.id === site.assoc.toStopId);
    const campA = stopA && getPin(stopA.pinId);
    const campB = stopB && getPin(stopB.pinId);
    if (!campA || !campB) { el.textContent = 'That drive day is no longer in this trip — pick another.'; return; }
    const ca = effectivePin(campA), cb = effectivePin(campB);
    if (ca.lat == null || cb.lat == null) { el.textContent = ''; return; }
    el.textContent = 'Calculating distances…';
    const [legA, legB] = await Promise.all([computeLegDistance(p, ca), computeLegDistance(p, cb)]);
    el.textContent = Math.round(legA.miles) + ' mi from ' + ca.name + ' / ' + Math.round(legB.miles) + ' mi from ' + cb.name +
      (legA.estimated || legB.estimated ? ' (straight-line est.)' : '');
  }
}

// ---- Trip map view: whole trip (campgrounds + sites) on a Leaflet map with the same icons
// as the main map.
function setTripViewMode(mode) {
  tripViewMode = mode;
  document.getElementById('trip-view-list').classList.toggle('active', mode === 'list');
  document.getElementById('trip-view-map').classList.toggle('active', mode === 'map');
  document.getElementById('trip-view-calendar').classList.toggle('active', mode === 'calendar');
  document.getElementById('trip-list-mode').classList.toggle('hidden', mode !== 'list');
  document.getElementById('trip-map').classList.toggle('hidden', mode !== 'map');
  document.getElementById('trip-calendar').classList.toggle('hidden', mode !== 'calendar');
  if (mode === 'map') {
    const option = getActiveOption();
    if (option) setTimeout(() => renderTripMap(option), 50);
  } else if (mode === 'calendar') {
    const option = getActiveOption();
    if (option) renderTripCalendar(option);
  }
}

// ---- Trip calendar view: a month grid per month the trip spans, with each campground's
// arrival→departure stay shown on every day it covers, and each dated activity/hike
// shown as a chip on its one day — so "does this all fit together" is readable at a glance.
function getOptionDateRange(option) {
  const dates = [];
  (option.stops || []).forEach(s => { if (s.startDate) dates.push(s.startDate); if (s.endDate) dates.push(s.endDate); });
  (option.sites || []).forEach(s => { if (s.date) dates.push(s.date); });
  if (!dates.length) return null;
  dates.sort();
  return { min: dates[0], max: dates[dates.length - 1] };
}

function addDaysToDateStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function renderTripCalendar(option) {
  const container = document.getElementById('trip-calendar');
  container.innerHTML = '';
  const range = getOptionDateRange(option);
  if (!range) {
    container.innerHTML = '<div class="field-static">Add an arrival date to a campground (or a day to an activity/hike) to see this trip on a calendar.</div>';
    return;
  }

  const dayMap = {}; // 'YYYY-MM-DD' -> { stops: [...], sites: [...] }
  const ensureDay = d => { if (!dayMap[d]) dayMap[d] = { stops: [], sites: [] }; return dayMap[d]; };

  (option.stops || []).forEach(stop => {
    if (!stop.startDate) return;
    const pin = getPin(stop.pinId);
    const p = pin ? effectivePin(pin) : null;
    const name = p ? p.name : '(removed pin)';
    const start = stop.startDate;
    const end = stop.endDate && stop.endDate >= start ? stop.endDate : start;
    let cursor = start;
    let guard = 0;
    while (cursor <= end && guard < 90) { // safety cap: no single stay renders more than ~3 months
      ensureDay(cursor).stops.push({ name: name, isStart: cursor === start, isEnd: cursor === end, pinId: pin ? stop.pinId : null });
      if (cursor === end) break;
      cursor = addDaysToDateStr(cursor, 1);
      guard++;
    }
  });
  (option.sites || []).forEach(site => {
    if (!site.date) return;
    const pin = getPin(site.pinId);
    const p = pin ? effectivePin(pin) : null;
    ensureDay(site.date).sites.push({ name: p ? p.name : '(removed pin)', pinId: pin ? site.pinId : null });
  });

  let cursorMonth = range.min.slice(0, 7);
  const endMonth = range.max.slice(0, 7);
  let guard = 0;
  while (cursorMonth <= endMonth && guard < 24) { // safety cap: at most 2 years of months
    container.appendChild(buildTripCalendarMonth(cursorMonth, dayMap));
    const [y, m] = cursorMonth.split('-').map(Number);
    const next = new Date(y, m, 1); // m is 1-indexed, so this already rolls to next month
    cursorMonth = next.getFullYear() + '-' + String(next.getMonth() + 1).padStart(2, '0');
    guard++;
  }
}

function buildTripCalendarMonth(monthKeyStr, dayMap) {
  const [year, month] = monthKeyStr.split('-').map(Number); // month is 1-indexed
  const wrap = document.createElement('div');
  wrap.className = 'trip-calendar-month';
  const heading = document.createElement('h4');
  heading.textContent = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  wrap.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'trip-calendar-grid';
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => {
    const h = document.createElement('div');
    h.className = 'trip-calendar-dow';
    h.textContent = d;
    grid.appendChild(h);
  });

  const startWeekday = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let i = 0; i < startWeekday; i++) {
    const blank = document.createElement('div');
    blank.className = 'trip-calendar-day trip-calendar-day-blank';
    grid.appendChild(blank);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    const cell = document.createElement('div');
    cell.className = 'trip-calendar-day';
    const num = document.createElement('div');
    num.className = 'trip-calendar-daynum';
    num.textContent = day;
    cell.appendChild(num);
    const info = dayMap[dateStr];
    if (info) {
      info.stops.forEach(s => {
        const chip = document.createElement('div');
        chip.className = 'trip-calendar-chip trip-calendar-chip-stop';
        chip.textContent = (s.isStart ? '→ ' : '') + s.name + (s.isEnd && !s.isStart ? ' →' : '');
        chip.title = s.name;
        if (s.pinId) chip.addEventListener('click', () => { closeTripsTool(); openDetail(s.pinId); });
        cell.appendChild(chip);
      });
      info.sites.forEach(s => {
        const chip = document.createElement('div');
        chip.className = 'trip-calendar-chip trip-calendar-chip-site';
        chip.textContent = s.name;
        chip.title = s.name;
        if (s.pinId) chip.addEventListener('click', () => { closeTripsTool(); openDetail(s.pinId); });
        cell.appendChild(chip);
      });
    }
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);
  return wrap;
}

// ---- All-trips calendar (main page): every trip's first/primary option, overlaid on one
// calendar with a color per trip, so she can see at a glance whether trips overlap or how
// the year's travel lines up. Reuses the same month-grid renderer as the per-trip calendar.
const TRIP_COLOR_PALETTE = ['#2f5233', '#8b6f47', '#2a5d8c', '#b5493b', '#6b4c9a', '#1f7a6c', '#a3762a', '#4a4a4a'];

function openAllTripsCalendar() {
  document.getElementById('calendar-overlay').classList.remove('hidden');
  renderAllTripsCalendar();
}

function closeAllTripsCalendar() {
  document.getElementById('calendar-overlay').classList.add('hidden');
}

function jumpToTripFromCalendar(tripId) {
  closeAllTripsCalendar();
  document.getElementById('trips-overlay').classList.remove('hidden');
  openTripDetail(tripId);
}

function renderAllTripsCalendar() {
  const container = document.getElementById('all-trips-calendar');
  const legend = document.getElementById('calendar-legend');
  container.innerHTML = '';
  legend.innerHTML = '';
  if (!TRIPS.length) {
    container.innerHTML = '<div class="field-static">No trips yet — use the Trips button to create one.</div>';
    return;
  }

  const dayMap = {}; // 'YYYY-MM-DD' -> [{ tripId, tripName, color, kind, name, pinId, isStart, isEnd }]
  const ensureDay = d => { if (!dayMap[d]) dayMap[d] = []; return dayMap[d]; };
  let minDate = null, maxDate = null;
  const trackDate = d => { if (!minDate || d < minDate) minDate = d; if (!maxDate || d > maxDate) maxDate = d; };

  TRIPS.forEach((trip, idx) => {
    const options = trip.options || [];
    const color = TRIP_COLOR_PALETTE[idx % TRIP_COLOR_PALETTE.length];
    const multiOption = options.length > 1;
    let hasDates = false;

    options.forEach(option => {
      const tripLabel = multiOption ? trip.name + ' (' + option.name + ')' : trip.name;
      (option.stops || []).forEach(stop => {
        if (!stop.startDate) return;
        hasDates = true;
        const pin = getPin(stop.pinId);
        const p = pin ? effectivePin(pin) : null;
        const name = p ? p.name : '(removed pin)';
        const start = stop.startDate;
        const end = stop.endDate && stop.endDate >= start ? stop.endDate : start;
        let cursor = start, guard = 0;
        while (cursor <= end && guard < 90) { // safety cap: no single stay renders more than ~3 months
          ensureDay(cursor).push({ tripId: trip.id, tripName: tripLabel, color: color, kind: 'stop', name: name, pinId: pin ? stop.pinId : null, isStart: cursor === start, isEnd: cursor === end });
          trackDate(cursor);
          if (cursor === end) break;
          cursor = addDaysToDateStr(cursor, 1);
          guard++;
        }
      });
      (option.sites || []).forEach(site => {
        if (!site.date) return;
        hasDates = true;
        const pin = getPin(site.pinId);
        const p = pin ? effectivePin(pin) : null;
        ensureDay(site.date).push({ tripId: trip.id, tripName: tripLabel, color: color, kind: 'site', name: p ? p.name : '(removed pin)', pinId: pin ? site.pinId : null });
        trackDate(site.date);
      });
    });

    const legendItem = document.createElement('div');
    legendItem.className = 'calendar-legend-item';
    legendItem.innerHTML = '<span class="calendar-legend-swatch" style="background:' + color + ';"></span>' +
      escapeHtml(trip.name) + (multiOption ? ' <span class="hint" style="display:inline;">(' + options.length + ' options)</span>' : '') +
      (hasDates ? '' : ' <span class="hint" style="display:inline;">(no dates set)</span>');
    legendItem.style.cursor = 'pointer';
    legendItem.addEventListener('click', () => jumpToTripFromCalendar(trip.id));
    legend.appendChild(legendItem);
  });

  if (!minDate) {
    container.innerHTML = '<div class="field-static">None of your trips have dates set yet — add an arrival date to a campground (or a day to an activity) in a trip to see it here.</div>';
    return;
  }

  let cursorMonth = minDate.slice(0, 7);
  const endMonth = maxDate.slice(0, 7);
  let guard = 0;
  while (cursorMonth <= endMonth && guard < 24) { // safety cap: at most 2 years of months
    container.appendChild(buildAllTripsCalendarMonth(cursorMonth, dayMap));
    const [y, m] = cursorMonth.split('-').map(Number);
    const next = new Date(y, m, 1); // m is 1-indexed, so this already rolls to next month
    cursorMonth = next.getFullYear() + '-' + String(next.getMonth() + 1).padStart(2, '0');
    guard++;
  }
}

function buildAllTripsCalendarMonth(monthKeyStr, dayMap) {
  const [year, month] = monthKeyStr.split('-').map(Number); // month is 1-indexed
  const wrap = document.createElement('div');
  wrap.className = 'trip-calendar-month';
  const heading = document.createElement('h4');
  heading.textContent = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  wrap.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'trip-calendar-grid';
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => {
    const h = document.createElement('div');
    h.className = 'trip-calendar-dow';
    h.textContent = d;
    grid.appendChild(h);
  });

  const startWeekday = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let i = 0; i < startWeekday; i++) {
    const blank = document.createElement('div');
    blank.className = 'trip-calendar-day trip-calendar-day-blank';
    grid.appendChild(blank);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    const cell = document.createElement('div');
    cell.className = 'trip-calendar-day';
    const num = document.createElement('div');
    num.className = 'trip-calendar-daynum';
    num.textContent = day;
    cell.appendChild(num);
    const entries = dayMap[dateStr];
    if (entries) {
      entries.forEach(entry => {
        const chip = document.createElement('div');
        chip.className = 'trip-calendar-chip';
        chip.style.background = entry.color;
        chip.style.color = '#fff';
        const label = entry.kind === 'stop' ? (entry.isStart ? '→ ' : '') + entry.name + (entry.isEnd && !entry.isStart ? ' →' : '') : entry.name;
        chip.textContent = entry.tripName + ': ' + label;
        chip.title = entry.tripName + ' — ' + label;
        chip.addEventListener('click', () => {
          if (entry.pinId) { closeAllTripsCalendar(); openDetail(entry.pinId); }
          else { jumpToTripFromCalendar(entry.tripId); }
        });
        cell.appendChild(chip);
      });
    }
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);
  return wrap;
}

function initOrResetTripMap(centerLat, centerLng, zoom) {
  if (!tripMap) {
    tripMap = L.map('trip-map').setView([centerLat, centerLng], zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(tripMap);
    tripLineLayer = L.layerGroup().addTo(tripMap);
    tripMarkersLayer = L.layerGroup().addTo(tripMap);
  } else {
    tripMap.invalidateSize();
  }
}

function renderTripMap(option) {
  const campEntries = option.stops.map((s, i) => {
    const pin = getPin(s.pinId);
    if (!pin) return null;
    const p = effectivePin(pin);
    return p.lat != null ? { p: p, seq: i + 1, stopId: s.id } : null;
  }).filter(Boolean);
  const siteEntries = (option.sites || []).map(s => {
    const pin = getPin(s.pinId);
    if (!pin) return null;
    const p = effectivePin(pin);
    return p.lat != null ? { p: p, site: s } : null;
  }).filter(Boolean);

  const center = campEntries[0] || siteEntries[0];
  initOrResetTripMap(center ? center.p.lat : PLEASANTON.lat, center ? center.p.lng : PLEASANTON.lng, center ? 8 : 6);
  tripMarkersLayer.clearLayers();
  tripLineLayer.clearLayers();

  // One continuous route line: each campground in order, with any sites tied to the
  // drive day right after it (e.g. Horseshoe Bend between Watchman and Mather) spliced
  // in between — ordered by straight-line distance from the campground being left, as
  // a stand-in for the order you'd actually pass them on the drive.
  const routeLatLngs = [];
  campEntries.forEach((entry, i) => {
    routeLatLngs.push([entry.p.lat, entry.p.lng]);
    if (i < campEntries.length - 1) {
      const nextEntry = campEntries[i + 1];
      const driveSites = siteEntries.filter(se => se.site.assoc && se.site.assoc.type === 'driveday' &&
        se.site.assoc.fromStopId === entry.stopId && se.site.assoc.toStopId === nextEntry.stopId);
      driveSites
        .slice()
        .sort((a, b) => haversineMiles(entry.p.lat, entry.p.lng, a.p.lat, a.p.lng) - haversineMiles(entry.p.lat, entry.p.lng, b.p.lat, b.p.lng))
        .forEach(se => routeLatLngs.push([se.p.lat, se.p.lng]));
    }
  });
  if (routeLatLngs.length > 1) {
    L.polyline(routeLatLngs, { color: '#2f5233', weight: 3, dashArray: '6,6', opacity: 0.7 }).addTo(tripLineLayer);
  }

  const bounds = [];
  campEntries.forEach(entry => {
    const marker = L.marker([entry.p.lat, entry.p.lng], { icon: getMarkerIcon(entry.p) });
    marker.bindPopup('<b>' + entry.seq + '. ' + escapeHtml(entry.p.name) + '</b><br>' +
      escapeHtml(entry.p.category + (entry.p.subcategory ? ' · ' + entry.p.subcategory : '')));
    marker.on('click', () => { closeTripsTool(); openDetail(entry.p.id); });
    tripMarkersLayer.addLayer(marker);
    bounds.push([entry.p.lat, entry.p.lng]);
  });
  siteEntries.forEach(entry => {
    const marker = L.marker([entry.p.lat, entry.p.lng], { icon: getMarkerIcon(entry.p) });
    marker.bindPopup('<b>' + escapeHtml(entry.p.name) + '</b><br>' +
      escapeHtml(entry.p.category + (entry.p.subcategory ? ' · ' + entry.p.subcategory : '')));
    marker.on('click', () => { closeTripsTool(); openDetail(entry.p.id); });
    tripMarkersLayer.addLayer(marker);
    bounds.push([entry.p.lat, entry.p.lng]);
  });

  if (bounds.length > 1) tripMap.fitBounds(bounds, { padding: [24, 24] });
  else if (bounds.length === 1) tripMap.setView(bounds[0], 10);
}

async function computeLegDistance(pinA, pinB) {
  const key = pinA.id + '|' + pinB.id;
  if (legCache[key]) return legCache[key];
  const straight = haversineMiles(pinA.lat, pinA.lng, pinB.lat, pinB.lng);
  try {
    const url = 'https://router.project-osrm.org/route/v1/driving/' + pinA.lng + ',' + pinA.lat + ';' + pinB.lng + ',' + pinB.lat + '?overview=false';
    const resp = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
    if (!resp.ok) throw new Error('OSRM error');
    const data = await resp.json();
    const route = data.routes && data.routes[0];
    if (!route) throw new Error('no route');
    const leg = { miles: route.distance / 1609.34, minutes: route.duration / 60, estimated: false };
    legCache[key] = leg;
    return leg;
  } catch (e) {
    const leg = { miles: straight, minutes: null, estimated: true };
    legCache[key] = leg;
    return leg;
  }
}

function runTripStopSearch(q) {
  const resultsEl = document.getElementById('trip-stop-search-results');
  resultsEl.innerHTML = '';
  if (!q || q.trim().length < 2) return;
  const ql = q.toLowerCase();
  const matches = allPins().map(effectivePin).filter(p => !p.is_hike_ref && p.name.toLowerCase().indexOf(ql) !== -1).slice(0, 15);
  if (!matches.length) {
    resultsEl.innerHTML = '<div class="field-static">No matches.</div>';
    return;
  }
  matches.forEach(p => {
    const row = document.createElement('div');
    row.className = 'list-card';
    row.innerHTML = '<div class="list-card-main"><div class="list-card-name">' + escapeHtml(p.name) + '</div>' +
      '<div class="list-card-meta">' + escapeHtml(p.category + (p.subcategory ? ' · ' + p.subcategory : '')) + '</div></div>' +
      '<button type="button" class="secondary-btn" style="width:auto;">+ Add</button>';
    row.addEventListener('click', () => {
      const option = getActiveOption();
      if (!option) return;
      addStopToOption(option, p.id);
      renderTripDetail();
    });
    resultsEl.appendChild(row);
  });
}

// ---------- Add / Edit custom pin ----------
let addMap = null;
let addMarker = null;
let addLatLng = null;
let editingPinId = null;

function populateSubcatOptions(category, rowId, selectId, includeAnyOption) {
  const row = document.getElementById(rowId);
  const sel = document.getElementById(selectId);
  const subcats = CATEGORY_SUBCATS[category];
  if (!subcats) {
    row.classList.add('hidden');
    sel.innerHTML = '';
    return;
  }
  row.classList.remove('hidden');
  const anyOpt = includeAnyOption ? '<option value="">Any type</option>' : '';
  sel.innerHTML = anyOpt + subcats.map(sc => '<option value="' + escapeHtml(sc) + '">' + escapeHtml(sc) + '</option>').join('');
}

function populateAddSubcatOptions(category) {
  populateSubcatOptions(category, 'add-subcat-row', 'add-subcategory', false);
}

function populateDistanceSubcatChecks(category) {
  const row = document.getElementById('distance-subcat-row');
  const container = document.getElementById('distance-subcat-checks');
  distanceSelectedSubcats.clear();
  container.innerHTML = '';
  const subcats = CATEGORY_SUBCATS[category];
  if (!subcats) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  subcats.forEach(sc => {
    const label = document.createElement('label');
    label.className = 'checkbox-row';
    label.innerHTML = '<input type="checkbox"> ' + escapeHtml(sc);
    label.querySelector('input').addEventListener('change', e => {
      if (e.target.checked) distanceSelectedSubcats.add(sc); else distanceSelectedSubcats.delete(sc);
    });
    container.appendChild(label);
  });
}

function updateAddCampingChecksVisibility(category) {
  const isCamp = category === 'Camping';
  document.getElementById('add-camping-checks').classList.toggle('hidden', !isCamp);
  const onlyFields = document.getElementById('add-camping-only-fields');
  if (onlyFields) onlyFields.classList.toggle('hidden', !isCamp);
}

function updateAddHikeFieldsVisibility(category, subcategory) {
  const isHike = category === 'Things To Do' && subcategory === 'Hikes';
  const onlyFields = document.getElementById('add-hike-only-fields');
  if (onlyFields) onlyFields.classList.toggle('hidden', !isHike);
  const urlLabel = document.getElementById('add-url-label');
  if (urlLabel) urlLabel.textContent = isHike ? 'AllTrails (or other) link' : 'Website / booking URL';
}

function updateAddLocationStatus() {
  const el = document.getElementById('add-location-status');
  if (addLatLng) {
    el.textContent = 'Location set: ' + addLatLng.lat.toFixed(4) + ', ' + addLatLng.lng.toFixed(4) + ' (drag the pin to fine-tune)';
  } else {
    el.textContent = 'Not set yet — click the map below, or search an address.';
  }
}

function setAddLocation(lat, lng) {
  addLatLng = { lat: lat, lng: lng };
  if (addMarker) {
    addMarker.setLatLng([lat, lng]);
  } else {
    addMarker = L.marker([lat, lng], { draggable: true }).addTo(addMap);
    addMarker.on('dragend', () => {
      const ll = addMarker.getLatLng();
      addLatLng = { lat: ll.lat, lng: ll.lng };
      updateAddLocationStatus();
    });
  }
  updateAddLocationStatus();
}

function initOrResetAddMap(centerLat, centerLng, zoom) {
  if (!addMap) {
    addMap = L.map('add-map').setView([centerLat, centerLng], zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(addMap);
    addMap.on('click', e => setAddLocation(e.latlng.lat, e.latlng.lng));
  } else {
    addMap.invalidateSize();
    addMap.setView([centerLat, centerLng], zoom);
  }
}

function openAddForm(editingPin, prefill) {
  const source = editingPin || prefill || null;
  editingPinId = editingPin ? editingPin.id : null;
  document.getElementById('add-form-title').textContent = editingPin ? 'Edit pin' : (prefill ? 'Add hike pin' : 'Add a new pin');
  document.getElementById('add-name').value = source ? source.name : '';
  document.getElementById('add-category').value = source ? source.category : 'Camping';
  populateAddSubcatOptions(document.getElementById('add-category').value);
  if (source && source.subcategory) document.getElementById('add-subcategory').value = source.subcategory;
  updateAddCampingChecksVisibility(document.getElementById('add-category').value);
  updateAddHikeFieldsVisibility(document.getElementById('add-category').value, document.getElementById('add-subcategory').value);
  document.getElementById('add-starlink').checked = !!(source && source.starlink_friendly);
  document.getElementById('add-hatch').checked = !!(source && source.good_for_hatch);
  document.getElementById('add-bookable').checked = !!(source && source.bookable);
  document.getElementById('add-state').value = (source && source.state) || '';
  document.getElementById('add-price').value = (source && source.price_usd != null) ? source.price_usd : '';
  document.getElementById('add-hookups').value = (source && source.hookup_types) ? source.hookup_types.join(', ') : '';
  document.getElementById('add-hike-rating').value = (source && source.hike_rating != null) ? source.hike_rating : '';
  document.getElementById('add-hike-length').value = (source && source.hike_length_miles != null) ? source.hike_length_miles : '';
  document.getElementById('add-hike-difficulty').value = (source && source.hike_difficulty) || '';
  document.getElementById('add-hike-route-type').value = (source && source.hike_route_type) || '';
  document.getElementById('add-url').value = (source && source.url) || '';
  document.getElementById('add-notes').value = (source && source.notes) || '';
  document.getElementById('add-address').value = '';
  document.getElementById('add-delete-btn').classList.toggle('hidden', !editingPin);

  addLatLng = editingPin ? { lat: editingPin.lat, lng: editingPin.lng } : null;
  addMarker = null;

  document.getElementById('add-overlay').classList.remove('hidden');
  setTimeout(() => {
    initOrResetAddMap(
      editingPin ? editingPin.lat : (prefill && prefill.lat != null ? prefill.lat : PLEASANTON.lat),
      editingPin ? editingPin.lng : (prefill && prefill.lng != null ? prefill.lng : PLEASANTON.lng),
      editingPin ? 11 : (prefill ? 11 : 7)
    );
    if (editingPin) setAddLocation(editingPin.lat, editingPin.lng);
    updateAddLocationStatus();
  }, 50);
}

// Opens the Add Pin form pre-filled with a campground's nearby-hike entry, so the user can
// place it as a real map pin carrying the same hike details (rating/length/difficulty/AllTrails
// link). Location is intentionally left unset — she places it herself (defaults the map to the
// source campground's area for convenience).
function openAddFormFromHike(hike, sourcePin) {
  const prefill = {
    name: hike.name,
    category: 'Things To Do',
    subcategory: 'Hikes',
    url: hike.url || null,
    hike_rating: hike.rating != null ? hike.rating : null,
    hike_length_miles: hike.length_miles != null ? hike.length_miles : null,
    hike_difficulty: hike.difficulty || null,
    hike_route_type: hike.route_type || null,
    notes: 'Nearby hike near ' + sourcePin.name + (hike.trailhead_distance_miles != null ? ' (' + hike.trailhead_distance_miles + ' mi from the campground)' : ''),
    lat: sourcePin.lat,
    lng: sourcePin.lng
  };
  openAddForm(null, prefill);
}

function closeAddForm() {
  document.getElementById('add-overlay').classList.add('hidden');
}

async function geocodeAddress() {
  const q = document.getElementById('add-address').value.trim();
  if (!q) return;
  const statusEl = document.getElementById('add-location-status');
  statusEl.textContent = 'Searching...';
  try {
    const resp = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q), {
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
    });
    const results = await resp.json();
    if (results && results[0]) {
      const lat = parseFloat(results[0].lat), lng = parseFloat(results[0].lon);
      addMap.setView([lat, lng], 12);
      setAddLocation(lat, lng);
    } else {
      alert('No match found for that address — try clicking the map instead.');
      updateAddLocationStatus();
    }
  } catch (err) {
    alert('Could not search right now (are you offline?) — click the map to set the location instead.');
    updateAddLocationStatus();
  }
}

async function saveAddForm() {
  const name = document.getElementById('add-name').value.trim();
  if (!name) { alert('Please enter a name.'); return; }
  if (!addLatLng) { alert('Please set a location by clicking the map or searching an address.'); return; }

  const category = document.getElementById('add-category').value;
  const subcats = CATEGORY_SUBCATS[category];
  const subcategory = subcats ? document.getElementById('add-subcategory').value : null;
  const isCampground = category === 'Camping';
  const isHike = category === 'Things To Do' && subcategory === 'Hikes';
  const priceVal = document.getElementById('add-price').value;
  const hookupsRaw = document.getElementById('add-hookups').value;
  const hikeRatingVal = document.getElementById('add-hike-rating').value;
  const hikeLengthVal = document.getElementById('add-hike-length').value;
  const urlVal = document.getElementById('add-url').value.trim();
  const straightMiles = haversineMiles(PLEASANTON.lat, PLEASANTON.lng, addLatLng.lat, addLatLng.lng);

  const existing = editingPinId ? CUSTOM_PINS.find(p => p.id === editingPinId) : null;

  const pin = {
    id: existing ? existing.id : ('custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)),
    is_custom: true,
    name: name,
    lat: addLatLng.lat,
    lng: addLatLng.lng,
    category: category,
    subcategory: subcategory,
    state: document.getElementById('add-state').value.trim() || null,
    price_usd: isCampground ? (priceVal === '' ? null : parseFloat(priceVal)) : null,
    hookup_types: isCampground ? hookupsRaw.split(',').map(s => s.trim()).filter(Boolean) : [],
    url: urlVal || null,
    notes: document.getElementById('add-notes').value || null,
    starlink_friendly: isCampground ? document.getElementById('add-starlink').checked : null,
    good_for_hatch: isCampground ? document.getElementById('add-hatch').checked : null,
    bookable: isCampground ? document.getElementById('add-bookable').checked : null,
    hike_rating: isHike ? (hikeRatingVal === '' ? null : parseFloat(hikeRatingVal)) : null,
    hike_length_miles: isHike ? (hikeLengthVal === '' ? null : parseFloat(hikeLengthVal)) : null,
    hike_difficulty: isHike ? (document.getElementById('add-hike-difficulty').value || null) : null,
    hike_route_type: isHike ? (document.getElementById('add-hike-route-type').value.trim() || null) : null,
    is_campground: isCampground,
    visited: existing ? existing.visited : (isCampground ? false : null),
    done: existing ? existing.done : (!isCampground ? false : null),
    driving_miles_from_pleasanton: Math.round(straightMiles * 10) / 10,
    driving_minutes_from_pleasanton: null,
    distance_is_estimated: true
  };

  if (existing) {
    CUSTOM_PINS = CUSTOM_PINS.map(p => p.id === existing.id ? pin : p);
  } else {
    CUSTOM_PINS.push(pin);
  }
  saveCustomPins(CUSTOM_PINS);
  await pushCloudStateNow();
  location.reload();
}

// ---------- Filter UI construction ----------
function buildCategoryFilters() {
  const container = document.getElementById('category-filters');
  const counts = {};
  allPins().forEach(p => { counts[p.category] = (counts[p.category] || 0) + 1; });
  CATEGORY_ORDER.forEach(cat => {
    if (!counts[cat]) return;
    const label = document.createElement('label');
    label.className = 'checkbox-row';
    label.innerHTML = '<input type="checkbox"> ' + escapeHtml(cat) + ' (' + counts[cat] + ')';
    label.querySelector('input').addEventListener('change', e => {
      if (e.target.checked) filters.categories.add(cat); else filters.categories.delete(cat);
      applyFilters();
    });
    container.appendChild(label);
  });
}

function buildSubcatFilters(containerId, subcats, categoryName, targetSet) {
  const container = document.getElementById(containerId);
  const counts = {};
  allPins().forEach(p => { if (p.category === categoryName) counts[p.subcategory] = (counts[p.subcategory] || 0) + 1; });
  subcats.forEach(sc => {
    if (!counts[sc]) return;
    const label = document.createElement('label');
    label.className = 'checkbox-row';
    label.innerHTML = '<input type="checkbox"> ' + escapeHtml(sc) + ' (' + counts[sc] + ')';
    label.querySelector('input').addEventListener('change', e => {
      if (e.target.checked) targetSet.add(sc); else targetSet.delete(sc);
      applyFilters();
    });
    container.appendChild(label);
  });
}

function buildMonthFilters() {
  const container = document.getElementById('month-filters');
  MONTH_ABBR.forEach(m => {
    const label = document.createElement('label');
    label.className = 'checkbox-row';
    label.style.display = 'inline-flex';
    label.style.width = '31%';
    label.style.boxSizing = 'border-box';
    label.innerHTML = '<input type="checkbox"> ' + m;
    label.querySelector('input').addEventListener('change', e => {
      if (e.target.checked) filters.months.add(m); else filters.months.delete(m);
      applyFilters();
    });
    container.appendChild(label);
  });
}

function buildStateFilter() {
  const sel = document.getElementById('filter-state');
  const states = Array.from(new Set(allPins().map(p => p.state).filter(Boolean))).sort();
  states.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => { filters.state = sel.value; applyFilters(); });
}

// ---------- View toggle ----------
function setView(view) {
  currentView = view;
  document.getElementById('view-toggle-map').classList.toggle('active', view === 'map');
  document.getElementById('view-toggle-list').classList.toggle('active', view === 'list');
  document.getElementById('map').classList.toggle('hidden', view !== 'map');
  document.getElementById('list-view').classList.toggle('hidden', view !== 'list');
  if (view === 'map') setTimeout(() => map.invalidateSize(), 50);
  applyFilters();
}

// ---------- Clear filters ----------
function clearFilters() {
  filters.search = '';
  filters.categories.clear();
  filters.campingSubcats.clear();
  filters.thingsToDoSubcats.clear();
  filters.fooddrinkSubcats.clear();
  filters.starlink = false;
  filters.hatch = false;
  filters.bookableOnly = false;
  filters.nearTown = false;
  filters.visited = 'all';
  filters.done = 'all';
  filters.state = '';
  filters.within400 = false;
  filters.priceMin = null;
  filters.priceMax = null;
  filters.months.clear();

  document.getElementById('search-box').value = '';
  document.querySelectorAll('#category-filters input, #camping-subfilters input, #thingstodo-subfilters input, #fooddrink-subfilters input, #month-filters input')
    .forEach(i => { i.checked = false; });
  document.getElementById('filter-starlink').checked = false;
  document.getElementById('filter-hatch').checked = false;
  document.getElementById('filter-bookable').checked = false;
  document.getElementById('filter-neartown').checked = false;
  document.getElementById('filter-visited').value = 'all';
  document.getElementById('filter-done').value = 'all';
  document.getElementById('filter-state').value = '';
  document.getElementById('filter-400mi').checked = false;
  document.getElementById('price-min').value = '';
  document.getElementById('price-max').value = '';

  applyFilters();
}

// ---------- Export / Import edits ----------
function exportEdits() {
  const payload = { edits: EDITS, customPins: CUSTOM_PINS, trips: TRIPS };
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'camp-travel-map-edits-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importEditsFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const imported = JSON.parse(reader.result);
      // Backward compatible: older export files were just the bare EDITS object
      // (no "edits"/"customPins" wrapper). Detect the new shape by those keys.
      const hasWrapper = imported && typeof imported === 'object' &&
        (Object.prototype.hasOwnProperty.call(imported, 'edits') || Object.prototype.hasOwnProperty.call(imported, 'customPins'));
      const importedEdits = hasWrapper ? (imported.edits || {}) : imported;
      const importedCustomPins = hasWrapper ? (imported.customPins || []) : [];
      const importedTrips = hasWrapper ? (imported.trips || []) : [];

      EDITS = Object.assign({}, EDITS, importedEdits);
      saveEdits(EDITS);

      if (importedTrips.length) {
        const existingTripIds = new Set(TRIPS.map(t => t.id));
        importedTrips.forEach(t => {
          if (existingTripIds.has(t.id)) {
            TRIPS = TRIPS.map(et => et.id === t.id ? t : et);
          } else {
            TRIPS.push(t);
            existingTripIds.add(t.id);
          }
        });
        saveTrips(TRIPS);
      }

      if (importedCustomPins.length) {
        const existingIds = new Set(CUSTOM_PINS.map(p => p.id));
        importedCustomPins.forEach(p => {
          if (existingIds.has(p.id)) {
            CUSTOM_PINS = CUSTOM_PINS.map(cp => cp.id === p.id ? p : cp);
          } else {
            CUSTOM_PINS.push(p);
            existingIds.add(p.id);
          }
        });
        saveCustomPins(CUSTOM_PINS);
      }

      alert('Edits imported successfully.');
      await pushCloudStateNow();
      location.reload();
    } catch (e) {
      alert('Could not read that file — is it a valid export from this app?');
    }
  };
  reader.readAsText(file);
}

// ---------- Init ----------
function init() {
  buildCategoryFilters();
  buildSubcatFilters('camping-subfilters', CAMPING_SUBCATS, 'Camping', filters.campingSubcats);
  buildSubcatFilters('thingstodo-subfilters', THINGSTODO_SUBCATS, 'Things To Do', filters.thingsToDoSubcats);
  buildSubcatFilters('fooddrink-subfilters', FOODDRINK_SUBCATS, 'Food & Drink', filters.fooddrinkSubcats);
  buildStateFilter();
  buildMonthFilters();
  initMap();

  document.getElementById('search-box').addEventListener('input', e => { filters.search = e.target.value.toLowerCase(); applyFilters(); });
  document.getElementById('filter-starlink').addEventListener('change', e => { filters.starlink = e.target.checked; applyFilters(); });
  document.getElementById('filter-hatch').addEventListener('change', e => { filters.hatch = e.target.checked; applyFilters(); });
  document.getElementById('filter-bookable').addEventListener('change', e => { filters.bookableOnly = e.target.checked; applyFilters(); });
  document.getElementById('filter-neartown').addEventListener('change', e => { filters.nearTown = e.target.checked; applyFilters(); });
  document.getElementById('filter-visited').addEventListener('change', e => { filters.visited = e.target.value; applyFilters(); });
  document.getElementById('filter-done').addEventListener('change', e => { filters.done = e.target.value; applyFilters(); });
  document.getElementById('filter-400mi').addEventListener('change', e => { filters.within400 = e.target.checked; applyFilters(); });
  document.getElementById('price-min').addEventListener('input', e => { filters.priceMin = e.target.value === '' ? null : parseFloat(e.target.value); applyFilters(); });
  document.getElementById('price-max').addEventListener('input', e => { filters.priceMax = e.target.value === '' ? null : parseFloat(e.target.value); applyFilters(); });
  document.getElementById('clear-filters-btn').addEventListener('click', clearFilters);

  document.getElementById('view-toggle-map').addEventListener('click', () => setView('map'));
  document.getElementById('view-toggle-list').addEventListener('click', () => setView('list'));
  document.getElementById('menu-toggle').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));

  document.getElementById('detail-close').addEventListener('click', closeDetail);
  document.getElementById('detail-overlay').addEventListener('click', e => { if (e.target.id === 'detail-overlay') closeDetail(); });

  document.getElementById('distance-tool-btn').addEventListener('click', () => openDistanceTool());
  document.getElementById('distance-close').addEventListener('click', closeDistanceTool);
  document.getElementById('distance-overlay').addEventListener('click', e => { if (e.target.id === 'distance-overlay') closeDistanceTool(); });
  document.getElementById('distance-run-btn').addEventListener('click', runDistanceSearch);
  document.getElementById('distance-category').addEventListener('change', e => {
    populateDistanceSubcatChecks(e.target.value);
  });
  document.getElementById('distance-view-list').addEventListener('click', () => setDistanceViewMode('list'));
  document.getElementById('distance-view-map').addEventListener('click', () => setDistanceViewMode('map'));

  document.getElementById('trips-tool-btn').addEventListener('click', () => openTripsTool());
  document.getElementById('trips-close').addEventListener('click', closeTripsTool);
  document.getElementById('trips-overlay').addEventListener('click', e => { if (e.target.id === 'trips-overlay') closeTripsTool(); });

  document.getElementById('calendar-tool-btn').addEventListener('click', () => openAllTripsCalendar());
  document.getElementById('calendar-close').addEventListener('click', closeAllTripsCalendar);
  document.getElementById('calendar-overlay').addEventListener('click', e => { if (e.target.id === 'calendar-overlay') closeAllTripsCalendar(); });
  document.getElementById('new-trip-btn').addEventListener('click', createTrip);
  document.getElementById('trip-back-btn').addEventListener('click', renderTripsListView);
  document.getElementById('trip-name-input').addEventListener('change', e => {
    const trip = getActiveTrip();
    if (!trip) return;
    trip.name = e.target.value.trim() || trip.name;
    e.target.value = trip.name;
    saveTrips(TRIPS);
  });
  document.getElementById('trip-add-option-btn').addEventListener('click', () => {
    const trip = getActiveTrip();
    if (!trip) return;
    const opt = { id: genId('opt'), name: 'Option ' + (trip.options.length + 1), stops: [], sites: [] };
    trip.options.push(opt);
    activeOptionId = opt.id;
    saveTrips(TRIPS);
    renderTripDetail();
  });
  document.getElementById('trip-delete-option-btn').addEventListener('click', () => {
    const trip = getActiveTrip();
    if (!trip || trip.options.length <= 1) return;
    const option = getActiveOption();
    if (!confirm('Delete "' + option.name + '" and its stops?')) return;
    trip.options = trip.options.filter(o => o.id !== option.id);
    activeOptionId = trip.options[0].id;
    saveTrips(TRIPS);
    renderTripDetail();
  });
  document.getElementById('trip-delete-btn').addEventListener('click', () => {
    const trip = getActiveTrip();
    if (!trip) return;
    if (!confirm('Delete the whole trip "' + trip.name + '"? This can\'t be undone.')) return;
    TRIPS = TRIPS.filter(t => t.id !== trip.id);
    saveTrips(TRIPS);
    renderTripsListView();
  });
  document.getElementById('trip-stop-search').addEventListener('input', e => runTripStopSearch(e.target.value));
  document.getElementById('trip-view-list').addEventListener('click', () => setTripViewMode('list'));
  document.getElementById('trip-view-map').addEventListener('click', () => setTripViewMode('map'));
  document.getElementById('trip-view-calendar').addEventListener('click', () => setTripViewMode('calendar'));
  document.getElementById('trip-print-btn').addEventListener('click', openTripPrintSummary);

  document.getElementById('export-btn').addEventListener('click', exportEdits);
  document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', e => { if (e.target.files[0]) importEditsFile(e.target.files[0]); });

  document.getElementById('add-pin-btn').addEventListener('click', () => openAddForm());
  document.getElementById('add-close').addEventListener('click', closeAddForm);
  document.getElementById('add-overlay').addEventListener('click', e => { if (e.target.id === 'add-overlay') closeAddForm(); });
  document.getElementById('add-category').addEventListener('change', e => {
    populateAddSubcatOptions(e.target.value);
    updateAddCampingChecksVisibility(e.target.value);
    updateAddHikeFieldsVisibility(e.target.value, document.getElementById('add-subcategory').value);
  });
  document.getElementById('add-subcategory').addEventListener('change', e => {
    updateAddHikeFieldsVisibility(document.getElementById('add-category').value, e.target.value);
  });
  document.getElementById('add-geocode-btn').addEventListener('click', geocodeAddress);
  document.getElementById('add-save-btn').addEventListener('click', saveAddForm);
  document.getElementById('add-delete-btn').addEventListener('click', async () => {
    if (!editingPinId) return;
    const p = CUSTOM_PINS.find(cp => cp.id === editingPinId);
    if (!confirm('Delete "' + (p ? p.name : 'this pin') + '"? This can\'t be undone (unless you have an exported backup).')) return;
    CUSTOM_PINS = CUSTOM_PINS.filter(cp => cp.id !== editingPinId);
    saveCustomPins(CUSTOM_PINS);
    await pushCloudStateNow();
    location.reload();
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.hike-add-menu').forEach(m => m.classList.add('hidden'));
  });

  applyFilters();
  prefetchClimateData();
  if (cloudSyncEnabled) {
    const syncBtn = document.getElementById('cloud-sync-now-btn');
    if (syncBtn) {
      syncBtn.style.display = '';
      syncBtn.addEventListener('click', syncNowClicked);
    }
  }
  pullCloudStateOnce();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
