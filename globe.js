// ============================================================
// CRUST — Globe / Map Module
// Owns everything related to the World Map overlay.
// Loaded after app.js; shares the same global scope.
// Accesses app.js globals freely: db, currentUser, openPlace(), esc()
// ============================================================
'use strict';

// ── State ─────────────────────────────────────────────────────
let _mapInstance     = null;   // MapLibre GL map instance
let _mapLoaded       = false;  // true once MapLibre has fully initialised
let _globeGLInstance = null;   // globe.gl instance
let _globeGLLoaded   = false;  // true once globe.gl has fully initialised
let _visitPoints     = null;   // shared deduped point array — fetched once, reused by both views
let _activeView      = 'map';  // 'map' | 'globe'

let _currentGlobePinPlace = null;

// ── Geo labels for globe.gl sphere ────────────────────────────
const _geoLabels = [
  { lat: 48,  lng: -100, text: 'N O R T H   A M E R I C A', size: 2.2, color: 'rgba(240,234,214,0.50)' },
  { lat: -15, lng: -55,  text: 'S O U T H   A M E R I C A', size: 2.0, color: 'rgba(240,234,214,0.50)' },
  { lat: 52,  lng: 18,   text: 'E U R O P E',                size: 1.8, color: 'rgba(240,234,214,0.50)' },
  { lat: 3,   lng: 22,   text: 'A F R I C A',                size: 2.0, color: 'rgba(240,234,214,0.50)' },
  { lat: 42,  lng: 90,   text: 'A S I A',                    size: 2.5, color: 'rgba(240,234,214,0.50)' },
  { lat: -25, lng: 134,  text: 'A U S T R A L I A',          size: 1.8, color: 'rgba(240,234,214,0.50)' },
  { lat: 30,  lng: -38,  text: 'North Atlantic Ocean',        size: 1.1, color: 'rgba(200,169,126,0.38)' },
  { lat: -28, lng: -18,  text: 'South Atlantic Ocean',        size: 1.1, color: 'rgba(200,169,126,0.38)' },
  { lat: 32,  lng: -155, text: 'North Pacific Ocean',         size: 1.1, color: 'rgba(200,169,126,0.38)' },
  { lat: -22, lng: -135, text: 'South Pacific Ocean',         size: 1.1, color: 'rgba(200,169,126,0.38)' },
  { lat: -20, lng: 76,   text: 'Indian Ocean',                size: 1.1, color: 'rgba(200,169,126,0.38)' },
];

// ── Home teaser stats ──────────────────────────────────────────
// Called by loadStats() in app.js after every visit fetch
function updateGlobeTeaser(visits) {
  const pinsEl = document.getElementById('globe-teaser-pins');
  const geoEl  = document.getElementById('globe-teaser-geo');
  if (!pinsEl || !geoEl) return;
  const mapped       = visits.filter(v => v.lat != null && v.lng != null);
  const uniquePlaces = new Set(mapped.map(v => v.placeId).filter(Boolean));
  const countries    = new Set(mapped.map(v => v.country).filter(Boolean));
  const cities       = new Set(mapped.map(v => v.city).filter(Boolean));
  pinsEl.textContent = uniquePlaces.size || mapped.length || 0;
  const parts = [];
  if (countries.size) parts.push(`${countries.size} ${countries.size === 1 ? 'country' : 'countries'}`);
  if (cities.size)    parts.push(`${cities.size} ${cities.size === 1 ? 'city' : 'cities'}`);
  geoEl.textContent = parts.join(' · ');
}

// ── Open / Close ───────────────────────────────────────────────
function openGlobe() {
  document.getElementById('globe-overlay').classList.remove('hidden');
  if (_activeView === 'map') {
    if (!_mapLoaded) {
      requestAnimationFrame(() => initMapView());
    } else if (_mapInstance) {
      requestAnimationFrame(() => _mapInstance.resize());
    }
  } else {
    if (!_globeGLLoaded) {
      requestAnimationFrame(() => initGlobeGLView());
    } else if (_globeGLInstance) {
      _globeGLInstance.controls().autoRotate = true;
    }
  }
}

function closeGlobe() {
  closeGlobePopup();
  document.getElementById('globe-overlay').classList.add('hidden');
  // Pause globe.gl auto-rotate while hidden to save GPU
  if (_globeGLInstance) _globeGLInstance.controls().autoRotate = false;
}

// ── View toggle ────────────────────────────────────────────────
function switchGlobeView(view) {
  if (_activeView === view) return;
  _activeView = view;

  // Update toggle UI
  const track      = document.getElementById('gvt-track');
  const mapLabel   = document.getElementById('gvt-map-label');
  const globeLabel = document.getElementById('gvt-globe-label');
  if (track)      track.classList.toggle('globe-mode', view === 'globe');
  if (mapLabel)   mapLabel.classList.toggle('active',   view === 'map');
  if (globeLabel) globeLabel.classList.toggle('active', view === 'globe');

  const mapContainer   = document.getElementById('globe-container');
  const globeContainer = document.getElementById('globe-gl-container');

  if (view === 'map') {
    if (globeContainer) globeContainer.classList.add('hidden');
    if (mapContainer)   mapContainer.classList.remove('hidden');
    // Stop globe.gl rotation
    if (_globeGLInstance) _globeGLInstance.controls().autoRotate = false;
    // Init or resize the flat map
    if (!_mapLoaded) {
      initMapView();
    } else if (_mapInstance) {
      _mapInstance.resize();
    }
  } else {
    if (mapContainer)   mapContainer.classList.add('hidden');
    if (globeContainer) globeContainer.classList.remove('hidden');
    // Init or resume globe.gl
    if (!_globeGLLoaded) {
      initGlobeGLView();
    } else if (_globeGLInstance) {
      _globeGLInstance.controls().autoRotate = true;
    }
  }
}

// ── Shared data fetch ──────────────────────────────────────────
// Fetches visits from Firestore and builds the deduped point array.
// Called by both initMapView() and initGlobeGLView(); result cached in _visitPoints.
async function _fetchVisitPoints() {
  if (!currentUser) return;
  const snap   = await db.collection(`users/${currentUser.uid}/visits`).get();
  const visits = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const placeMap = {};
  visits.forEach(v => {
    if (!v.placeId || v.lat == null || v.lng == null) return;
    const pid = v.placeId;
    if (!placeMap[pid]) {
      placeMap[pid] = {
        placeId:    pid,
        name:       v.placeName || 'Unknown',
        city:       v.city      || '',
        country:    v.country   || '',
        lat:        v.lat,
        lng:        v.lng,
        visitCount: 0,
        ratings:    [],
      };
    }
    placeMap[pid].visitCount++;
    if (v.rating != null) placeMap[pid].ratings.push(v.rating);
  });

  _visitPoints = Object.values(placeMap);
}

// ── Map view (MapLibre GL, flat) ───────────────────────────────
function loadMapLibre() {
  return new Promise((resolve, reject) => {
    if (window.maplibregl) { resolve(); return; }

    if (!document.querySelector('link[href*="maplibre-gl"]')) {
      const link = document.createElement('link');
      link.rel   = 'stylesheet';
      link.href  = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css';
      document.head.appendChild(link);
    }

    const s    = document.createElement('script');
    s.src      = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js';
    s.onload   = resolve;
    s.onerror  = reject;
    document.head.appendChild(s);
  });
}

async function initMapView() {
  const container = document.getElementById('globe-container');
  if (!container || !currentUser) return;
  container.innerHTML = '<div class="globe-loading">Loading map…</div>';

  try {
    await loadMapLibre();

    if (!_visitPoints) await _fetchVisitPoints();
    const points = _visitPoints || [];

    container.innerHTML = '';
    ensureCrustMapViewStyles();
    container.classList.add('crust-map-view');

    _mapInstance = new maplibregl.Map({
      container:          'globe-container',
      style:              crustMapStyle(),
      center:             [-70, 18],   // Caribbean / Puerto Rico
      zoom:               2,
      minZoom:            0.5,
      maxZoom:            18,
      attributionControl: false,
    });

    _mapInstance.on('load', async () => {
      // Globe projection — sphere at low zoom, transitions flat at street level
      try { _mapInstance.setProjection({ type: 'globe' }); } catch (_) {}

      // Fog — the "space" visible around the globe at low zoom
      try {
        _mapInstance.setFog({
          color:            '#0d1a2e',
          'high-color':     '#172338',
          'space-color':    '#141414',
          'horizon-blend':  0.08,
          'star-intensity': 0,
        });
      } catch (_) {}

      // Map pins are drawn with native circle layers so they stay crisp, centered, and logo-free.

      // GeoJSON source with native clustering
      _mapInstance.addSource('pizza-places', {
        type:  'geojson',
        data: {
          type:     'FeatureCollection',
          features: points.map(p => ({
            type:     'Feature',
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
            properties: {
              placeId:    p.placeId,
              name:       p.name,
              city:       p.city,
              country:    p.country,
              visitCount: p.visitCount,
              ratings:    JSON.stringify(p.ratings),
            }
          }))
        },
        cluster:        true,
        clusterMaxZoom: 11,
        clusterRadius:  50,
      });

      // ── Cluster pins — globe-style glow + clean count ─────────
      _mapInstance.addLayer({
        id: 'cluster-halo', type: 'circle',
        source: 'pizza-places',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color':        'rgba(216,90,48,0.34)',
          'circle-radius':       ['step', ['get', 'point_count'], 34, 5, 41, 15, 48],
          'circle-blur':         0.62,
          'circle-opacity':      1,
        }
      });

      _mapInstance.addLayer({
        id: 'clusters', type: 'circle',
        source: 'pizza-places',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color':        '#D85A30',
          'circle-radius':       ['step', ['get', 'point_count'], 18, 5, 21, 15, 24],
          'circle-stroke-width': 2.4,
          'circle-stroke-color': 'rgba(240,234,214,0.46)',
        }
      });

      _mapInstance.addLayer({
        id: 'cluster-inner', type: 'circle',
        source: 'pizza-places',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color':        'rgba(240,234,214,0.22)',
          'circle-radius':       ['step', ['get', 'point_count'], 11, 5, 13, 15, 15],
          'circle-stroke-width': 1,
          'circle-stroke-color': 'rgba(240,234,214,0.42)',
        }
      });

      // ── Cluster count label ──────────────────────────────────
      _mapInstance.addLayer({
        id: 'cluster-count', type: 'symbol',
        source: 'pizza-places',
        filter: ['has', 'point_count'],
        layout: {
          'text-field':         '{point_count_abbreviated}',
          'text-font':          ['Noto Sans Regular'],
          'text-size':          13,
          'text-allow-overlap': true,
        },
        paint: {
          'text-color':      '#F0EAD6',
          'text-halo-color': 'rgba(20,20,20,0.42)',
          'text-halo-width': 0.8,
        }
      });

      // ── Individual pizza pins — same visual language as globe ─
      _mapInstance.addLayer({
        id: 'unclustered-halo', type: 'circle',
        source: 'pizza-places',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color':   'rgba(216,90,48,0.38)',
          'circle-radius':  30,
          'circle-blur':    0.62,
          'circle-opacity': 1,
        }
      });

      _mapInstance.addLayer({
        id: 'unclustered-point', type: 'circle',
        source: 'pizza-places',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color':        '#D85A30',
          'circle-radius':       14,
          'circle-stroke-width': 2.3,
          'circle-stroke-color': 'rgba(240,234,214,0.50)',
        }
      });

      _mapInstance.addLayer({
        id: 'unclustered-ring', type: 'circle',
        source: 'pizza-places',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color':        '#F0EAD6',
          'circle-radius':       8.5,
          'circle-stroke-width': 1,
          'circle-stroke-color': 'rgba(200,169,126,0.55)',
        }
      });

      _mapInstance.addLayer({
        id: 'unclustered-dot', type: 'circle',
        source: 'pizza-places',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color':  '#FFFFFF',
          'circle-radius': 4,
        }
      });

      // ── Cluster tap → zoom in to expand ─────────────────────
      _mapInstance.on('click', 'clusters', e => {
        e.originalEvent.stopPropagation();
        const features = _mapInstance.queryRenderedFeatures(e.point, { layers: ['clusters'] });
        if (!features.length) return;
        const clusterId = features[0].properties.cluster_id;
        _mapInstance.getSource('pizza-places').getClusterExpansionZoom(clusterId, (err, zoom) => {
          if (!err) _mapInstance.easeTo({ center: features[0].geometry.coordinates, zoom: zoom + 0.5, duration: 500 });
        });
      });

      // ── Pin tap → info popup ─────────────────────────────────
      _mapInstance.on('click', 'unclustered-point', e => {
        e.originalEvent.stopPropagation();
        const props   = e.features[0].properties;
        const ratings = typeof props.ratings === 'string' ? JSON.parse(props.ratings) : (props.ratings || []);
        showGlobePopup({ ...props, ratings });
      });

      // Cursor hints on desktop
      ['clusters', 'unclustered-point'].forEach(layer => {
        _mapInstance.on('mouseenter', layer, () => { _mapInstance.getCanvas().style.cursor = 'pointer'; });
        _mapInstance.on('mouseleave', layer, () => { _mapInstance.getCanvas().style.cursor = ''; });
      });

      _mapLoaded = true;
    });

    // Map tap outside pins → dismiss popup
    _mapInstance.on('click', closeGlobePopup);

  } catch (e) {
    console.error('initMapView:', e);
    const c = document.getElementById('globe-container');
    if (c) c.innerHTML = '<div class="globe-loading">Couldn\'t load map.</div>';
  }
}

// ── Globe view (globe.gl, 3D sphere) ──────────────────────────
function loadGlobeGLScript() {
  return new Promise((resolve, reject) => {
    if (window.Globe) { resolve(); return; }
    const s    = document.createElement('script');
    s.src      = 'https://unpkg.com/globe.gl@2/dist/globe.gl.min.js';
    s.onload   = resolve;
    s.onerror  = reject;
    document.head.appendChild(s);
  });
}

async function initGlobeGLView() {
  const container = document.getElementById('globe-gl-container');
  if (!container || !currentUser) return;
  container.innerHTML = '<div class="globe-loading">Loading globe…</div>';

  try {
    await loadGlobeGLScript();

    if (!_visitPoints) await _fetchVisitPoints();
    const points = _visitPoints || [];

    container.innerHTML = '';

    // ── Arcs: radiate from most-visited spot to all others ───────
    // (same pattern as Tripsy flight paths — home → destinations)
    const origin = points.length
      ? points.reduce((best, p) => p.visitCount > best.visitCount ? p : best, points[0])
      : null;
    const arcs = origin
      ? points
          .filter(p => p.placeId !== origin.placeId)
          .map(p => ({ startLat: origin.lat, startLng: origin.lng, endLat: p.lat, endLng: p.lng }))
      : [];

    _globeGLInstance = Globe()(container)
      .backgroundColor('#141414')
      .showAtmosphere(true)
      .atmosphereColor('#C8A97E')
      .atmosphereAltitude(0.20)
      // Earth texture: night side shows city-light glow + subtle continent shapes
      .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-night.jpg')
      // Bump map: adds terrain relief so continents catch the amber atmosphere light
      .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')

      // ── Crust HTML globe pins ─────────────────────────────────
      // Fixed-screen-size HTML pins keep the original Crust glow style
      // and avoid the oversized globe.gl cylinder / bullseye look when zoomed in.
      .htmlElementsData(points)
      .htmlLat('lat')
      .htmlLng('lng')
      .htmlAltitude(0.006)
      .htmlElement(buildCrustGlobeMarker)

      // ── Glowing pulse rings ────────────────────────────────────
      // pow(1-t, 0.6) keeps ring more opaque longer = clear terracotta glow
      .ringsData(points)
      .ringLat('lat')
      .ringLng('lng')
      .ringColor(() => t => `rgba(216,90,48,${Math.max(0, Math.pow(1 - t, 0.6))})`)
      .ringMaxRadius(1.8)
      .ringPropagationSpeed(0.8)
      .ringRepeatPeriod(1200)
      .ringAltitude(0.001)

      // ── Animated arcs from home → destinations ─────────────────
      .arcsData(arcs)
      .arcStartLat('startLat')
      .arcStartLng('startLng')
      .arcEndLat('endLat')
      .arcEndLng('endLng')
      .arcColor(() => ['rgba(216,90,48,0.05)', 'rgba(216,90,48,0.92)'])
      .arcDashLength(0.28)
      .arcDashGap(0.72)
      .arcDashAnimateTime(4000)
      .arcStroke(0.40)
      .arcAltitudeAutoScale(0.38)

      // ── Continent + ocean labels ───────────────────────────────
      .labelsData(_geoLabels)
      .labelText('text')
      .labelLat('lat')
      .labelLng('lng')
      .labelSize('size')
      .labelColor('color')
      .labelDotRadius(0)
      .labelResolution(2);

    // Start centered on the user's home base (most-visited point or default PR)
    const homeLat = origin ? origin.lat : 18;
    const homeLng = origin ? origin.lng : -66;
    _globeGLInstance.pointOfView({ lat: homeLat, lng: homeLng, altitude: 2.0 });

    // Auto-rotate — pauses the moment user touches the globe
    _globeGLInstance.controls().autoRotate      = true;
    _globeGLInstance.controls().autoRotateSpeed = 0.5;
    _globeGLInstance.controls().enableDamping   = true;

    container.addEventListener('pointerdown', () => {
      if (_globeGLInstance) _globeGLInstance.controls().autoRotate = false;
    }, { passive: true });

    _globeGLLoaded = true;

  } catch (e) {
    console.error('initGlobeGLView:', e);
    const c = document.getElementById('globe-gl-container');
    if (c) c.innerHTML = '<div class="globe-loading">Couldn\'t load globe.</div>';
  }
}

// ── Crust dark map style (MapLibre) ───────────────────────────
// OpenFreeMap vector tiles — free, no API key required.
// Labels (country → state → city) built into tile data.

// ── Map view polish — scoped to globe/map overlay only ─────────
function ensureCrustMapViewStyles() {
  if (document.getElementById('crust-map-view-styles')) return;
  const style = document.createElement('style');
  style.id = 'crust-map-view-styles';
  style.textContent = `
    #globe-container.crust-map-view {
      position:relative;
      background:#061426;
    }
    #globe-container.crust-map-view::after {
      content:'';
      position:absolute;
      inset:0;
      pointer-events:none;
      z-index:2;
      background:
        radial-gradient(circle at 50% 48%, rgba(255,255,255,0.018) 0%, rgba(255,255,255,0) 48%),
        linear-gradient(to bottom, rgba(20,20,20,.10) 0%, rgba(20,20,20,0) 20%, rgba(20,20,20,0) 76%, rgba(20,20,20,.15) 100%);
    }
    #globe-container.crust-map-view .maplibregl-canvas {
      filter:saturate(1.02) contrast(1.12) brightness(.98);
    }
  `;
  document.head.appendChild(style);
}

function crustMapStyle() {
  return {
    version:    8,
    projection: { type: 'globe' },
    fog: {
      color:            '#0d1a2e',
      'high-color':     '#172338',
      'space-color':    '#141414',
      'horizon-blend':  0.08,
      'star-intensity': 0,
    },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      ofm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' }
    },
    layers: [
      { id: 'bg',    type: 'background', paint: { 'background-color': '#142238' } },
      { id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water',
        paint: { 'fill-color': '#061326' } },
      { id: 'border-country', type: 'line', source: 'ofm', 'source-layer': 'boundary',
        filter: ['all', ['==', 'admin_level', 2], ['!=', 'maritime', 1]],
        paint: {
          'line-color': 'rgba(200,169,126,0.34)',
          'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.55, 6, 1.65],
        } },
      { id: 'border-state', type: 'line', source: 'ofm', 'source-layer': 'boundary',
        filter: ['==', 'admin_level', 4], minzoom: 3,
        paint: {
          'line-color':      'rgba(200,169,126,0.22)',
          'line-width':      ['interpolate', ['linear'], ['zoom'], 3, 0.55, 8, 1.0],
          'line-dasharray':  [2, 3],
        } },
      { id: 'label-country', type: 'symbol', source: 'ofm', 'source-layer': 'place',
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field':          ['coalesce', ['get', 'name_en'], ['get', 'name']],
          'text-font':           ['Noto Sans Regular'],
          'text-size':           ['interpolate', ['linear'], ['zoom'], 1, 9, 5, 13],
          'text-transform':      'uppercase',
          'text-letter-spacing': 0.12,
          'text-allow-overlap':  false,
        },
        paint: {
          'text-color':      'rgba(240,234,214,0.76)',
          'text-halo-color': 'rgba(6,18,36,0.94)',
          'text-halo-width': 1.5,
        } },
      { id: 'label-state', type: 'symbol', source: 'ofm', 'source-layer': 'place',
        filter: ['match', ['get', 'class'], ['state'], true, false],
        minzoom: 3,
        layout: {
          'text-field':          ['coalesce', ['get', 'name_en'], ['get', 'name']],
          'text-font':           ['Noto Sans Regular'],
          'text-size':           10,
          'text-letter-spacing': 0.06,
          'text-allow-overlap':  false,
        },
        paint: {
          'text-color':      'rgba(240,234,214,0.58)',
          'text-halo-color': 'rgba(6,18,36,0.94)',
          'text-halo-width': 1,
        } },
      { id: 'label-city', type: 'symbol', source: 'ofm', 'source-layer': 'place',
        filter: ['match', ['get', 'class'], ['city', 'town'], true, false],
        minzoom: 4,
        layout: {
          'text-field':         ['coalesce', ['get', 'name_en'], ['get', 'name']],
          'text-font':          ['Noto Sans Regular'],
          'text-size':          ['interpolate', ['linear'], ['zoom'], 4, 9, 12, 13],
          'text-anchor':        'top',
          'text-offset':        [0, 0.3],
          'text-allow-overlap': false,
        },
        paint: {
          'text-color':      'rgba(240,234,214,0.66)',
          'text-halo-color': 'rgba(6,18,36,0.94)',
          'text-halo-width': 1,
        } },
    ],
  };
}


// ── Globe HTML pin marker ─────────────────────────────────────
// Matches the smaller glowing Crust pin style from the original globe build.
// Kept self-contained here so no non-globe CSS has to be touched.
function buildCrustGlobeMarker(d) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'crust-globe-pin';
  el.setAttribute('aria-label', `${d.name || 'Pizza place'}${d.city ? ', ' + d.city : ''}`);

  const countBadge = d.visitCount > 1
    ? `<span class="crust-globe-pin-count">${d.visitCount}</span>`
    : '';

  el.innerHTML = `
    <span class="crust-globe-pin-halo crust-globe-pin-halo--one"></span>
    <span class="crust-globe-pin-halo crust-globe-pin-halo--two"></span>
    <span class="crust-globe-pin-core">
      <span class="crust-globe-pin-ring"></span>
      <span class="crust-globe-pin-dot"></span>
    </span>
    ${countBadge}
  `;

  el.style.cssText = `
    --pin-size:${d.visitCount > 1 ? '34px' : '30px'};
    position:absolute;
    width:var(--pin-size);
    height:var(--pin-size);
    margin-left:calc(var(--pin-size) / -2);
    margin-top:calc(var(--pin-size) / -2);
    padding:0;
    border:0;
    border-radius:50%;
    background:transparent;
    cursor:pointer;
    transform:translateZ(0);
    pointer-events:auto;
    filter:drop-shadow(0 3px 10px rgba(0,0,0,.58));
  `;

  const style = document.createElement('style');
  if (!document.getElementById('crust-globe-pin-styles')) {
    style.id = 'crust-globe-pin-styles';
    style.textContent = `
      .crust-globe-pin * { box-sizing:border-box; pointer-events:none; }
      .crust-globe-pin-halo {
        position:absolute;
        inset:-9px;
        border-radius:50%;
        border:1px solid rgba(216,90,48,.30);
        background:radial-gradient(circle, rgba(216,90,48,.24) 0%, rgba(216,90,48,.13) 38%, rgba(216,90,48,0) 72%);
        animation:crustGlobePinPulse 1.9s ease-out infinite;
      }
      .crust-globe-pin-halo--two {
        inset:-16px;
        opacity:.36;
        animation-delay:.42s;
      }
      .crust-globe-pin-core {
        position:absolute;
        inset:0;
        border-radius:50%;
        display:flex;
        align-items:center;
        justify-content:center;
        background:#D85A30;
        box-shadow:
          0 0 0 2px rgba(200,169,126,.55),
          0 0 15px rgba(216,90,48,.72),
          0 0 28px rgba(216,90,48,.42);
      }
      .crust-globe-pin-ring {
        position:absolute;
        inset:7px;
        border-radius:50%;
        background:#F0EAD6;
        box-shadow:inset 0 0 0 1px rgba(200,169,126,.62);
      }
      .crust-globe-pin-dot {
        position:absolute;
        width:8px;
        height:8px;
        border-radius:50%;
        background:#fff;
        box-shadow:0 0 10px rgba(255,255,255,.50);
      }
      .crust-globe-pin-count {
        position:absolute;
        top:-7px;
        right:-7px;
        min-width:18px;
        height:18px;
        padding:0 4px;
        border-radius:999px;
        display:flex;
        align-items:center;
        justify-content:center;
        background:#C8A97E;
        color:#141414;
        border:1px solid rgba(20,20,20,.42);
        font-family:'Outfit',sans-serif;
        font-size:10px;
        font-weight:700;
        line-height:1;
        box-shadow:0 2px 7px rgba(0,0,0,.46);
      }
      @keyframes crustGlobePinPulse {
        0%   { transform:scale(.72); opacity:.70; }
        70%  { transform:scale(1.34); opacity:.10; }
        100% { transform:scale(1.48); opacity:0; }
      }
    `;
    document.head.appendChild(style);
  }

  el.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    showGlobePopup(d);
  });

  return el;
}

// ── MapLibre pizza pin image ───────────────────────────────────
// Physical size 56×72px at pixelRatio:2 → renders at 28×36 CSS px.
// Symbol layers render as GL images — never drift or misplace on iOS.
function createPinImage() {
  const svg = `<svg width="56" height="72" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
    <path d="M14 0C6.3 0 0 6.3 0 14C0 24.5 14 36 14 36C14 36 28 24.5 28 14C28 6.3 21.7 0 14 0Z" fill="#D85A30"/>
    <g transform="translate(1.43 -2.71) scale(0.3143)">
      <path d="M 40 50 L 63 34 A 28 28 0 1 0 63 66 Z" fill="#F0EAD6"/>
      <path d="M 63 34 A 28 28 0 1 0 63 66" stroke="#C8A97E" stroke-width="4.5" fill="none" stroke-linecap="round"/>
      <circle cx="26" cy="42" r="3"   fill="#C8A97E" opacity="0.7"/>
      <circle cx="22" cy="55" r="2.4" fill="#C8A97E" opacity="0.7"/>
      <circle cx="40" cy="35" r="2.4" fill="#C8A97E" opacity="0.7"/>
      <circle cx="37" cy="63" r="2.4" fill="#C8A97E" opacity="0.7"/>
      <path d="M 64 50 L 87 34 A 28 28 0 0 1 87 66 Z" fill="#F0EAD6"/>
      <path d="M 87 34 A 28 28 0 0 1 87 66" stroke="#C8A97E" stroke-width="4.5" fill="none" stroke-linecap="round"/>
      <circle cx="76" cy="44" r="2.2" fill="#C8A97E" opacity="0.7"/>
      <circle cx="77" cy="57" r="2.2" fill="#C8A97E" opacity="0.7"/>
    </g>
  </svg>`;
  return new Promise(resolve => {
    const img   = new Image(56, 72);
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

// ── HTML fallback pin (not used in primary flow) ───────────────
function buildGlobePin(d) {
  const el = document.createElement('div');
  el.style.cssText = 'position:relative;display:inline-block;cursor:pointer;filter:drop-shadow(0 2px 7px rgba(0,0,0,0.6));';
  el.innerHTML = `
    <svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 0C6.3 0 0 6.3 0 14C0 24.5 14 36 14 36C14 36 28 24.5 28 14C28 6.3 21.7 0 14 0Z" fill="#D85A30"/>
      <g transform="translate(-1.71 -6.64) scale(0.3929)">
        <path d="M 40 50 L 63 34 A 28 28 0 1 0 63 66 Z" fill="#F0EAD6"/>
        <path d="M 63 34 A 28 28 0 1 0 63 66" stroke="#C8A97E" stroke-width="4.5" fill="none" stroke-linecap="round"/>
        <circle cx="26" cy="42" r="3"   fill="#C8A97E" opacity="0.7"/>
        <circle cx="22" cy="55" r="2.4" fill="#C8A97E" opacity="0.7"/>
        <circle cx="40" cy="35" r="2.4" fill="#C8A97E" opacity="0.7"/>
        <circle cx="37" cy="63" r="2.4" fill="#C8A97E" opacity="0.7"/>
        <path d="M 64 50 L 87 34 A 28 28 0 0 1 87 66 Z" fill="#F0EAD6"/>
        <path d="M 87 34 A 28 28 0 0 1 87 66" stroke="#C8A97E" stroke-width="4.5" fill="none" stroke-linecap="round"/>
        <circle cx="76" cy="44" r="2.2" fill="#C8A97E" opacity="0.7"/>
        <circle cx="77" cy="57" r="2.2" fill="#C8A97E" opacity="0.7"/>
      </g>
    </svg>
    ${d.visitCount > 1 ? `<div style="position:absolute;top:-4px;right:-5px;background:#C8A97E;color:#141414;border-radius:50%;width:14px;height:14px;font-size:8px;font-weight:700;display:flex;align-items:center;justify-content:center;font-family:'Outfit',sans-serif;line-height:1;border:1px solid rgba(20,20,20,0.3);">${d.visitCount}</div>` : ''}
  `;
  el.addEventListener('click', e => { e.stopPropagation(); showGlobePopup(d); });
  return el;
}

// ── Pin popup (shared by both map and globe views) ─────────────
function showGlobePopup(d) {
  _currentGlobePinPlace = d.placeId;
  const avg = d.ratings && d.ratings.length
    ? (d.ratings.reduce((s, r) => s + r, 0) / d.ratings.length).toFixed(1)
    : null;
  document.getElementById('globe-pin-popup-body').innerHTML = `
    <div class="globe-popup-name">${esc(d.name)}</div>
    <div class="globe-popup-loc">${[d.city, d.country].filter(Boolean).map(s => esc(s)).join(' · ')}</div>
    <div class="globe-popup-meta">
      ${avg ? `<div class="globe-popup-rating">${avg}<span> / 10</span></div>` : ''}
      <div class="globe-popup-visits">${d.visitCount} ${d.visitCount === 1 ? 'visit' : 'visits'}</div>
    </div>
  `;
  const popup = document.getElementById('globe-pin-popup');
  popup.classList.remove('hidden');

  popup.onclick = e => e.stopPropagation();

  // Swipe down to dismiss
  let _ty0 = 0;
  popup.ontouchstart = e => { _ty0 = e.touches[0].clientY; };
  popup.ontouchend   = e => { if (e.changedTouches[0].clientY - _ty0 > 60) closeGlobePopup(); };
}

function closeGlobePopup() {
  const el = document.getElementById('globe-pin-popup');
  if (el) el.classList.add('hidden');
  _currentGlobePinPlace = null;
}

function viewGlobePlace() {
  const pid = _currentGlobePinPlace;
  closeGlobePopup();
  closeGlobe();
  if (pid) setTimeout(() => openPlace(pid), 320);
}
