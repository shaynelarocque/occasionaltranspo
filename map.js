// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_TRAVEL_TIME = 120 * 60;  // seconds — 2 hr max
const LON_SCALE       = 0.702;     // cos(45.4°N) for Ottawa
const AGENCY_COLORS   = { oct: '#D52B1E', sto: '#005DAA' };
const TRANSITION_MS   = 650;

// Geographic grid covering Ottawa–Gatineau region
const GRID_LATS = d3.range(45.15, 45.73, 0.033);
const GRID_LONS = d3.range(-76.06, -75.22, 0.048);

// ─── State ────────────────────────────────────────────────────────────────────
let { stations, lines } = subway;

// Prefer a major O-Train station (they have _stn suffix and short names)
let defaultStop = (
  Object.keys(stations).find(id => id.endsWith('_stn') && /^rideau$/i.test(stations[id].name)) ||
  Object.keys(stations).find(id => id.endsWith('_stn') && /rideau/i.test(stations[id].name))   ||
  Object.keys(stations).find(id => /rideau station/i.test(stations[id].name))                   ||
  Object.keys(stations).find(id => id.endsWith('_stn') && /hurdman/i.test(stations[id].name))  ||
  Object.keys(stations)[0]
);

window.homeStationId    = null;
window.schedule         = 'weekday_rush';
window.travelTimes      = null;
window.gridTravelTimes  = null;  // cached per-node travel times for the distortion grid

// Flat stop array for fast nearest-neighbour search
const _stopArr = Object.keys(stations).map(id => ({ id, lat: stations[id].lat, lon: stations[id].lon }));

// ─── Leaflet Map ──────────────────────────────────────────────────────────────
const OTTAWA_CENTER = [45.422, -75.697];
const lmap = L.map('map', { zoomControl: false }).setView(OTTAWA_CENTER, 12);

const tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
  crossOrigin: 'anonymous'
}).addTo(lmap);

L.control.zoom({ position: 'bottomright' }).addTo(lmap);

// ─── D3 SVG Overlay ───────────────────────────────────────────────────────────
const svgEl     = document.getElementById('d3svg');
const svg       = d3.select(svgEl);
const container = svg.append('g').attr('id', 'scene');

// Grid group rendered first (behind everything)
const gridGroup = container.append('g').attr('class', 'grid-group');

// Time rings (30 min, 1 hr, 2 hr) — visible in travel-time mode
const TIME_RINGS = [
  { seconds: 30 * 60, label: '30 min' },
  { seconds: 60 * 60, label: '1 hr'   },
  { seconds: 120 * 60, label: '2 hr'  },
];
const rings = TIME_RINGS.map(({ seconds, label }) => ({
  seconds,
  halo: container.append('circle').attr('class', 'hour-halo'),
  ring: container.append('circle').attr('class', 'hour'),
  text: container.append('text').attr('class', 'hour-label').text(label),
}));

// ─── Tooltip ──────────────────────────────────────────────────────────────────
const tooltip = document.createElement('div');
tooltip.className = 'tooltip';
tooltip.style.display = 'none';
document.body.appendChild(tooltip);

let hideTooltipPending = false;
function showTooltip(e, stationId) {
  hideTooltipPending = false;
  const s = stations[stationId];
  let html = `<strong>${s.name}</strong>`;
  if (window.travelTimes) {
    const mins = (window.travelTimes[stationId] / 60) | 0;
    const secs = window.travelTimes[stationId] % 60;
    html += `<div class="tt-time">${mins}m ${secs}s away</div>`;
  }
  tooltip.innerHTML = html;
  tooltip.style.display = 'block';
  tooltip.style.left = (e.pageX + 14) + 'px';
  tooltip.style.top  = (e.pageY + 14) + 'px';
}
function hideTooltip() {
  hideTooltipPending = true;
  setTimeout(() => { if (hideTooltipPending) tooltip.style.display = 'none'; }, 120);
}

// ─── Position Helpers ─────────────────────────────────────────────────────────
function isTravelMode() { return !!window.homeStationId && !!window.travelTimes; }

function geoPosition(stationId) {
  const s = stations[stationId];
  const pt = lmap.latLngToContainerPoint([s.lat, s.lon]);
  return { x: pt.x, y: pt.y };
}

function travelPosition(stationId) {
  const W = window.innerWidth, H = window.innerHeight;
  const cx = W / 2, cy = H / 2;
  const radius = Math.min(W, H) / 2 * 0.85;

  if (stationId === window.homeStationId) return { x: cx, y: cy };

  const origin = stations[window.homeStationId];
  const s      = stations[stationId];
  const dLat   = s.lat - origin.lat;
  const dLon   = (s.lon - origin.lon) * LON_SCALE;
  const angle  = Math.atan2(-dLat, dLon);

  const t = window.travelTimes[stationId] / MAX_TRAVEL_TIME;
  const r = Math.min(t, 1.1) * radius;

  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
}

function position(stationId) {
  return isTravelMode() ? travelPosition(stationId) : geoPosition(stationId);
}

// ─── Distortion Grid ──────────────────────────────────────────────────────────
/**
 * For a lat/lon grid node, interpolate travel time from the 4 nearest stops
 * using inverse-distance weighting, then add an approximated walk penalty.
 */
function _nodeIDW(lat, lon) {
  const K = 4;
  let heap = [];   // [d2, id] — keep K smallest
  for (const { id, lat: slat, lon: slon } of _stopArr) {
    const dlat = slat - lat;
    const dlon = (slon - lon) * LON_SCALE;
    const d2 = dlat * dlat + dlon * dlon;
    if (heap.length < K) {
      heap.push([d2, id]);
      if (heap.length === K) heap.sort((a, b) => b[0] - a[0]); // max-heap by d2
    } else if (d2 < heap[0][0]) {
      heap[0] = [d2, id];
      heap.sort((a, b) => b[0] - a[0]);
    }
  }
  let wSum = 0, tSum = 0;
  for (const [d2, id] of heap) {
    const tt = window.travelTimes[id] ?? MAX_TRAVEL_TIME;
    const w = 1 / (d2 + 1e-10);
    wSum += w;
    tSum += w * tt;
  }
  return tSum / wSum;
}

function computeGridTravelTimes() {
  if (!window.travelTimes) { window.gridTravelTimes = null; return; }
  const grid = {};
  for (const lat of GRID_LATS) {
    for (const lon of GRID_LONS) {
      grid[`${lat.toFixed(4)},${lon.toFixed(4)}`] = _nodeIDW(lat, lon);
    }
  }
  window.gridTravelTimes = grid;
}

function _gridNodePosition(lat, lon) {
  if (!isTravelMode()) {
    const pt = lmap.latLngToContainerPoint([lat, lon]);
    return { x: pt.x, y: pt.y };
  }
  const W = window.innerWidth, H = window.innerHeight;
  const cx = W / 2, cy = H / 2;
  const radius = Math.min(W, H) / 2 * 0.85;
  const origin = stations[window.homeStationId];

  const dLat  = lat - origin.lat;
  const dLon  = (lon - origin.lon) * LON_SCALE;
  const angle = Math.atan2(-dLat, dLon);

  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const tt  = window.gridTravelTimes?.[key] ?? MAX_TRAVEL_TIME;
  const t   = Math.min(tt / MAX_TRAVEL_TIME, 1.2);

  return { x: cx + Math.cos(angle) * t * radius, y: cy + Math.sin(angle) * t * radius };
}

function renderGrid() {
  const nLat = GRID_LATS.length;
  const nLon = GRID_LONS.length;

  // Build cell path strings: each cell is a quadrilateral of 4 adjacent nodes
  const cells = [];
  for (let i = 0; i < nLat - 1; i++) {
    for (let j = 0; j < nLon - 1; j++) {
      const tl = _gridNodePosition(GRID_LATS[i],     GRID_LONS[j]);
      const tr = _gridNodePosition(GRID_LATS[i],     GRID_LONS[j + 1]);
      const br = _gridNodePosition(GRID_LATS[i + 1], GRID_LONS[j + 1]);
      const bl = _gridNodePosition(GRID_LATS[i + 1], GRID_LONS[j]);
      cells.push(`M${tl.x},${tl.y}L${tr.x},${tr.y}L${br.x},${br.y}L${bl.x},${bl.y}Z`);
    }
  }

  let sel = gridGroup.selectAll('.grid-cell').data(cells);
  sel.enter()
    .append('path')
    .attr('class', 'grid-cell')
    .merge(sel)
    .transition().duration(TRANSITION_MS)
    .attr('d', d => d);
  sel.exit().remove();
}

// ─── Warp Canvas (cartogram distortion of map tiles) ─────────────────────────
const _warpEl  = document.getElementById('warpCanvas');
const _warpCtx = _warpEl.getContext('2d');
let _warpSrc        = null;   // captured offscreen canvas of geo-mode tiles
let _prevTravelMode = false;
let _savedView      = null;   // { center, zoom } before zoom-out for capture
let _warpGen        = 0;      // generation counter to invalidate stale captures
let _showMapBg      = true;   // user toggle for warped map background

/** Always returns geo screen position for a grid node. */
function _geoGridPos(lat, lon) {
  const pt = lmap.latLngToContainerPoint([lat, lon]);
  return { x: pt.x, y: pt.y };
}

/** Always returns travel-time polar position for a grid node. */
function _travelGridPos(lat, lon) {
  const W = window.innerWidth, H = window.innerHeight;
  const cx = W / 2, cy = H / 2;
  const radius = Math.min(W, H) / 2 * 0.85;
  const origin = stations[window.homeStationId];
  const dLat  = lat - origin.lat;
  const dLon  = (lon - origin.lon) * LON_SCALE;
  const angle = Math.atan2(-dLat, dLon);
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const tt  = window.gridTravelTimes?.[key] ?? MAX_TRAVEL_TIME;
  const t   = Math.min(tt / MAX_TRAVEL_TIME, 1.2);
  return { x: cx + Math.cos(angle) * t * radius, y: cy + Math.sin(angle) * t * radius };
}

/** Rasterise all visible Leaflet tile <img>s to an offscreen canvas. */
function _captureMapTiles() {
  const W = window.innerWidth, H = window.innerHeight;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f5f5f0';
  ctx.fillRect(0, 0, W, H);
  for (const tile of document.querySelectorAll('.leaflet-tile-pane img')) {
    if (!tile.complete || !tile.naturalWidth) continue;
    try {
      const r = tile.getBoundingClientRect();
      ctx.drawImage(tile, r.left, r.top, r.width, r.height);
    } catch (_) { /* CORS error — skip */ }
  }
  return c;
}

/** Draw a source triangle → destination triangle with affine texture mapping. */
function _warpTri(ctx, src,
  sx0, sy0, sx1, sy1, sx2, sy2,
  dx0, dy0, dx1, dy1, dx2, dy2) {
  const det = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
  if (Math.abs(det) < 0.01) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(dx0, dy0);
  ctx.lineTo(dx1, dy1);
  ctx.lineTo(dx2, dy2);
  ctx.closePath();
  ctx.clip();
  const a  = (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / det;
  const b  = (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / det;
  const c2 = (dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) / det;
  const d  = (dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) / det;
  const e  = (dx0*(sx1*sy2 - sx2*sy1) + dx1*(sx2*sy0 - sx0*sy2) + dx2*(sx0*sy1 - sx1*sy0)) / det;
  const f  = (dy0*(sx1*sy2 - sx2*sy1) + dy1*(sx2*sy0 - sx0*sy2) + dy2*(sx0*sy1 - sx1*sy0)) / det;
  ctx.setTransform(a, b, c2, d, e, f);
  ctx.drawImage(src, 0, 0);
  ctx.restore();
}

/** Redraw the warped map canvas from _warpSrc using the distortion grid. */
function _renderWarp() {
  if (!_warpSrc || !window.gridTravelTimes) return;
  const W = window.innerWidth, H = window.innerHeight;
  _warpEl.width  = W;
  _warpEl.height = H;
  _warpCtx.fillStyle = '#f5f5f0';
  _warpCtx.fillRect(0, 0, W, H);

  const nLat = GRID_LATS.length, nLon = GRID_LONS.length;
  for (let i = 0; i < nLat - 1; i++) {
    for (let j = 0; j < nLon - 1; j++) {
      const s00 = _geoGridPos(GRID_LATS[i],     GRID_LONS[j]);
      const s10 = _geoGridPos(GRID_LATS[i],     GRID_LONS[j+1]);
      const s11 = _geoGridPos(GRID_LATS[i+1],   GRID_LONS[j+1]);
      const s01 = _geoGridPos(GRID_LATS[i+1],   GRID_LONS[j]);
      const d00 = _travelGridPos(GRID_LATS[i],   GRID_LONS[j]);
      const d10 = _travelGridPos(GRID_LATS[i],   GRID_LONS[j+1]);
      const d11 = _travelGridPos(GRID_LATS[i+1], GRID_LONS[j+1]);
      const d01 = _travelGridPos(GRID_LATS[i+1], GRID_LONS[j]);
      // Two triangles per quad
      _warpTri(_warpCtx, _warpSrc,
        s00.x, s00.y, s10.x, s10.y, s11.x, s11.y,
        d00.x, d00.y, d10.x, d10.y, d11.x, d11.y);
      _warpTri(_warpCtx, _warpSrc,
        s00.x, s00.y, s11.x, s11.y, s01.x, s01.y,
        d00.x, d00.y, d11.x, d11.y, d01.x, d01.y);
    }
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function agencyColor(stationId) {
  const prefix = stationId.split('_')[0];
  return AGENCY_COLORS[prefix] || '#aaaacc';
}

function routeColor(line) {
  const c = line.color;
  const agency = Object.keys(AGENCY_COLORS).find(a => line.stations.some(id => id.startsWith(a + '_')));
  const defaultColor = agency ? AGENCY_COLORS[agency] : '#aaaacc';
  if (!c || c === '#000000' || c === '#000' || c === 'null') return defaultColor;
  return c;
}

function renderMap() {
  const tMode = isTravelMode();
  const W = window.innerWidth, H = window.innerHeight;

  document.body.classList.toggle('travel-mode', tMode);

  // Warp canvas: zoom out to capture full region, then show warped map
  if (tMode && !_prevTravelMode) {
    _savedView = { center: lmap.getCenter(), zoom: lmap.getZoom() };
    const gridBounds = L.latLngBounds(
      [GRID_LATS[0], GRID_LONS[0]],
      [GRID_LATS[GRID_LATS.length - 1], GRID_LONS[GRID_LONS.length - 1]]
    );
    lmap.fitBounds(gridBounds, { animate: false, padding: [20, 20] });
    const gen = ++_warpGen;
    const doCapture = () => {
      if (gen !== _warpGen || !isTravelMode()) return;
      _warpSrc = _captureMapTiles();
      lmap.getContainer().style.visibility = 'hidden';
      if (_showMapBg) _warpEl.style.display = 'block';
      _renderWarp();
    };
    const timer = setTimeout(doCapture, 1500);
    tileLayer.once('load', () => { clearTimeout(timer); doCapture(); });
  } else if (tMode && _warpSrc) {
    _renderWarp();
  }
  if (!tMode && _prevTravelMode) {
    ++_warpGen;
    if (_savedView) {
      lmap.setView(_savedView.center, _savedView.zoom, { animate: false });
      _savedView = null;
    }
    lmap.getContainer().style.visibility = '';
    _warpEl.style.display = 'none';
    _warpSrc = null;
  }
  _prevTravelMode = tMode;

  // Time rings (30 min, 1 hr, 2 hr)
  if (tMode) {
    const radius = Math.min(W, H) / 2 * 0.85;
    rings.forEach(({ seconds, halo, ring, text }) => {
      const r = radius * (seconds / MAX_TRAVEL_TIME);
      halo.attr('cx', W/2).attr('cy', H/2).attr('r', r).style('display', null);
      ring.attr('cx', W/2).attr('cy', H/2).attr('r', r).style('display', null);
      text.attr('x', W/2 + r + 6).attr('y', H/2 + 4).style('display', null);
    });
  } else {
    rings.forEach(({ halo, ring, text }) => {
      halo.style('display', 'none');
      ring.style('display', 'none');
      text.style('display', 'none');
    });
  }

  // Grid
  renderGrid();

  // ── Lines ──
  const lineData = Object.values(lines);
  let lineSelection = container.selectAll('.line').data(lineData, d => d.route_id);
  lineSelection.enter()
    .append('path')
    .attr('class', 'line')
    .attr('stroke', routeColor)
    .attr('stroke-width', l => l.route_type <= 1 ? 4 : (l.route_type === 2 ? 2.5 : 0.9))
    .attr('stroke-opacity', l => l.route_type <= 1 ? 0.85 : 0.3)
    .merge(lineSelection)
    .transition().duration(TRANSITION_MS)
    .attr('d', line => {
      const pts = line.stations
        .filter(id => stations[id])
        .map(id => { const p = position(id); return [p.x, p.y]; });
      return d3.line()(pts);
    });
  lineSelection.exit().remove();

  // ── Stops ──
  const stopIds = Object.keys(stations);
  let stopSelection = container.selectAll('.stop').data(stopIds, d => d);
  stopSelection.enter()
    .append('circle')
    .attr('class', 'stop')
    .attr('r', id => id.endsWith('_stn') ? 5 : 2)
    .attr('fill', agencyColor)
    .on('click',      id => setHomeStationId(id))
    .on('mouseenter', function(id) { showTooltip(d3.event, id); })
    .on('mouseleave', () => hideTooltip())
    .merge(stopSelection)
    .transition().duration(TRANSITION_MS)
    .attr('cx', id => position(id).x)
    .attr('cy', id => position(id).y)
    .attr('fill-opacity', id => {
      const isRail = id.endsWith('_stn');
      if (!tMode) return isRail ? 1 : 0.65;
      const tt = window.travelTimes?.[id] ?? MAX_TRAVEL_TIME;
      const fade = Math.max(0.18, 1 - (tt / MAX_TRAVEL_TIME) * 0.82);
      return (isRail ? 0.95 : 0.55) * fade;
    });
  stopSelection.exit().remove();

  // ── Home marker ──
  const homeData = window.homeStationId ? [window.homeStationId] : [];
  let homeSelection = container.selectAll('.home').data(homeData, d => d);
  homeSelection.enter()
    .append('circle')
    .attr('class', 'home')
    .attr('r', 7)
    .attr('fill', 'white')
    .attr('stroke', '#1a1a2e')
    .attr('stroke-width', 2.5)
    .on('click',      () => clearSelection())  // clicking home deselects
    .on('mouseenter', function(id) { showTooltip(d3.event, id); })
    .on('mouseleave', () => hideTooltip())
    .merge(homeSelection)
    .transition().duration(TRANSITION_MS)
    .attr('cx', id => position(id).x)
    .attr('cy', id => position(id).y);
  homeSelection.exit().remove();
}

// ─── Map Events ───────────────────────────────────────────────────────────────
lmap.on('move zoom', () => {
  if (!isTravelMode()) {
    container.selectAll('.stop')
      .attr('cx', id => geoPosition(id).x)
      .attr('cy', id => geoPosition(id).y);
    container.selectAll('.home')
      .attr('cx', id => geoPosition(id).x)
      .attr('cy', id => geoPosition(id).y);
    container.selectAll('.line')
      .attr('d', line => {
        const pts = line.stations
          .filter(id => stations[id])
          .map(id => { const p = geoPosition(id); return [p.x, p.y]; });
        return d3.line()(pts);
      });
    // Re-position grid nodes on pan/zoom in geo mode
    container.selectAll('.grid-cell')
      .attr('d', function(d, i) {
        const row = (i / (GRID_LONS.length - 1)) | 0;
        const col = i % (GRID_LONS.length - 1);
        const tl = _gridNodePosition(GRID_LATS[row],     GRID_LONS[col]);
        const tr = _gridNodePosition(GRID_LATS[row],     GRID_LONS[col + 1]);
        const br = _gridNodePosition(GRID_LATS[row + 1], GRID_LONS[col + 1]);
        const bl = _gridNodePosition(GRID_LATS[row + 1], GRID_LONS[col]);
        return `M${tl.x},${tl.y}L${tr.x},${tr.y}L${br.x},${br.y}L${bl.x},${bl.y}Z`;
      });
  }
});

// Click on SVG background → deselect
svg.on('click', function() {
  if (d3.event.target === svgEl || d3.event.target === container.node()) {
    clearSelection();
  }
});

// Escape key → deselect
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && window.homeStationId) clearSelection();
});

// ─── UI Updates ───────────────────────────────────────────────────────────────
function updateInfoPanel() {
  if (window.homeStationId) {
    document.getElementById('initial').style.display = 'none';
    document.getElementById('explanation').style.display = 'block';
    const name = stations[window.homeStationId]?.name || '';
    document.getElementById('homeLabel').textContent = `From: ${name}`;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
function toggleMapBackground(show) {
  _showMapBg = show;
  _warpEl.style.display = (isTravelMode() && _warpSrc && show) ? 'block' : 'none';
}

function clearSelection() {
  window.homeStationId   = null;
  window.travelTimes     = null;
  window.gridTravelTimes = null;
  document.getElementById('initial').style.display = 'block';
  document.getElementById('explanation').style.display = 'none';
  document.body.classList.remove('travel-mode');
  tooltip.style.display = 'none';
  renderMap();
}

function setHomeStationId(id) {
  if (id === window.homeStationId) { clearSelection(); return; }
  window.homeStationId   = id;
  window.travelTimes     = null;
  window.gridTravelTimes = null;
  updateInfoPanel();
  renderMap();
  computeTravelTimes(id, window.schedule, (times) => {
    window.travelTimes = times;
    computeGridTravelTimes();
    renderMap();
  });
}

function setSchedule(name) {
  window.schedule = name;
  if (window.homeStationId) {
    computeTravelTimes(window.homeStationId, name, (times) => {
      window.travelTimes = times;
      computeGridTravelTimes();
      renderMap();
    });
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
renderMap();
getSchedule('weekday_rush', () => {});
