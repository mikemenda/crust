// ============================================================
// CRUST — World Map / Globe Feature
// Kept separate from app.js so the map/globe can evolve safely.
// ============================================================
'use strict';

let _worldMode = 'map';
let _worldPlaces = [];
let _worldMap = null;
let _worldMapReady = false;
let _worldGlobe = null;
let _worldGlobeReady = false;
let _worldSelectedPlaceId = null;
let _worldResizeBound = false;

function updateGlobeTeaser(visits) {
  const pinsEl = document.getElementById('globe-teaser-pins');
  const geoEl  = document.getElementById('globe-teaser-geo');
  if (!pinsEl || !geoEl) return;

  const mapped = (visits || []).filter(v => v.lat != null && v.lng != null);
  const uniquePlaces = new Set(mapped.map(v => v.placeId).filter(Boolean));
  const countries = new Set(mapped.map(v => v.country).filter(Boolean));
  const cities = new Set(mapped.map(v => v.city).filter(Boolean));

  pinsEl.textContent = uniquePlaces.size || mapped.length || 0;
  const parts = [];
  if (countries.size) parts.push(`${countries.size} ${countries.size === 1 ? 'country' : 'countries'}`);
  if (cities.size) parts.push(`${cities.size} ${cities.size === 1 ? 'city' : 'cities'}`);
  geoEl.textContent = parts.join(' · ');
}

async function openGlobe() {
  const overlay = document.getElementById('world-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  closeWorldPlaceSheet();

  await refreshWorldPlaces();
  updateWorldSubtitle();
  setWorldEmptyState(!_worldPlaces.length);
  await switchWorldMode(_worldMode || 'map', { force: true });
}

function closeGlobe() {
  closeWorldPlaceSheet();
  const overlay = document.getElementById('world-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
  }
}

async function switchWorldMode(mode, options = {}) {
  _worldMode = mode === 'globe' ? 'globe' : 'map';

  document.getElementById('world-mode-map')?.classList.toggle('active', _worldMode === 'map');
  document.getElementById('world-mode-globe')?.classList.toggle('active', _worldMode === 'globe');
  document.getElementById('world-map-container')?.classList.toggle('active', _worldMode === 'map');
  document.getElementById('world-globe-container')?.classList.toggle('active', _worldMode === 'globe');

  if (!_worldPlaces.length) return;

  if (_worldMode === 'map') {
    await initWorldMap();
    requestAnimationFrame(() => {
      if (_worldMap) {
        _worldMap.resize();
        if (options.force) fitWorldMapToPlaces();
      }
    });
  } else {
    await initWorldGlobe();
    requestAnimationFrame(resizeWorldGlobe);
  }
}

function resetWorldView() {
  closeWorldPlaceSheet();
  if (_worldMode === 'map' && _worldMap) {
    fitWorldMapToPlaces();
  } else if (_worldMode === 'globe' && _worldGlobe) {
    _worldGlobe.pointOfView({ lat: 18, lng: -66, altitude: 2.15 }, 800);
  }
}

async function refreshWorldPlaces() {
  _worldPlaces = await getWorldPlaces();
}

async function getWorldPlaces() {
  if (!currentUser) return [];

  const snap = await db.collection(`users/${currentUser.uid}/visits`).get();
  const placeMap = new Map();

  snap.docs.forEach(doc => {
    const v = doc.data();
    const lat = Number(v.lat);
    const lng = Number(v.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const placeId = v.placeId || `coord:${lat.toFixed(5)},${lng.toFixed(5)}:${v.placeName || 'Unknown'}`;
    if (!placeMap.has(placeId)) {
      placeMap.set(placeId, {
        placeId,
        hasRealPlaceId: Boolean(v.placeId),
        name: v.placeName || 'Unknown',
        city: v.city || '',
        country: v.country || '',
        lat,
        lng,
        visitCount: 0,
        ratings: [],
      });
    }

    const p = placeMap.get(placeId);
    p.visitCount += 1;
    if (v.rating != null && Number.isFinite(Number(v.rating))) p.ratings.push(Number(v.rating));
    if (!p.city && v.city) p.city = v.city;
    if (!p.country && v.country) p.country = v.country;
  });

  return Array.from(placeMap.values()).sort((a, b) => b.visitCount - a.visitCount || a.name.localeCompare(b.name));
}

function updateWorldSubtitle() {
  const el = document.getElementById('world-subtitle');
  if (!el) return;
  const countries = new Set(_worldPlaces.map(p => p.country).filter(Boolean));
  const cities = new Set(_worldPlaces.map(p => p.city).filter(Boolean));
  const parts = [`${_worldPlaces.length} ${_worldPlaces.length === 1 ? 'spot' : 'spots'}`];
  if (cities.size) parts.push(`${cities.size} ${cities.size === 1 ? 'city' : 'cities'}`);
  if (countries.size) parts.push(`${countries.size} ${countries.size === 1 ? 'country' : 'countries'}`);
  el.textContent = parts.join(' · ');
}

function setWorldEmptyState(show) {
  const empty = document.getElementById('world-empty-state');
  if (empty) empty.classList.toggle('hidden', !show);
}

function loadMapLibre() {
  return new Promise((resolve, reject) => {
    if (window.maplibregl) { resolve(); return; }

    if (!document.querySelector('link[href*="maplibre-gl"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css';
      document.head.appendChild(link);
    }

    const existing = document.querySelector('script[src*="maplibre-gl"]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function initWorldMap() {
  const container = document.getElementById('world-map-container');
  if (!container) return;

  try {
    await loadMapLibre();

    if (!_worldMap) {
      container.innerHTML = '';
      _worldMap = new maplibregl.Map({
        container: 'world-map-container',
        style: crustWorldMapStyle(),
        center: [-66.1, 18.2],
        zoom: 2.2,
        minZoom: 1,
        maxZoom: 18,
        attributionControl: false,
      });

      _worldMap.on('load', async () => {
        const pinImg = await createWorldPinImage();
        if (pinImg && !_worldMap.hasImage('crust-world-pin')) {
          _worldMap.addImage('crust-world-pin', pinImg, { pixelRatio: 2 });
        }
        addWorldMapLayers();
        _worldMapReady = true;
        updateWorldMapData();
        fitWorldMapToPlaces();
      });

      _worldMap.on('click', () => closeWorldPlaceSheet());
    } else {
      updateWorldMapData();
    }
  } catch (e) {
    console.error('initWorldMap:', e);
    container.innerHTML = '<div class="world-loading">Couldn\'t load Map View.</div>';
  }
}

function addWorldMapLayers() {
  if (!_worldMap || _worldMap.getSource('world-pizza-places')) return;

  _worldMap.addSource('world-pizza-places', {
    type: 'geojson',
    data: worldPlacesGeoJSON(),
    cluster: true,
    clusterMaxZoom: 11,
    clusterRadius: 52,
  });

  _worldMap.addLayer({
    id: 'world-clusters',
    type: 'circle',
    source: 'world-pizza-places',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': '#D85A30',
      'circle-radius': ['step', ['get', 'point_count'], 20, 5, 24, 15, 30],
      'circle-stroke-width': 3,
      'circle-stroke-color': '#C8A97E',
    }
  });

  _worldMap.addLayer({
    id: 'world-cluster-count',
    type: 'symbol',
    source: 'world-pizza-places',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': '{point_count_abbreviated}',
      'text-font': ['Noto Sans Regular'],
      'text-size': 13,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#F0EAD6' }
  });

  _worldMap.addLayer({
    id: 'world-unclustered-point',
    type: 'symbol',
    source: 'world-pizza-places',
    filter: ['!', ['has', 'point_count']],
    layout: {
      'icon-image': 'crust-world-pin',
      'icon-size': 1,
      'icon-anchor': 'bottom',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    }
  });

  _worldMap.on('click', 'world-clusters', e => {
    e.originalEvent.stopPropagation();
    const features = _worldMap.queryRenderedFeatures(e.point, { layers: ['world-clusters'] });
    if (!features.length) return;
    const clusterId = features[0].properties.cluster_id;
    _worldMap.getSource('world-pizza-places').getClusterExpansionZoom(clusterId, (err, zoom) => {
      if (err) return;
      _worldMap.easeTo({ center: features[0].geometry.coordinates, zoom: zoom + 0.4, duration: 500 });
    });
  });

  _worldMap.on('click', 'world-unclustered-point', e => {
    e.originalEvent.stopPropagation();
    const props = e.features[0].properties;
    const place = mapFeaturePropsToPlace(props);
    showWorldPlaceSheet(place);
  });

  ['world-clusters', 'world-unclustered-point'].forEach(layer => {
    _worldMap.on('mouseenter', layer, () => { _worldMap.getCanvas().style.cursor = 'pointer'; });
    _worldMap.on('mouseleave', layer, () => { _worldMap.getCanvas().style.cursor = ''; });
  });
}

function updateWorldMapData() {
  if (!_worldMap || !_worldMapReady) return;
  const source = _worldMap.getSource('world-pizza-places');
  if (source) source.setData(worldPlacesGeoJSON());
}

function worldPlacesGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: _worldPlaces.map(p => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: {
        placeId: p.placeId,
        hasRealPlaceId: p.hasRealPlaceId,
        name: p.name,
        city: p.city,
        country: p.country,
        lat: p.lat,
        lng: p.lng,
        visitCount: p.visitCount,
        ratings: JSON.stringify(p.ratings || []),
      }
    }))
  };
}

function fitWorldMapToPlaces() {
  if (!_worldMap || !_worldPlaces.length) return;
  if (_worldPlaces.length === 1) {
    const p = _worldPlaces[0];
    _worldMap.easeTo({ center: [p.lng, p.lat], zoom: 11, duration: 600 });
    return;
  }

  const bounds = new maplibregl.LngLatBounds();
  _worldPlaces.forEach(p => bounds.extend([p.lng, p.lat]));
  _worldMap.fitBounds(bounds, {
    padding: { top: 90, bottom: 190, left: 56, right: 56 },
    maxZoom: 6,
    duration: 650,
  });
}

function mapFeaturePropsToPlace(props) {
  return {
    placeId: props.placeId,
    hasRealPlaceId: props.hasRealPlaceId === true || props.hasRealPlaceId === 'true',
    name: props.name || 'Unknown',
    city: props.city || '',
    country: props.country || '',
    lat: Number(props.lat),
    lng: Number(props.lng),
    visitCount: Number(props.visitCount || 0),
    ratings: typeof props.ratings === 'string' ? JSON.parse(props.ratings || '[]') : (props.ratings || []),
  };
}

function loadGlobeGL() {
  return new Promise((resolve, reject) => {
    if (window.Globe) { resolve(); return; }

    const existing = document.querySelector('script[src*="globe.gl"]');
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://unpkg.com/globe.gl@2.33.2/dist/globe.gl.min.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function initWorldGlobe() {
  const container = document.getElementById('world-globe-container');
  if (!container) return;

  try {
    await loadGlobeGL();

    if (!_worldGlobe) {
      container.innerHTML = '';
      _worldGlobe = Globe()(container)
        .backgroundColor('rgba(0,0,0,0)')
        .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
        .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
        .showAtmosphere(true)
        .atmosphereColor('#C8A97E')
        .atmosphereAltitude(0.16)
        .arcsTransitionDuration(700)
        .arcColor(() => ['rgba(200,169,126,.15)', 'rgba(216,90,48,.82)'])
        .arcStroke(0.42)
        .arcDashLength(0.45)
        .arcDashGap(1.3)
        .arcDashAnimateTime(3600)
        .htmlLat(d => d.lat)
        .htmlLng(d => d.lng)
        .htmlAltitude(0.02)
        .htmlElement(d => buildWorldGlobePin(d));

      const controls = _worldGlobe.controls();
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.35;
      controls.enablePan = false;
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;

      _worldGlobe.pointOfView({ lat: 18, lng: -66, altitude: 2.15 }, 0);
      bindWorldResize();
      _worldGlobeReady = true;
    }

    updateWorldGlobeData();
    resizeWorldGlobe();
  } catch (e) {
    console.error('initWorldGlobe:', e);
    container.innerHTML = '<div class="world-loading">Couldn\'t load Globe View.</div>';
  }
}

function updateWorldGlobeData() {
  if (!_worldGlobe || !_worldGlobeReady) return;
  _worldGlobe.htmlElementsData(_worldPlaces);
  _worldGlobe.arcsData(buildWorldArcs());
}

function buildWorldArcs() {
  const home = { lat: 18.2208, lng: -66.5901 }; // Puerto Rico center
  return _worldPlaces
    .filter(p => Math.abs(p.lat - home.lat) > 0.3 || Math.abs(p.lng - home.lng) > 0.3)
    .map(p => ({ startLat: home.lat, startLng: home.lng, endLat: p.lat, endLng: p.lng }));
}

function buildWorldGlobePin(place) {
  const el = document.createElement('div');
  el.className = 'world-html-pin';
  const label = place.city || place.name || '';
  el.innerHTML = `
    <div class="world-html-pin-dot">🍕</div>
    ${place.visitCount > 1 ? `<div class="world-html-pin-count">${place.visitCount}</div>` : ''}
    ${label ? `<div class="world-html-pin-label">${safeText(label)}</div>` : ''}
  `;
  el.addEventListener('click', e => {
    e.stopPropagation();
    showWorldPlaceSheet(place);
  });
  return el;
}

function resizeWorldGlobe() {
  if (!_worldGlobe) return;
  const container = document.getElementById('world-globe-container');
  if (!container) return;
  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;
  _worldGlobe.width(width).height(height);
}

function bindWorldResize() {
  if (_worldResizeBound) return;
  _worldResizeBound = true;
  window.addEventListener('resize', () => {
    if (_worldMap) _worldMap.resize();
    resizeWorldGlobe();
  });
}

function showWorldPlaceSheet(place) {
  _worldSelectedPlaceId = place.hasRealPlaceId ? place.placeId : null;

  const rating = averageWorldRating(place.ratings);
  const loc = [place.city, place.country].filter(Boolean).join(' · ');

  setWorldText('world-place-name', place.name || 'Unknown');
  setWorldText('world-place-location', loc);
  setWorldText('world-place-rating', rating || '—');
  setWorldText('world-place-visits', `${place.visitCount || 0} ${(place.visitCount || 0) === 1 ? 'visit' : 'visits'}`);

  const viewBtn = document.getElementById('world-place-view-btn');
  if (viewBtn) {
    viewBtn.disabled = !_worldSelectedPlaceId;
    viewBtn.textContent = _worldSelectedPlaceId ? 'View Place →' : 'Place details unavailable';
  }

  document.getElementById('world-place-sheet')?.classList.remove('hidden');
}

function closeWorldPlaceSheet() {
  document.getElementById('world-place-sheet')?.classList.add('hidden');
  _worldSelectedPlaceId = null;
}

function viewGlobePlace() {
  const pid = _worldSelectedPlaceId;
  if (!pid) return;
  closeWorldPlaceSheet();
  closeGlobe();
  setTimeout(() => openPlace(pid), 260);
}

function setWorldText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || '';
}

function averageWorldRating(ratings) {
  if (!ratings || !ratings.length) return '';
  const avg = ratings.reduce((sum, r) => sum + Number(r || 0), 0) / ratings.length;
  return avg.toFixed(1);
}

function safeText(value) {
  if (typeof esc === 'function') return esc(value);
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[ch]));
}

function createWorldPinImage() {
  const svg = `<svg width="64" height="80" viewBox="0 0 32 40" xmlns="http://www.w3.org/2000/svg">
    <path d="M16 1C7.7 1 1 7.7 1 16C1 27.3 16 39 16 39C16 39 31 27.3 31 16C31 7.7 24.3 1 16 1Z" fill="#D85A30" stroke="#C8A97E" stroke-width="2"/>
    <circle cx="16" cy="15" r="10" fill="#F0EAD6" opacity=".96"/>
    <path d="M16 15 L25 9 A11 11 0 1 1 25 21 Z" fill="#F0EAD6"/>
    <path d="M25 9 A11 11 0 1 1 25 21" stroke="#C8A97E" stroke-width="2" fill="none" stroke-linecap="round"/>
    <circle cx="11" cy="12" r="1.4" fill="#D85A30"/>
    <circle cx="10" cy="17" r="1.1" fill="#D85A30"/>
    <circle cx="17" cy="10" r="1.1" fill="#D85A30"/>
    <circle cx="17" cy="20" r="1.1" fill="#D85A30"/>
  </svg>`;

  return new Promise(resolve => {
    const img = new Image(64, 80);
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

function crustWorldMapStyle() {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      ofm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#101722' } },
      { id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': '#071322' } },
      { id: 'landcover', type: 'fill', source: 'ofm', 'source-layer': 'landcover', paint: { 'fill-color': '#172338', 'fill-opacity': .28 } },
      { id: 'border-country', type: 'line', source: 'ofm', 'source-layer': 'boundary',
        filter: ['all', ['==', 'admin_level', 2], ['!=', 'maritime', 1]],
        paint: { 'line-color': 'rgba(200,169,126,.34)', 'line-width': ['interpolate', ['linear'], ['zoom'], 0, .45, 6, 1.4] } },
      { id: 'border-state', type: 'line', source: 'ofm', 'source-layer': 'boundary', minzoom: 3,
        filter: ['==', 'admin_level', 4],
        paint: { 'line-color': 'rgba(200,169,126,.16)', 'line-width': .6, 'line-dasharray': [2, 3] } },
      { id: 'label-country', type: 'symbol', source: 'ofm', 'source-layer': 'place',
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 1, 9, 5, 13],
          'text-transform': 'uppercase',
          'text-letter-spacing': .12,
          'text-allow-overlap': false,
        },
        paint: { 'text-color': 'rgba(240,234,214,.76)', 'text-halo-color': 'rgba(7,19,34,.94)', 'text-halo-width': 1.4 } },
      { id: 'label-state', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 3,
        filter: ['match', ['get', 'class'], ['state'], true, false],
        layout: {
          'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
          'text-letter-spacing': .06,
          'text-allow-overlap': false,
        },
        paint: { 'text-color': 'rgba(240,234,214,.52)', 'text-halo-color': 'rgba(7,19,34,.94)', 'text-halo-width': 1 } },
      { id: 'label-city', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 4,
        filter: ['match', ['get', 'class'], ['city', 'town'], true, false],
        layout: {
          'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 12, 13],
          'text-anchor': 'top',
          'text-offset': [0, .35],
          'text-allow-overlap': false,
        },
        paint: { 'text-color': 'rgba(240,234,214,.62)', 'text-halo-color': 'rgba(7,19,34,.94)', 'text-halo-width': 1 } },
    ]
  };
}
