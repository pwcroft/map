// ============================================================
// Camp Travel Map — app logic
// ============================================================

const PLEASANTON = { lat: 37.6624, lng: -121.8747 };
const EDITS_KEY = 'campapp_edits_v1';
const CUSTOM_PINS_KEY = 'campapp_custom_pins_v1';

const SEASON_MONTHS = {
  Spring: ['Mar', 'Apr', 'May'],
  Summer: ['Jun', 'Jul', 'Aug'],
  Fall: ['Sep', 'Oct', 'Nov'],
  Winter: ['Dec', 'Jan', 'Feb']
};

const CATEGORY_ORDER = ['Camping', 'Sites / Hikes', 'Food & Drink', 'Adventures'];
const CAMPING_SUBCATS = ['Public', 'Private', 'Boondocking'];
const SITESHIKES_SUBCATS = ['State / Nat Parks', 'Points of Interest', 'Hikes', 'Scenic Drives', 'Sites', 'Hot Springs', 'Swim Area'];
const FOODDRINK_SUBCATS = ['Food', 'Drinks'];

const CATEGORY_COLORS = {
  'Camping': '#2f5233',
  'Sites / Hikes': '#8b6f47',
  'Food & Drink': '#b5493b',
  'Adventures': '#2a5d8c'
};

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
  siteshikesSubcats: new Set(),
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

function getBestMonths(p) {
  if (p.best_seasons && p.best_seasons.length) {
    const months = new Set();
    p.best_seasons.forEach(s => (SEASON_MONTHS[s] || []).forEach(m => months.add(m)));
    return Array.from(months);
  }
  if (p.area && AREAS[p.area] && AREAS[p.area].months_that_pass) {
    return AREAS[p.area].months_that_pass;
  }
  return null;
}

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
  if (p.category === 'Sites / Hikes' && filters.siteshikesSubcats.size && !filters.siteshikesSubcats.has(p.subcategory)) return false;
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
  map = L.map('map', { preferCanvas: true }).setView([39.5, -119], 6);
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
    const color = CATEGORY_COLORS[p.category] || '#555';
    const marker = L.circleMarker([p.lat, p.lng], {
      radius: 6,
      color: color,
      fillColor: color,
      fillOpacity: 0.85,
      weight: 1.5
    });
    marker.bindTooltip(p.name, { direction: 'top', offset: [0, -4] });
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
function buildDetailHtml(p) {
  const bestMonths = getBestMonths(p) || [];
  const rows = [];

  rows.push('<h2>' + escapeHtml(p.name) + '</h2>');
  rows.push('<div class="detail-badges">' + badgesHtml(p) + '</div>');
  rows.push('<div class="field-row"><label>Category</label><div class="field-static">' + escapeHtml(p.category + (p.subcategory ? ' · ' + p.subcategory : '')) + '</div></div>');
  rows.push('<div class="field-row"><label>State</label><div class="field-static">' + escapeHtml(p.state || '—') + '</div></div>');
  if (p.area) rows.push('<div class="field-row"><label>Area</label><div class="field-static">' + escapeHtml(p.area) + '</div></div>');
  rows.push('<div class="field-row"><label>Distance from Pleasanton</label><div class="field-static">' +
    (p.driving_miles_from_pleasanton != null
      ? Math.round(p.driving_miles_from_pleasanton) + ' mi (~' + Math.round(p.driving_minutes_from_pleasanton / 6) / 10 + ' hr drive)'
      : 'Not computed (likely over 400mi)') + '</div></div>');
  if (bestMonths.length) rows.push('<div class="field-row"><label>Best months</label><div class="field-static">' + bestMonths.join(', ') + '</div></div>');
  if (p.category === 'Camping' && p.nearest_town_name) {
    rows.push('<div class="field-row"><label>Nearest town</label><div class="field-static">' + escapeHtml(p.nearest_town_name) + ' (' + p.nearest_town_miles + ' mi' + (p.near_town ? ', within 10mi' : '') + ')</div></div>');
  }
  if (p.park_type) rows.push('<div class="field-row"><label>Park type</label><div class="field-static">' + escapeHtml(p.park_type) + '</div></div>');
  if (p.reservation_timing) rows.push('<div class="field-row"><label>Reservation timing</label><div class="field-static">' + escapeHtml(p.reservation_timing) + '</div></div>');
  if (p.max_nights_stay || p.max_nights_year) {
    const bits = [];
    if (p.max_nights_stay) bits.push(p.max_nights_stay + ' nights per stay');
    if (p.max_nights_year) bits.push(p.max_nights_year + ' nights per year');
    rows.push('<div class="field-row"><label>Max nights</label><div class="field-static">' + escapeHtml(bits.join(' / ')) + '</div></div>');
  }

  if (p.nearby_alltrails_hikes && p.nearby_alltrails_hikes.length) {
    const hikeRows = p.nearby_alltrails_hikes
      .slice()
      .sort((a, b) => b.rating - a.rating)
      .map(h =>
        '<div class="list-card" style="cursor:default;">' +
          '<div class="list-card-main">' +
            '<div class="list-card-name">' + escapeHtml(h.name) + '</div>' +
            '<div class="list-card-meta">★' + h.rating + ' · ' + h.length_miles + ' mi · ' + escapeHtml(h.difficulty) + ' · ' + escapeHtml(h.route_type) + ' · ' + h.trailhead_distance_miles + ' mi from campground</div>' +
            '<a href="' + escapeHtml(h.url) + '" target="_blank" rel="noopener">View on AllTrails &rarr;</a>' +
          '</div>' +
        '</div>'
      ).join('');
    rows.push('<div class="field-row"><label>Top-rated hikes nearby (AllTrails, 4.8★+)</label>' + hikeRows + '</div>');
  }

  rows.push('<div class="toggle-row"><span>' + (p.is_campground ? 'Visited' : 'Done') + '</span>' +
    '<input type="checkbox" id="detail-status-toggle" ' + ((p.is_campground ? p.visited : p.done) ? 'checked' : '') + '></div>');

  rows.push('<div class="field-row"><label>Price per night ($)</label><input type="number" id="detail-price" min="0" value="' + (p.price_usd != null ? p.price_usd : '') + '"></div>');
  rows.push('<div class="field-row"><label>Hookups</label><input type="text" id="detail-hookups" value="' + escapeHtml((p.hookup_types || []).join(', ')) + '" placeholder="e.g. FHU, W&E, Dry"></div>');
  rows.push('<div class="field-row"><label>Website / booking URL</label><input type="text" id="detail-url" value="' + escapeHtml(p.url || '') + '"></div>');
  rows.push('<div class="field-row"><label>Notes / best sites</label><textarea id="detail-notes">' + escapeHtml(p.notes || '') + '</textarea></div>');

  rows.push('<button id="detail-save-btn" class="primary-btn">Save changes</button>');
  rows.push('<button id="detail-nearby-btn" class="secondary-btn">Find campgrounds/sites near this pin</button>');
  if (p.is_custom) {
    rows.push('<button id="detail-edit-pin-btn" class="secondary-btn">Edit name / category / location</button>');
    rows.push('<button id="detail-delete-pin-btn" class="secondary-btn" style="color:#b5493b;">Delete this pin</button>');
  }

  return rows.join('');
}

function wireDetailEvents(p) {
  document.getElementById('detail-save-btn').onclick = () => {
    const fields = {};
    const priceVal = document.getElementById('detail-price').value;
    fields.price_usd = priceVal === '' ? null : parseFloat(priceVal);
    const hookupsRaw = document.getElementById('detail-hookups').value;
    fields.hookup_types = hookupsRaw.split(',').map(s => s.trim()).filter(Boolean);
    const urlVal = document.getElementById('detail-url').value.trim();
    fields.url = urlVal || null;
    fields.notes = document.getElementById('detail-notes').value;
    const statusChecked = document.getElementById('detail-status-toggle').checked;
    if (p.is_campground) fields.visited = statusChecked; else fields.done = statusChecked;
    updatePinEdit(p.id, fields);
    closeDetail();
    applyFilters();
  };
  document.getElementById('detail-nearby-btn').onclick = () => {
    closeDetail();
    openDistanceTool({ id: 'custom_' + p.id, label: p.name, lat: p.lat, lng: p.lng, excludeId: p.id });
  };
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
}

function closeDetail() {
  document.getElementById('detail-overlay').classList.add('hidden');
}

// ---------- Distance tool ----------
let customOrigins = {};

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
  document.getElementById('distance-overlay').classList.remove('hidden');
}

function closeDistanceTool() {
  document.getElementById('distance-overlay').classList.add('hidden');
}

async function runDistanceSearch() {
  const originVal = document.getElementById('distance-origin').value;
  const radius = parseFloat(document.getElementById('distance-radius').value) || 50;
  const useDriving = document.getElementById('distance-use-driving').checked;
  const statusEl = document.getElementById('distance-status');
  const resultsEl = document.getElementById('distance-results');
  resultsEl.innerHTML = '';

  let origin;
  if (originVal === 'pleasanton') origin = { lat: PLEASANTON.lat, lng: PLEASANTON.lng, isPleasanton: true };
  else origin = customOrigins[originVal];
  if (!origin) { statusEl.textContent = 'Pick a starting point.'; return; }

  statusEl.textContent = 'Calculating distances...';

  let candidates = allPins()
    .filter(p => !(origin.excludeId && p.id === origin.excludeId))
    .map(p => ({ pin: p, straight: haversineMiles(origin.lat, origin.lng, p.lat, p.lng) }))
    .filter(c => c.straight <= radius * 2)
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

  const within = candidates.filter(c => c.miles <= radius).sort((a, b) => a.miles - b.miles);

  statusEl.textContent = within.length + ' found within ' + radius + ' mi' +
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
}

// ---------- Add / Edit custom pin ----------
let addMap = null;
let addMarker = null;
let addLatLng = null;
let editingPinId = null;

const ADD_SUBCATS = {
  'Camping': CAMPING_SUBCATS,
  'Sites / Hikes': SITESHIKES_SUBCATS,
  'Food & Drink': FOODDRINK_SUBCATS,
  'Adventures': null
};

function populateAddSubcatOptions(category) {
  const row = document.getElementById('add-subcat-row');
  const sel = document.getElementById('add-subcategory');
  const subcats = ADD_SUBCATS[category];
  if (!subcats) {
    row.classList.add('hidden');
    sel.innerHTML = '';
    return;
  }
  row.classList.remove('hidden');
  sel.innerHTML = subcats.map(sc => '<option value="' + escapeHtml(sc) + '">' + escapeHtml(sc) + '</option>').join('');
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
  const subcats = ADD_SUBCATS[category];
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
  filters.siteshikesSubcats.clear();
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
  document.querySelectorAll('#category-filters input, #camping-subfilters input, #siteshikes-subfilters input, #fooddrink-subfilters input')
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
  const payload = { edits: EDITS, customPins: CUSTOM_PINS };
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

      EDITS = Object.assign({}, EDITS, importedEdits);
      saveEdits(EDITS);

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
  buildSubcatFilters('siteshikes-subfilters', SITESHIKES_SUBCATS, 'Sites / Hikes', filters.siteshikesSubcats);
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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
