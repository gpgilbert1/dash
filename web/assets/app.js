'use strict';

/* ============================================================
   DRUG HEATMAP — Vanilla JS
   Leaflet + leaflet-heat + PapaParse
   Serve with: python3 -m http.server 8080
   ============================================================ */

/* ── CONFIG ─────────────────────────────────────────────── */
const CSV_OLD    = 'dash/streetsafe_results.csv';
const CSV_NEW    = 'dash/streetsafe_results_new.csv';
const CSV_CITIES = 'dash/uscities.csv';

const TOP_N         = 50;
const HEAT_RADIUS   = 28;
const HEAT_BLUR     = 20;
const FORCE_INCLUDE = new Set(['medetomidine', 'nitazene']);
// Exclude Q4-2026 artifact (same as Python version)
const EXCLUDE_QTS   = new Set([Date.UTC(2026, 9, 1)]);

/* Per-substance heat gradients — tuned for dark map backgrounds.
   Jump to full saturation quickly; avoid white endpoints that wash out hue. */
const GRADIENTS = {
  fentanyl: {
    0.00: '#000814',
    0.25: '#0044cc',
    0.55: '#0088ff',
    0.80: '#44bbff',
    1.00: '#aaddff',
  },
  medetomidine: {
    0.00: '#050300',
    0.25: '#2a1c0c',
    0.55: '#4c3418',
    0.80: '#6a4a24',
    1.00: '#886038',
  },
  xylazine: {
    0.00: '#100500',
    0.25: '#992200',
    0.55: '#ff5500',
    0.80: '#ff9944',
    1.00: '#ffcc88',
  },
  benzo: {
    0.00: '#001400',
    0.25: '#006600',
    0.55: '#00cc33',
    0.80: '#44ee66',
    1.00: '#aaffcc',
  },
  default: {
    0.00: '#100000',
    0.20: '#660000',
    0.45: '#ff2010',
    0.70: '#ff8800',
    1.00: '#ffee44',
  },
  all: {
    0.00: '#000510',
    0.25: '#000e2a',
    0.55: '#001a55',
    0.80: '#002a88',
    1.00: '#0040bb',
  },
};

/** Benzodiazepine detection: match azolam/azepam/midazol in normalized name */
function isBenzo(sub) {
  return /azolam|azepam|midazol/.test(sub);
}

/** Map a normalized substance name to a gradient category */
function substanceCategory(sub) {
  if (sub === 'fentanyl')      return 'fentanyl';
  if (sub === 'medetomidine')  return 'medetomidine';
  if (sub === 'xylazine')      return 'xylazine';
  if (isBenzo(sub))            return 'benzo';
  return 'default';
}

/* ── STATE ──────────────────────────────────────────────── */
const S = {
  rows:         [],   // { lat, lng, substance, quarterTs }[]
  topSubs:      [],   // string[] (top N, display order)
  quarters:     [],   // number[] timestamps, sorted asc
  selected:     new Set(),
  showAll:      true,
  quarterIdx:   0,
  heatLayers:   {},   // { category: L.heatLayer }
  tooltipLayer: null,
  coordLabels:  new Map(), // "lat,lng" → "City, State"
  map:          null,
};

/* ── UTILITIES ──────────────────────────────────────────── */

/** Lowercase + strip diacritics + collapse whitespace + remove " county" */
function norm(s) {
  if (s == null) return '';
  return String(s).trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+county$/i, '');
}

/** Parse Python list literal → string array */
function parseSubstances(raw) {
  if (!raw) return [];
  const s = raw.trim();
  if (!s || s === '[]') return [];
  // Try JSON after swapping single → double quotes
  try {
    const parsed = JSON.parse(s.replace(/'/g, '"'));
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    // Fallback: extract quoted tokens, then bare comma-split
    const quoted = s.match(/'[^']*'|"[^"]*"/g);
    if (quoted) return quoted.map(t => t.slice(1, -1).trim()).filter(Boolean);
    return s.replace(/[\[\]'"]/g, '').split(',').map(t => t.trim()).filter(Boolean);
  }
}

/** date-string → UTC quarter-start timestamp (ms) */
function quarterTs(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const m = Math.floor(d.getMonth() / 3) * 3;
  return Date.UTC(d.getFullYear(), m, 1);
}

/** UTC quarter timestamp → "2024 Q3" */
function quarterLabel(ts) {
  const d = new Date(ts);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()} Q${q}`;
}

/** Locale-format number with commas */
function fmt(n) { return Number(n).toLocaleString(); }

/** Capitalize first letter */
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ── DATA LOADING ───────────────────────────────────────── */

function parseCsv(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: r => resolve(r.data),
      error: err => reject(new Error(`CSV load failed: ${url} — ${err.message}`)),
    });
  });
}

async function loadData() {
  const [old, newer, cities] = await Promise.all([
    parseCsv(CSV_OLD),
    parseCsv(CSV_NEW),
    parseCsv(CSV_CITIES),
  ]);
  return processData([...old, ...newer], cities);
}

function processData(raw, citiesRaw) {
  /* Build city lookup: "city_norm|state_norm" → { lat, lng }
     Sort by population desc so the largest match wins on duplicate (city, state) */
  const cityMap = new Map();
  const sortedCities = citiesRaw.slice().sort(
    (a, b) => (Number(b.population) || 0) - (Number(a.population) || 0)
  );
  for (const c of sortedCities) {
    const key = norm(c.city) + '|' + norm(c.state_name);
    if (!cityMap.has(key)) {
      const lat = parseFloat(c.lat), lng = parseFloat(c.lng);
      if (!isNaN(lat) && !isNaN(lng)) cityMap.set(key, { lat, lng });
    }
  }

  const rows = [];
  const substCounts = new Map();
  const coordLabels = new Map();

  for (const r of raw) {
    const ts = quarterTs(r.sample_date);
    if (!ts || EXCLUDE_QTS.has(ts)) continue;

    const cityKey = norm(r.city) + '|' + norm(r.state);
    const coords  = cityMap.get(cityKey);
    if (!coords) continue;

    const coordKey = coords.lat + ',' + coords.lng;
    if (!coordLabels.has(coordKey)) {
      coordLabels.set(coordKey, cap(r.city.trim()) + ', ' + cap(r.state.trim()));
    }

    for (const sub of parseSubstances(r.substances)) {
      const s = norm(sub);
      if (!s) continue;
      rows.push({ lat: coords.lat, lng: coords.lng, substance: s, quarterTs: ts });
      substCounts.set(s, (substCounts.get(s) || 0) + 1);
    }
  }

  /* Top N substances by count, with forced inclusions, then sorted alphabetically */
  const sorted = [...substCounts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, TOP_N).map(([s]) => s);
  for (const f of FORCE_INCLUDE) {
    if (substCounts.has(f) && !top.includes(f)) top.push(f);
  }
  top.sort((a, b) => a.localeCompare(b));

  /* Unique quarters, sorted, excluding known artifacts */
  const quarters = [...new Set(rows.map(r => r.quarterTs))]
    .filter(q => !EXCLUDE_QTS.has(q))
    .sort((a, b) => a - b);

  return { rows, topSubs: top, quarters, coordLabels };
}

/* ── MAP ────────────────────────────────────────────────── */

function initMap() {
  const isMobile = window.innerWidth <= 560;
  S.map = L.map('map', {
    center: [39.5, -98.35],
    zoom: isMobile ? 2 : 4,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> ' +
                 '&copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(S.map);
}

/* ── HEATMAP ────────────────────────────────────────────── */

function filterRows() {
  let rows = S.rows;
  if (S.selected.size > 0) {
    rows = rows.filter(r => S.selected.has(r.substance));
  }
  if (!S.showAll && S.quarters.length > 0) {
    const q = S.quarters[S.quarterIdx];
    rows = rows.filter(r => r.quarterTs === q);
  }
  return rows;
}

function updateHeatmap() {
  const rows = filterRows();

  /* Group rows by substance category, aggregate by lat/lng per group.
     When nothing is selected, collapse everything into a single dark-blue layer. */
  const groups = {};
  const noSelection = S.selected.size === 0;
  for (const r of rows) {
    const cat = noSelection ? 'all' : substanceCategory(r.substance);
    if (!groups[cat]) groups[cat] = new Map();
    const key = r.lat + ',' + r.lng;
    groups[cat].set(key, (groups[cat].get(key) || 0) + 1);
  }

  /* Remove layers for categories no longer in the filtered set */
  for (const [cat, layer] of Object.entries(S.heatLayers)) {
    if (!groups[cat]) {
      S.map.removeLayer(layer);
      delete S.heatLayers[cat];
    }
  }

  /* Create or update one heat layer per category (each normalized independently) */
  for (const [cat, agg] of Object.entries(groups)) {
    const maxVal = Math.max(...agg.values(), 1);
    const points = [];
    agg.forEach((count, key) => {
      const [lat, lng] = key.split(',').map(Number);
      points.push([lat, lng, count / maxVal]);
    });

    if (S.heatLayers[cat]) {
      S.heatLayers[cat].setLatLngs(points);
    } else {
      S.heatLayers[cat] = L.heatLayer(points, {
        radius: HEAT_RADIUS,
        blur:   HEAT_BLUR,
        maxZoom: 12,
        gradient: GRADIENTS[cat] || GRADIENTS.default,
        minOpacity: 0.25,
      }).addTo(S.map);
    }
  }

  /* Stats */
  const allLocs = new Set(rows.map(r => r.lat + ',' + r.lng));
  document.getElementById('stat-samples').textContent = fmt(rows.length);
  document.getElementById('stat-locs').textContent    = fmt(allLocs.size);

  /* Tooltip markers — invisible SVG circles (markerPane) that intercept hover
     events and display sample counts for each city location. */
  const locCounts = new Map();
  for (const [, agg] of Object.entries(groups)) {
    agg.forEach((count, key) => {
      locCounts.set(key, (locCounts.get(key) || 0) + count);
    });
  }

  if (!S.tooltipLayer) S.tooltipLayer = L.layerGroup().addTo(S.map);
  S.tooltipLayer.clearLayers();

  locCounts.forEach((count, key) => {
    const [lat, lng] = key.split(',').map(Number);
    const loc = S.coordLabels.get(key);
    const tip = (loc ? `<span class="ht-loc">${loc}</span>` : '') +
                `<span class="ht-cnt">${fmt(count)}&thinsp;sample${count !== 1 ? 's' : ''}</span>`;
    L.circleMarker([lat, lng], {
      radius: 20,
      stroke: false,
      fillColor: '#000',
      fillOpacity: 0.001,
      interactive: true,
      pane: 'markerPane',
    }).bindTooltip(tip, {
      sticky: true,
      className: 'heat-tooltip',
      direction: 'top',
      offset: [0, -4],
    }).addTo(S.tooltipLayer);
  });
}

/* ── MULTI-SELECT ───────────────────────────────────────── */

const MS = {
  options:  [],    // all substance strings
  selected: new Set(),
  isOpen:   false,
};

/** Build + inject item HTML into the list panel */
function msRenderItems(query) {
  const q = query.toLowerCase();
  const filtered = q
    ? MS.options.filter(o => o.includes(q))
    : MS.options;

  document.getElementById('ms-items').innerHTML = filtered.map(val => {
    const checked = MS.selected.has(val);
    return `<div class="ms-item${checked ? ' is-checked' : ''}" data-val="${val}"
                 role="option" aria-selected="${checked}">
              <span class="ms-cb"></span>
              <span class="ms-item-label">${cap(val)}</span>
            </div>`;
  }).join('');
}

/** Rebuild the pill chips in the trigger */
function msRenderChips() {
  const sel = [...MS.selected];
  const MAX = 3;
  let html = sel.slice(0, MAX).map(v =>
    `<span class="ms-chip">
       <span>${cap(v)}</span>
       <button class="ms-chip-x" data-val="${v}" aria-label="Remove ${cap(v)}">×</button>
     </span>`
  ).join('');
  if (sel.length > MAX) {
    html += `<span class="ms-chip ms-chip-more">+${sel.length - MAX}</span>`;
  }
  document.getElementById('ms-chips').innerHTML = html;
  document.getElementById('ms-input').placeholder = sel.length ? '' : 'All substances…';
}

function msOpen() {
  if (MS.isOpen) return;
  MS.isOpen = true;
  const panel   = document.getElementById('ms-panel');
  const trigger = document.getElementById('ms-trigger');
  panel.hidden  = false;
  document.getElementById('ms-wrap').classList.add('is-open');
  trigger.setAttribute('aria-expanded', 'true');
  msRenderItems(document.getElementById('ms-input').value);
  document.getElementById('ms-input').focus();
}

function msClose() {
  if (!MS.isOpen) return;
  MS.isOpen = false;
  document.getElementById('ms-panel').hidden = true;
  document.getElementById('ms-wrap').classList.remove('is-open');
  document.getElementById('ms-trigger').setAttribute('aria-expanded', 'false');
  document.getElementById('ms-input').value = '';
}

function msToggle(val) {
  MS.selected.has(val) ? MS.selected.delete(val) : MS.selected.add(val);
  S.selected = MS.selected;
  msRenderChips();
  msRenderItems(document.getElementById('ms-input').value);
  updateHeatmap();
}

function initMultiSelect(options) {
  MS.options   = options;
  MS.selected  = new Set([options.includes('fentanyl') ? 'fentanyl' : options[0]]); // default: fentanyl
  S.selected   = MS.selected;

  const wrap    = document.getElementById('ms-wrap');
  const trigger = document.getElementById('ms-trigger');
  const chips   = document.getElementById('ms-chips');
  const input   = document.getElementById('ms-input');
  const panel   = document.getElementById('ms-panel');

  msRenderChips();

  /* Open on trigger click (not on input or chip-x) */
  trigger.addEventListener('mousedown', e => {
    if (e.target.closest('.ms-chip-x') || e.target === input) return;
    e.preventDefault();
    MS.isOpen ? msClose() : msOpen();
  });

  /* Open on input focus */
  input.addEventListener('focus', () => msOpen());

  /* Filter list while typing */
  input.addEventListener('input', () => {
    if (!MS.isOpen) msOpen();
    msRenderItems(input.value);
  });

  /* Toggle item on click */
  panel.addEventListener('mousedown', e => {
    e.preventDefault();
    const item = e.target.closest('.ms-item');
    if (item) { msToggle(item.dataset.val); return; }
  });

  /* Remove chip via × button */
  chips.addEventListener('mousedown', e => {
    e.preventDefault();
    const x = e.target.closest('.ms-chip-x');
    if (x) msToggle(x.dataset.val);
  });

  /* Select all */
  document.getElementById('ms-select-all').addEventListener('click', e => {
    e.preventDefault();
    MS.options.forEach(o => MS.selected.add(o));
    S.selected = MS.selected;
    msRenderChips();
    msRenderItems(input.value);
    updateHeatmap();
  });

  /* Clear all */
  document.getElementById('ms-clear').addEventListener('click', e => {
    e.preventDefault();
    MS.selected.clear();
    S.selected = MS.selected;
    msRenderChips();
    msRenderItems(input.value);
    updateHeatmap();
  });

  /* Close on outside click */
  document.addEventListener('mousedown', e => {
    if (!wrap.contains(e.target)) msClose();
  });

  /* Keyboard: Esc to close, Enter/Space to toggle */
  trigger.addEventListener('keydown', e => {
    if (e.key === 'Escape') { msClose(); trigger.focus(); }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); MS.isOpen ? msClose() : msOpen(); }
  });
}

/* ── QUARTER SLIDER ─────────────────────────────────────── */

function updateSliderTrack(slider) {
  const pct = slider.max > slider.min
    ? ((slider.value - slider.min) / (slider.max - slider.min)) * 100
    : 100;
  slider.style.background =
    `linear-gradient(to right, var(--accent-cyan) ${pct}%, var(--border) ${pct}%)`;
}

function initSlider(quarters) {
  const slider  = document.getElementById('quarter-range');
  const display = document.getElementById('quarter-val');
  const markRow = document.getElementById('mark-row');

  slider.max   = quarters.length - 1;
  slider.value = quarters.length - 1;
  S.quarterIdx = quarters.length - 1;

  function render() {
    display.textContent = quarterLabel(quarters[S.quarterIdx]);
    updateSliderTrack(slider);
  }

  slider.addEventListener('input', () => {
    S.quarterIdx = Number(slider.value);
    render();
    updateHeatmap();
  });

  /* Build year marks */
  const markIdxs = new Set([0, quarters.length - 1]);
  quarters.forEach((ts, i) => {
    if (new Date(ts).getUTCMonth() === 0) markIdxs.add(i); // January = Q1
  });

  markRow.innerHTML = '';
  [...markIdxs].sort((a, b) => a - b).forEach(i => {
    const pct = quarters.length > 1 ? (i / (quarters.length - 1)) * 100 : 0;
    const tick = document.createElement('span');
    tick.className = 'mark-tick';
    tick.style.left = pct + '%';
    tick.textContent = quarterLabel(quarters[i]).replace(' ', '\n');
    markRow.appendChild(tick);
  });

  render();
}

/* ── ALL-TIME TOGGLE ────────────────────────────────────── */

function initToggle() {
  const cb    = document.getElementById('all-time-cb');
  const block = document.getElementById('quarter-block');

  /* Initial state: checked = show all → hide slider */
  block.classList.add('hidden');
  block.setAttribute('aria-hidden', 'true');

  cb.addEventListener('change', () => {
    S.showAll = cb.checked;
    block.classList.toggle('hidden', cb.checked);
    block.setAttribute('aria-hidden', String(cb.checked));
    updateHeatmap();
  });
}

/* ── BOOTSTRAP ──────────────────────────────────────────── */

async function init() {
  initMap();

  try {
    const { rows, topSubs, quarters, coordLabels } = await loadData();

    S.rows        = rows;
    S.quarters    = quarters;
    S.coordLabels = coordLabels;

    initMultiSelect(topSubs);
    initSlider(quarters);
    initToggle();
    updateHeatmap();

    /* Fade out loading screen */
    const screen = document.getElementById('load-screen');
    screen.classList.add('fade-out');
    screen.addEventListener('transitionend', () => screen.remove(), { once: true });

  } catch (err) {
    console.error(err);
    const screen = document.getElementById('load-screen');
    screen.querySelector('.load-ring').remove();
    screen.querySelector('.load-text').remove();
    const msg = document.createElement('div');
    msg.className = 'load-error';
    msg.innerHTML =
      `Could not load CSV data.<br>Open this folder with a local server:<br>` +
      `<code>python3 -m http.server 8080</code>` +
      `<br><br><small style="color:var(--text-lo)">${err.message}</small>`;
    screen.appendChild(msg);
  }
}

document.addEventListener('DOMContentLoaded', init);
