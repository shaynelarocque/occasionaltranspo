// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_TRAVEL_TIME = 120 * 60;  // seconds — 2 hr max
const LON_SCALE       = 0.702;     // cos(45.4°N) for Ottawa
const AGENCY_COLORS   = { oct: '#D52B1E', sto: '#005DAA' };
const TRANSITION_MS   = 750;

// Custom easing — snappy, physical-feeling curves (Emil Kowalski style)
const EASE_OUT_EXPO  = t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
const EASE_OUT_QUART = t => 1 - Math.pow(1 - t, 4);
const EASE_OUT_CUBIC = t => 1 - Math.pow(1 - t, 3);
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const DUR_STOPS = REDUCED_MOTION ? 10 : 750;
const DUR_LINES = REDUCED_MOTION ? 10 : 700;
const DUR_RINGS = REDUCED_MOTION ? 10 : 600;

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

// Hide tiles by default; toggled by user's "Show map background" checkbox
document.body.classList.add('hide-map-bg');

// ─── Leaflet Map ──────────────────────────────────────────────────────────────
const OTTAWA_CENTER = [45.422, -75.697];
const lmap = L.map('map', { zoomControl: false }).setView(OTTAWA_CENTER, 12);

const tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: 'abcd',
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
document.body.appendChild(tooltip);

let hideTooltipPending = false;
function showTooltip(e, stationId) {
  hideTooltipPending = false;
  const s = stations[stationId];
  let html = `<strong>${s.name}</strong>`;
  if (window.travelTimes) {
    const tt = window.travelTimes[stationId];
    if (tt && tt < 1000 * 60) {
      const mins = (tt / 60) | 0;
      const secs = tt % 60;
      html += `<div class="tt-time">${mins}m ${secs}s away</div>`;
    }
  }
  tooltip.innerHTML = html;
  tooltip.style.transform = `translate(${e.pageX + 14}px, ${e.pageY + 14}px)`;
  tooltip.classList.add('visible');
}
function hideTooltip() {
  hideTooltipPending = true;
  setTimeout(() => { if (hideTooltipPending) tooltip.classList.remove('visible'); }, 100);
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
    .transition().duration(DUR_LINES).ease(EASE_OUT_QUART)
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
let _showMapBg      = false;  // user toggle for warped map background — default OFF
let _showBus        = false;  // user toggle for bus routes/stops — default OFF

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
function _stopRadius(id) {
  const isRail = id.endsWith('_stn');
  return isRail ? 5 : (_showBus ? 1.5 : 0);
}

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

  // Warp canvas: zoom out to capture full region, then crossfade
  const mapEl = document.getElementById('map');
  if (tMode && !_prevTravelMode) {
    _savedView = { center: lmap.getCenter(), zoom: lmap.getZoom() };
    mapEl.classList.add('map-hidden');  // immediately hide Leaflet when entering travel mode
    const gridBounds = L.latLngBounds(
      [GRID_LATS[0], GRID_LONS[0]],
      [GRID_LATS[GRID_LATS.length - 1], GRID_LONS[GRID_LONS.length - 1]]
    );
    lmap.fitBounds(gridBounds, { animate: false, padding: [20, 20] });
    const gen = ++_warpGen;
    const doCapture = () => {
      if (gen !== _warpGen || !isTravelMode()) return;
      _warpSrc = _captureMapTiles();
      _renderWarp();
      if (_showMapBg) {
        _warpEl.style.display = 'block';
        requestAnimationFrame(() => { _warpEl.style.opacity = '1'; });
      }
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
    // Crossfade back: show Leaflet, fade out warp
    mapEl.classList.remove('map-hidden');
    lmap.invalidateSize();
    _warpEl.style.opacity = '0';
    setTimeout(() => { _warpEl.style.display = 'none'; }, 400);
    _warpSrc = null;
  }
  _prevTravelMode = tMode;

  // Time rings (30 min, 1 hr, 2 hr) — animated entrance/exit
  if (tMode) {
    const radius = Math.min(W, H) / 2 * 0.85;
    rings.forEach(({ seconds, halo, ring, text }, i) => {
      const r = radius * (seconds / MAX_TRAVEL_TIME);
      const stagger = REDUCED_MOTION ? 0 : i * 120;
      halo.interrupt().attr('cx', W/2).attr('cy', H/2).attr('r', 0).style('opacity', 0).style('display', null)
        .transition().duration(DUR_RINGS).delay(stagger).ease(EASE_OUT_CUBIC)
        .attr('r', r).style('opacity', 1);
      ring.interrupt().attr('cx', W/2).attr('cy', H/2).attr('r', 0).style('opacity', 0).style('display', null)
        .transition().duration(DUR_RINGS).delay(stagger).ease(EASE_OUT_CUBIC)
        .attr('r', r).style('opacity', 1);
      text.interrupt().attr('y', H/2 + 4).style('opacity', 0).style('display', null)
        .transition().duration(300).delay(stagger + 400).ease(EASE_OUT_CUBIC)
        .attr('x', W/2 + r + 6).style('opacity', 1);
    });
  } else {
    rings.forEach(({ halo, ring, text }) => {
      halo.transition().duration(200).style('opacity', 0).on('end', function() { d3.select(this).style('display', 'none').attr('r', 0); });
      ring.transition().duration(200).style('opacity', 0).on('end', function() { d3.select(this).style('display', 'none').attr('r', 0); });
      text.transition().duration(200).style('opacity', 0).on('end', function() { d3.select(this).style('display', 'none'); });
    });
  }

  // Grid
  renderGrid();

  // ── Lines ──
  const isRailLine = l => l.route_type <= 1;
  const lineData = Object.values(lines);
  let lineSelection = container.selectAll('.line').data(lineData, d => d.route_id);
  lineSelection.enter()
    .append('path')
    .attr('class', 'line')
    .attr('stroke', routeColor)
    .merge(lineSelection)
    .transition().duration(DUR_LINES).ease(EASE_OUT_QUART)
    .attr('stroke-width', l => isRailLine(l) ? 4 : (_showBus ? 0.7 : 0))
    .attr('stroke-opacity', l => isRailLine(l) ? 0.85 : (_showBus ? 0.18 : 0))
    .attr('d', line => {
      const pts = line.stations
        .filter(id => stations[id])
        .filter(id => !isTravelMode() || !(window.travelTimes?.[id] >= 1000 * 60))
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
    .attr('fill', agencyColor)
    .on('click',      id => setHomeStationId(id))
    .on('mouseenter', function(id) {
      const isRail = id.endsWith('_stn');
      if (!isRail && !_showBus) return; // don't tooltip invisible stops
      showTooltip(d3.event, id);
      const baseR = _stopRadius(id);
      d3.select(this).transition('hover').duration(150).ease(EASE_OUT_CUBIC).attr('r', baseR * 1.6);
    })
    .on('mouseleave', function(id) {
      hideTooltip();
      const baseR = _stopRadius(id);
      d3.select(this).transition('hover').duration(200).ease(EASE_OUT_CUBIC).attr('r', baseR);
    })
    .merge(stopSelection)
    .transition().duration(DUR_STOPS).ease(EASE_OUT_EXPO)
    .delay(id => {
      if (!tMode || REDUCED_MOTION) return 0;
      const tt = window.travelTimes?.[id] ?? MAX_TRAVEL_TIME;
      return Math.min((tt / MAX_TRAVEL_TIME) * 200, 200);
    })
    .attr('r', id => _stopRadius(id))
    .attr('cx', id => position(id).x)
    .attr('cy', id => position(id).y)
    .attr('fill-opacity', id => {
      const isRail = id.endsWith('_stn');
      if (!isRail && !_showBus) return 0;
      if (!tMode) return isRail ? 1 : 0.4;
      const tt = window.travelTimes?.[id] ?? MAX_TRAVEL_TIME;
      if (tt >= 1000 * 60) return 0;  // unreachable
      const fade = Math.max(0.18, 1 - (tt / MAX_TRAVEL_TIME) * 0.82);
      return (isRail ? 0.95 : 0.35) * fade;
    });
  // Set pointer-events after transition settles
  container.selectAll('.stop')
    .style('pointer-events', id => {
      const isRail = id.endsWith('_stn');
      if (!isRail && !_showBus) return 'none';
      if (isTravelMode()) {
        const tt = window.travelTimes?.[id] ?? MAX_TRAVEL_TIME;
        if (tt >= 1000 * 60) return 'none';  // unreachable — not clickable
      }
      return 'all';
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
    .transition().duration(DUR_STOPS).ease(EASE_OUT_EXPO)
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
    const initial = document.getElementById('initial');
    const explanation = document.getElementById('explanation');
    initial.classList.remove('panel-visible');
    initial.classList.add('panel-hidden');
    setTimeout(() => { initial.style.display = 'none'; }, 250);
    const name = stations[window.homeStationId]?.name || '';
    document.getElementById('homeLabel').textContent = `From: ${name}`;
    explanation.style.display = 'block';
    explanation.classList.remove('panel-visible');
    explanation.classList.add('panel-hidden');
    void explanation.offsetHeight; // force reflow so transition triggers
    explanation.classList.add('panel-visible');
    explanation.classList.remove('panel-hidden');
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
function toggleBusRoutes(show) {
  _showBus = show;
  renderMap();
}

function toggleMapBackground(show) {
  _showMapBg = show;
  document.body.classList.toggle('hide-map-bg', !show);
  if (isTravelMode() && _warpSrc && show) {
    _warpEl.style.display = 'block';
    requestAnimationFrame(() => { _warpEl.style.opacity = '1'; });
  } else if (!show || isTravelMode()) {
    _warpEl.style.opacity = '0';
    setTimeout(() => { if (!_showMapBg || !isTravelMode()) _warpEl.style.display = 'none'; }, 400);
  }
}

function clearSelection() {
  window.homeStationId   = null;
  window.travelTimes     = null;
  window.gridTravelTimes = null;
  const initial = document.getElementById('initial');
  const explanation = document.getElementById('explanation');
  explanation.classList.remove('panel-visible');
  explanation.classList.add('panel-hidden');
  setTimeout(() => { explanation.style.display = 'none'; }, 250);
  // Restore initial panel: set display, force reflow, then animate in
  initial.style.display = 'block';
  initial.classList.remove('panel-visible');
  initial.classList.add('panel-hidden');
  void initial.offsetHeight; // force reflow so transition triggers
  initial.classList.add('panel-visible');
  initial.classList.remove('panel-hidden');
  // Restore Leaflet map directly (defensive — renderMap also does this)
  document.getElementById('map').classList.remove('map-hidden');
  document.body.classList.remove('travel-mode');
  tooltip.classList.remove('visible');
  _removePulse();
  renderMap();
}

// ─── Loading Pulse ────────────────────────────────────────────────────────────
let _pulseEl = null;
function _showPulse(id) {
  _removePulse();
  if (REDUCED_MOTION) return;
  const pos = geoPosition(id);
  _pulseEl = container.append('circle')
    .attr('class', 'loading-pulse')
    .attr('cx', pos.x).attr('cy', pos.y)
    .attr('r', 7).attr('fill', 'none')
    .attr('stroke', agencyColor(id)).attr('stroke-width', 2)
    .attr('opacity', 0.6);
  (function doPulse() {
    if (!_pulseEl) return;
    _pulseEl.attr('r', 7).attr('opacity', 0.6)
      .transition().duration(800).ease(EASE_OUT_CUBIC)
      .attr('r', 50).attr('opacity', 0)
      .on('end', doPulse);
  })();
}
function _removePulse() {
  if (_pulseEl) { _pulseEl.interrupt().remove(); _pulseEl = null; }
}

function setHomeStationId(id) {
  if (id === window.homeStationId) { clearSelection(); return; }
  window.homeStationId   = id;
  window.travelTimes     = null;
  window.gridTravelTimes = null;
  updateInfoPanel();
  _showPulse(id);
  renderMap();
  computeTravelTimes(id, window.schedule, (times) => {
    _removePulse();
    window.travelTimes = times;
    computeGridTravelTimes();
    renderMap();
  });
}

function setSchedule(name) {
  window.schedule = name;
  if (window.homeStationId) {
    _showPulse(window.homeStationId);
    computeTravelTimes(window.homeStationId, name, (times) => {
      _removePulse();
      window.travelTimes = times;
      computeGridTravelTimes();
      renderMap();
    });
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
renderMap();
getSchedule('weekday_rush', () => {});
