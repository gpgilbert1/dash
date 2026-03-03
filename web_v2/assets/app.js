'use strict';

/* ============================================================
   DRUG HEATMAP — Vanilla JS
   Leaflet + leaflet-heat + PapaParse
   Serve with: python3 -m http.server 8080
   ============================================================ */

/* ── CONFIG ─────────────────────────────────────────────── */
const CSV_OLD    = '../dash/streetsafe_results.csv';
const CSV_NEW    = '../dash/streetsafe_results_new.csv';
const CSV_CITIES = '../dash/uscities.csv';

const TOP_N         = 50;
const HEAT_RADIUS   = 28;
const HEAT_BLUR     = 20;
const FORCE_INCLUDE = new Set(['medetomidine', 'nitazene']);
const EXCLUDE_QTS   = new Set([Date.UTC(2026, 9, 1)]);

// Inferno-style gradient for "all substances" view
const HEAT_GRADIENT = {
  0.00: '#100000',
  0.12: '#4d0000',
  0.32: '#ff2010',
  0.55: '#ff9500',
  0.78: '#ffe000',
  1.00: '#ffffff',
};

// Per-substance color palette — anchored in WiseBatch brand blues
const PALETTE = [
  '#2271b1', // WiseBatch primary blue
  '#4899d4', // WiseBatch light blue
  '#025b97', // WiseBatch dark blue
  '#48cae4', // bright teal-blue
  '#5b9bd5', // cornflower
  '#f4a261', // warm orange (complementary)
  '#90e0ef', // pale sky
  '#e76f51', // coral
  '#a8dadc', // soft teal
  '#f7b731', // amber
  '#6c8ebf', // periwinkle
  '#2a9d8f', // teal green
  '#e9c46a', // golden yellow
  '#9b5de5', // purple
  '#80b918', // lime
];

/* ── STATE ──────────────────────────────────────────────── */
const S = {
  rows:        [],
  topSubs:     [],
  quarters:    [],
  selected:    new Set(),
  showAll:     false,
  quarterIdx:  0,
  heatLayers:  new Map(),   // substance → L.heatLayer (per-substance view)
  singleLayer: null,        // single Inferno layer (all-substances view)
  map:         null,
};

/* ── UTILITIES ──────────────────────────────────────────── */

function norm(s) {
  if (s == null) return '';
  return String(s).trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+county$/i, '');
}

function parseSubstances(raw) {
  if (!raw) return [];
  const s = raw.trim();
  if (!s || s === '[]') return [];
  try {
    const parsed = JSON.parse(s.replace(/'/g, '"'));
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    const quoted = s.match(/'[^']*'|"[^"]*"/g);
    if (quoted) return quoted.map(t => t.slice(1, -1).trim()).filter(Boolean);
    return s.replace(/[\[\]'"]/g, '').split(',').map(t => t.trim()).filter(Boolean);
  }
}

function quarterTs(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const m = Math.floor(d.getMonth() / 3) * 3;
  return Date.UTC(d.getFullYear(), m, 1);
}

function quarterLabel(ts) {
  const d = new Date(ts);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()} Q${q}`;
}

function fmt(n) { return Number(n).toLocaleString(); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ── COLOR HELPERS ──────────────────────────────────────── */

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Per-substance heatmap gradient: transparent → color → white-hot */
function makeGradient(hex) {
  const [r, g, b] = hexToRgb(hex);
  return {
    0.00: 'rgba(0,0,0,0)',
    0.20: `rgba(${r},${g},${b},0.35)`,
    0.55: hex,
    1.00: '#ffffff',
  };
}

/** Stable color per substance based on its index in the sorted topSubs list */
function substanceColor(sub) {
  const idx = S.topSubs.indexOf(sub);
  return PALETTE[((idx % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

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

  for (const r of raw) {
    const ts = quarterTs(r.sample_date);
    if (!ts || EXCLUDE_QTS.has(ts)) continue;

    const cityKey = norm(r.city) + '|' + norm(r.state);
    const coords  = cityMap.get(cityKey);
    if (!coords) continue;

    for (const sub of parseSubstances(r.substances)) {
      const s = norm(sub);
      if (!s) continue;
      rows.push({ lat: coords.lat, lng: coords.lng, substance: s, quarterTs: ts });
      substCounts.set(s, (substCounts.get(s) || 0) + 1);
    }
  }

  const sorted = [...substCounts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, TOP_N).map(([s]) => s);
  for (const f of FORCE_INCLUDE) {
    if (substCounts.has(f) && !top.includes(f)) top.push(f);
  }

  // Sort alphabetically for the dropdown
  top.sort((a, b) => a.localeCompare(b));

  const quarters = [...new Set(rows.map(r => r.quarterTs))]
    .filter(q => !EXCLUDE_QTS.has(q))
    .sort((a, b) => a - b);

  return { rows, topSubs: top, quarters };
}

/* ── MAP ────────────────────────────────────────────────── */

function initMap() {
  S.map = L.map('map', { center: [39.5, -98.35], zoom: 4, zoomControl: true });

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

/** Count occurrences per lat/lng key */
function aggregate(rows) {
  const agg = new Map();
  for (const r of rows) {
    const key = r.lat + ',' + r.lng;
    agg.set(key, (agg.get(key) || 0) + 1);
  }
  return agg;
}

/** Convert aggregation map → normalized [lat, lng, intensity] array */
function toPoints(agg) {
  const maxVal = Math.max(...agg.values(), 1);
  const pts = [];
  agg.forEach((count, key) => {
    const [lat, lng] = key.split(',').map(Number);
    pts.push([lat, lng, count / maxVal]);
  });
  return pts;
}

function updateHeatmap() {
  const rows = filterRows();

  if (S.selected.size === 0) {
    /* ── All substances: one Inferno layer ── */
    S.heatLayers.forEach(l => S.map.removeLayer(l));
    S.heatLayers.clear();

    const agg = aggregate(rows);
    const pts = toPoints(agg);

    if (S.singleLayer) {
      S.singleLayer.setLatLngs(pts);
    } else {
      S.singleLayer = L.heatLayer(pts, {
        radius: HEAT_RADIUS, blur: HEAT_BLUR, maxZoom: 12,
        gradient: HEAT_GRADIENT, minOpacity: 0.25,
      }).addTo(S.map);
    }

    document.getElementById('stat-samples').textContent = fmt(rows.length);
    document.getElementById('stat-locs').textContent    = fmt(agg.size);

  } else {
    /* ── Per-substance: one colored layer each ── */
    if (S.singleLayer) { S.map.removeLayer(S.singleLayer); S.singleLayer = null; }

    // Group rows by substance
    const bySubstance = new Map();
    for (const r of rows) {
      if (!bySubstance.has(r.substance)) bySubstance.set(r.substance, []);
      bySubstance.get(r.substance).push(r);
    }

    // Remove layers for substances no longer selected
    S.heatLayers.forEach((layer, sub) => {
      if (!bySubstance.has(sub)) { S.map.removeLayer(layer); S.heatLayers.delete(sub); }
    });

    // Update or create a layer per substance
    bySubstance.forEach((subRows, sub) => {
      const pts = toPoints(aggregate(subRows));
      if (S.heatLayers.has(sub)) {
        S.heatLayers.get(sub).setLatLngs(pts);
      } else {
        S.heatLayers.set(sub, L.heatLayer(pts, {
          radius: HEAT_RADIUS, blur: HEAT_BLUR, maxZoom: 12,
          gradient: makeGradient(substanceColor(sub)),
          minOpacity: 0.25,
        }).addTo(S.map));
      }
    });

    // Stats across all selected substances combined
    const allAgg = aggregate(rows);
    document.getElementById('stat-samples').textContent = fmt(rows.length);
    document.getElementById('stat-locs').textContent    = fmt(allAgg.size);
  }
}

/* ── MULTI-SELECT ───────────────────────────────────────── */

const MS = {
  options:  [],
  selected: new Set(),
  isOpen:   false,
};

function msRenderItems(query) {
  const q = query.toLowerCase();
  const filtered = q ? MS.options.filter(o => o.includes(q)) : MS.options;

  document.getElementById('ms-items').innerHTML = filtered.map(val => {
    const checked = MS.selected.has(val);
    const color   = substanceColor(val);
    const cbStyle = checked ? `background:${color};border-color:${color}` : '';
    return `<div class="ms-item${checked ? ' is-checked' : ''}" data-val="${val}"
                 role="option" aria-selected="${checked}">
              <span class="ms-cb" style="${cbStyle}"></span>
              <span class="ms-dot" style="background:${color}"></span>
              <span class="ms-item-label">${cap(val)}</span>
            </div>`;
  }).join('');
}

function msRenderChips() {
  const sel = [...MS.selected];
  const MAX = 3;
  let html = sel.slice(0, MAX).map(v => {
    const color    = substanceColor(v);
    const [r,g,b]  = hexToRgb(color);
    return `<span class="ms-chip" style="background:rgba(${r},${g},${b},0.12);border-color:rgba(${r},${g},${b},0.3);color:${color}">
               <span>${cap(v)}</span>
               <button class="ms-chip-x" data-val="${v}" aria-label="Remove ${cap(v)}">×</button>
             </span>`;
  }).join('');
  if (sel.length > MAX) {
    html += `<span class="ms-chip ms-chip-more">+${sel.length - MAX}</span>`;
  }
  document.getElementById('ms-chips').innerHTML = html;
  document.getElementById('ms-input').placeholder = sel.length ? '' : 'All substances…';
}

function msOpen() {
  if (MS.isOpen) return;
  MS.isOpen = true;
  document.getElementById('ms-panel').hidden = false;
  document.getElementById('ms-wrap').classList.add('is-open');
  document.getElementById('ms-trigger').setAttribute('aria-expanded', 'true');
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
  MS.options  = options;
  MS.selected = new Set([options[0]]);
  S.selected  = MS.selected;

  const wrap    = document.getElementById('ms-wrap');
  const trigger = document.getElementById('ms-trigger');
  const chips   = document.getElementById('ms-chips');
  const input   = document.getElementById('ms-input');
  const panel   = document.getElementById('ms-panel');

  msRenderChips();

  trigger.addEventListener('mousedown', e => {
    if (e.target.closest('.ms-chip-x') || e.target === input) return;
    e.preventDefault();
    MS.isOpen ? msClose() : msOpen();
  });

  input.addEventListener('focus', () => msOpen());

  input.addEventListener('input', () => {
    if (!MS.isOpen) msOpen();
    msRenderItems(input.value);
  });

  panel.addEventListener('mousedown', e => {
    e.preventDefault();
    const item = e.target.closest('.ms-item');
    if (item) { msToggle(item.dataset.val); return; }
  });

  chips.addEventListener('mousedown', e => {
    e.preventDefault();
    const x = e.target.closest('.ms-chip-x');
    if (x) msToggle(x.dataset.val);
  });

  document.getElementById('ms-select-all').addEventListener('click', e => {
    e.preventDefault();
    MS.options.forEach(o => MS.selected.add(o));
    S.selected = MS.selected;
    msRenderChips();
    msRenderItems(input.value);
    updateHeatmap();
  });

  document.getElementById('ms-clear').addEventListener('click', e => {
    e.preventDefault();
    MS.selected.clear();
    S.selected = MS.selected;
    msRenderChips();
    msRenderItems(input.value);
    updateHeatmap();
  });

  document.addEventListener('mousedown', e => {
    if (!wrap.contains(e.target)) msClose();
  });

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

  const markIdxs = new Set([0, quarters.length - 1]);
  quarters.forEach((ts, i) => {
    if (new Date(ts).getUTCMonth() === 0) markIdxs.add(i);
  });

  markRow.innerHTML = '';
  [...markIdxs].sort((a, b) => a - b).forEach(i => {
    const pct  = quarters.length > 1 ? (i / (quarters.length - 1)) * 100 : 0;
    const tick = document.createElement('span');
    tick.className    = 'mark-tick';
    tick.style.left   = pct + '%';
    tick.textContent  = quarterLabel(quarters[i]).replace(' ', '\n');
    markRow.appendChild(tick);
  });

  render();
}

/* ── ALL-TIME TOGGLE ────────────────────────────────────── */

function initToggle() {
  const cb    = document.getElementById('all-time-cb');
  const block = document.getElementById('quarter-block');

  // Default: showAll = false, quarter slider visible
  S.showAll = false;
  block.setAttribute('aria-hidden', 'false');

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
    const { rows, topSubs, quarters } = await loadData();

    S.rows     = rows;
    S.topSubs  = topSubs;
    S.quarters = quarters;

    initMultiSelect(topSubs);
    initSlider(quarters);
    initToggle();
    updateHeatmap();

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
