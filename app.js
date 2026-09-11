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
const CAMPING_SUBCATS = ['Public', 'Private', 'Boondocking'];
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
  'Camping': { 'Public': '⛺', 'Private': '🚐', 'Boondocking': '🌲' },
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
}
let EDITS = loadEdits();

// ---------- Custom pins the user added in-app (localStorage) ----------
function loadCustomPins() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_PINS_KEY) || '[]'); }
  catch (e) { return []; }
}
function saveCustomPins(pins) {
  try { localStorage.setItem(CUSTOM_PINS_KEY, JSON.stringify(pins)); } catch (e) { /* ignore */ }
}
let CUSTOM_PINS = loadCustomPins();

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
  month: ''
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

  if (filters.month) {
    const months = getBestMonths(p);
    if (!months || !months.includes(filters.month)) return false;
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
  const all = allPins();
  const filtered = all.filter(passesFilters);
  document.getElementById('result-count').textContent = filtered.length + ' of ' + all.length + ' shown';
  if (currentView === 'map') renderMap(filtered);
  else renderList(filtered);
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
  if (p.park_type) rows.push('<div class="field-row"><label>Park type</label><div class="field-static">' + escapeHtml(p.park_type) + '</div></div>');
  if (p.reservation_timing) rows.push('<div class="field-row"><label>Reservation timing</label><div class="field-static">' + escapeHtml(p.reservation_timing) + '</div></div>');
  if (maxNightsText) rows.push('<div class="field-row"><label>Max nights</label><div class="field-static">' + escapeHtml(maxNightsText) + '</div></div>');
  rows.push('<div class="field-row"><label>' + (p.is_campground ? 'Visited' : 'Done') + '</label><div class="field-static">' + ((p.is_campground ? p.visited : p.done) ? 'Yes' : 'No') + '</div></div>');
  rows.push('<div class="field-row"><label>Price per night</label><div class="field-static">' + (p.price_usd != null ? '$' + p.price_usd : '—') + '</div></div>');
  rows.push('<div class="field-row"><label>Hookups</label><div class="field-static">' + (escapeHtml((p.hookup_types || []).join(', ')) || '—') + '</div></div>');
  rows.push('<div class="field-row"><label>Website / booking URL</label><div class="field-static">' + (p.url ? '<a href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener">' + escapeHtml(p.url) + '</a>' : '—') + '</div></div>');
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
  if (p.category === 'Camping') rows.push('<div class="field-row"><label>Towns &amp; cities within 10mi</label><input type="text" id="edit-towns-override" value="' + escapeHtml(townsOverride) + '" placeholder="Leave blank to auto-detect, or type your own list"></div>');
  rows.push('<div class="field-row"><label>Park type</label><input type="text" id="edit-park-type" value="' + escapeHtml(p.park_type || '') + '"></div>');
  rows.push('<div class="field-row"><label>Reservation timing</label><input type="text" id="edit-reservation-timing" value="' + escapeHtml(p.reservation_timing || '') + '" placeholder="e.g. 6 months in advance, first-come first-served"></div>');
  rows.push('<div class="field-row"><label>Max nights</label><div class="price-row">' +
    '<input type="number" id="edit-max-nights-stay" min="0" placeholder="per stay" value="' + (p.max_nights_stay != null ? p.max_nights_stay : '') + '">' +
    '<input type="number" id="edit-max-nights-year" min="0" placeholder="per year" value="' + (p.max_nights_year != null ? p.max_nights_year : '') + '">' +
    '</div></div>');
  rows.push('<div class="toggle-row"><span>' + (p.is_campground ? 'Visited' : 'Done') + '</span>' +
    '<input type="checkbox" id="detail-status-toggle" ' + ((p.is_campground ? p.visited : p.done) ? 'checked' : '') + '></div>');
  rows.push('<div class="field-row"><label>Price per night ($)</label><input type="number" id="detail-price" min="0" value="' + (p.price_usd != null ? p.price_usd : '') + '"></div>');
  rows.push('<div class="field-row"><label>Hookups</label><input type="text" id="detail-hookups" value="' + escapeHtml((p.hookup_types || []).join(', ')) + '" placeholder="e.g. FHU, W&E, Dry"></div>');
  rows.push('<div class="field-row"><label>Website / booking URL</label><input type="text" id="detail-url" value="' + escapeHtml(p.url || '') + '"></div>');
  rows.push('<div id="detail-tag-checks">' +
    '<label class="checkbox-row"><input type="checkbox" id="detail-starlink" ' + (p.starlink_friendly ? 'checked' : '') + '> Starlink Friendly</label>' +
    '<label class="checkbox-row"><input type="checkbox" id="detail-hatch" ' + (p.good_for_hatch ? 'checked' : '') + '> Good for Hatch</label>' +
    '<label class="checkbox-row"><input type="checkbox" id="detail-bookable" ' + (p.bookable ? 'checked' : '') + '> Bookable</label>' +
    '</div>');
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
          '<button class="hike-remove-btn" data-hike-index="' + i + '" title="Remove this hike" style="background:none;border:none;color:#b5493b;font-size:18px;cursor:pointer;">&times;</button>' +
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
  const editCategorySel = document.getElementById('edit-category');
  if (editCategorySel) {
    editCategorySel.addEventListener('change', e => {
      populateSubcatOptions(e.target.value, 'edit-subcat-row', 'edit-subcategory', false);
    });
  }

  document.getElementById('detail-save-btn').onclick = () => {
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
    const urlVal = document.getElementById('detail-url').value.trim();
    fields.url = urlVal || null;
    fields.starlink_friendly = document.getElementById('detail-starlink').checked;
    fields.good_for_hatch = document.getElementById('detail-hatch').checked;
    fields.bookable = document.getElementById('detail-bookable').checked;
    fields.notes = document.getElementById('detail-notes').value;
    const statusChecked = document.getElementById('detail-status-toggle').checked;
    if (fields.is_campground) fields.visited = statusChecked; else fields.done = statusChecked;
    updatePinEdit(p.id, fields);
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

  const editBtn = document.getElementById('detail-edit-pin-btn');
  if (editBtn) editBtn.onclick = () => { closeDetail(); openAddForm(p); };
  const delBtn = document.getElementById('detail-delete-pin-btn');
  if (delBtn) delBtn.onclick = () => {
    if (!confirm('Delete "' + p.name + '"? This can\'t be undone (unless you have an exported backup).')) return;
    CUSTOM_PINS = CUSTOM_PINS.filter(cp => cp.id !== p.id);
    saveCustomPins(CUSTOM_PINS);
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
}
let TRIPS = loadTrips();

let activeTripId = null;
let activeOptionId = null;
let tripPickerPinId = null;
const legCache = {}; // "idA|idB" -> {miles, minutes, estimated}

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
    const stopCount = trip.options.reduce((sum, o) => sum + o.stops.length, 0);
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
  const trip = { id: genId('trip'), name: name, options: [{ id: genId('opt'), name: 'Option 1', stops: [] }] };
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

  renderTripStops(option);
  document.getElementById('trip-stop-search').value = '';
  document.getElementById('trip-stop-search-results').innerHTML = '';
}

function addStopToOption(option, pinId, date) {
  option.stops.push({ pinId: pinId, date: date || null, notes: '' });
  saveTrips(TRIPS);
}

function renderTripStops(option) {
  const container = document.getElementById('trip-stops-list');
  container.innerHTML = '';
  if (!option.stops.length) {
    container.innerHTML = '<div class="field-static">No stops yet — search below to add one.</div>';
    return;
  }
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
      '<div class="price-row" style="margin-top:6px;">' +
        '<label style="align-self:center;font-size:12px;color:var(--brown);margin-right:4px;">Date:</label>' +
        '<input type="date" data-act="date" value="' + (stop.date || '') + '">' +
      '</div>';
    card.querySelector('[data-act="up"]').addEventListener('click', () => moveStop(option, i, -1));
    card.querySelector('[data-act="down"]').addEventListener('click', () => moveStop(option, i, 1));
    card.querySelector('[data-act="remove"]').addEventListener('click', () => removeStop(option, i));
    card.querySelector('[data-act="date"]').addEventListener('change', e => { stop.date = e.target.value || null; saveTrips(TRIPS); });
    container.appendChild(card);

    if (i < option.stops.length - 1) {
      const nextPin = getPin(option.stops[i + 1].pinId);
      const legEl = document.createElement('div');
      legEl.className = 'hint';
      legEl.style.margin = '2px 0 2px 10px';
      container.appendChild(legEl);
      if (p && nextPin && p.lat != null && p.lng != null) {
        const nextP = effectivePin(nextPin);
        legEl.textContent = 'Calculating drive...';
        computeLegDistance(p, nextP).then(leg => {
          legEl.textContent = '↓ ' + Math.round(leg.miles) + ' mi' +
            (leg.minutes != null ? ' (~' + Math.round(leg.minutes / 6) / 10 + ' hr)' : '') +
            (leg.estimated ? ' — straight-line est.' : ' drive');
        });
      }
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
  renderTripStops(option);
}

function removeStop(option, index) {
  option.stops.splice(index, 1);
  saveTrips(TRIPS);
  renderTripStops(option);
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
  const matches = allPins().map(effectivePin).filter(p => p.name.toLowerCase().indexOf(ql) !== -1).slice(0, 15);
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
  document.getElementById('add-camping-checks').classList.toggle('hidden', category !== 'Camping');
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

function openAddForm(editingPin) {
  editingPinId = editingPin ? editingPin.id : null;
  document.getElementById('add-form-title').textContent = editingPin ? 'Edit pin' : 'Add a new pin';
  document.getElementById('add-name').value = editingPin ? editingPin.name : '';
  document.getElementById('add-category').value = editingPin ? editingPin.category : 'Camping';
  populateAddSubcatOptions(document.getElementById('add-category').value);
  if (editingPin && editingPin.subcategory) document.getElementById('add-subcategory').value = editingPin.subcategory;
  updateAddCampingChecksVisibility(document.getElementById('add-category').value);
  document.getElementById('add-starlink').checked = !!(editingPin && editingPin.starlink_friendly);
  document.getElementById('add-hatch').checked = !!(editingPin && editingPin.good_for_hatch);
  document.getElementById('add-bookable').checked = !!(editingPin && editingPin.bookable);
  document.getElementById('add-state').value = (editingPin && editingPin.state) || '';
  document.getElementById('add-price').value = (editingPin && editingPin.price_usd != null) ? editingPin.price_usd : '';
  document.getElementById('add-hookups').value = (editingPin && editingPin.hookup_types) ? editingPin.hookup_types.join(', ') : '';
  document.getElementById('add-url').value = (editingPin && editingPin.url) || '';
  document.getElementById('add-notes').value = (editingPin && editingPin.notes) || '';
  document.getElementById('add-address').value = '';
  document.getElementById('add-delete-btn').classList.toggle('hidden', !editingPin);

  addLatLng = editingPin ? { lat: editingPin.lat, lng: editingPin.lng } : null;
  addMarker = null;

  document.getElementById('add-overlay').classList.remove('hidden');
  setTimeout(() => {
    initOrResetAddMap(
      editingPin ? editingPin.lat : PLEASANTON.lat,
      editingPin ? editingPin.lng : PLEASANTON.lng,
      editingPin ? 11 : 7
    );
    if (editingPin) setAddLocation(editingPin.lat, editingPin.lng);
    updateAddLocationStatus();
  }, 50);
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

function saveAddForm() {
  const name = document.getElementById('add-name').value.trim();
  if (!name) { alert('Please enter a name.'); return; }
  if (!addLatLng) { alert('Please set a location by clicking the map or searching an address.'); return; }

  const category = document.getElementById('add-category').value;
  const subcats = CATEGORY_SUBCATS[category];
  const subcategory = subcats ? document.getElementById('add-subcategory').value : null;
  const isCampground = category === 'Camping';
  const priceVal = document.getElementById('add-price').value;
  const hookupsRaw = document.getElementById('add-hookups').value;
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
    price_usd: priceVal === '' ? null : parseFloat(priceVal),
    hookup_types: hookupsRaw.split(',').map(s => s.trim()).filter(Boolean),
    url: urlVal || null,
    notes: document.getElementById('add-notes').value || null,
    starlink_friendly: isCampground ? document.getElementById('add-starlink').checked : null,
    good_for_hatch: isCampground ? document.getElementById('add-hatch').checked : null,
    bookable: isCampground ? document.getElementById('add-bookable').checked : null,
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
  filters.month = '';

  document.getElementById('search-box').value = '';
  document.querySelectorAll('#category-filters input, #camping-subfilters input, #thingstodo-subfilters input, #fooddrink-subfilters input')
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
  document.getElementById('filter-month').value = '';

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
  reader.onload = () => {
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
  document.getElementById('filter-month').addEventListener('change', e => { filters.month = e.target.value; applyFilters(); });
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
    const opt = { id: genId('opt'), name: 'Option ' + (trip.options.length + 1), stops: [] };
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

  document.getElementById('export-btn').addEventListener('click', exportEdits);
  document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', e => { if (e.target.files[0]) importEditsFile(e.target.files[0]); });

  document.getElementById('add-pin-btn').addEventListener('click', () => openAddForm());
  document.getElementById('add-close').addEventListener('click', closeAddForm);
  document.getElementById('add-overlay').addEventListener('click', e => { if (e.target.id === 'add-overlay') closeAddForm(); });
  document.getElementById('add-category').addEventListener('change', e => {
    populateAddSubcatOptions(e.target.value);
    updateAddCampingChecksVisibility(e.target.value);
  });
  document.getElementById('add-geocode-btn').addEventListener('click', geocodeAddress);
  document.getElementById('add-save-btn').addEventListener('click', saveAddForm);
  document.getElementById('add-delete-btn').addEventListener('click', () => {
    if (!editingPinId) return;
    const p = CUSTOM_PINS.find(cp => cp.id === editingPinId);
    if (!confirm('Delete "' + (p ? p.name : 'this pin') + '"? This can\'t be undone (unless you have an exported backup).')) return;
    CUSTOM_PINS = CUSTOM_PINS.filter(cp => cp.id !== editingPinId);
    saveCustomPins(CUSTOM_PINS);
    location.reload();
  });

  applyFilters();
  prefetchClimateData();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
