// ============================================================
// CRUST — Main Application
// ============================================================
'use strict';

// ── State ────────────────────────────────────────────────────
let currentUser   = null;
let currentScreen = 'home';
let selectedStyles = [];
let selectedRating = 8.0;
let selectedPlace  = null;   // { placeId, name, address, city, country, lat, lng }
let selectedPhoto  = null;   // File object
let autocompleteSession = null;
let editingVisitId  = null;   // null = new entry, string id = editing
let existingPhotoUrl = null;  // used when editing an entry that already has a photo
let _streakStartDate = null;  // loaded from Firestore settings

// Phase 3B state additions
let _destGroups              = [];    // sorted destination groups — index used in onclick
let _destCovers              = {};    // custom cover photos: coverKey → photoUrl
let _pendingFeedOpenId       = null;  // set by home strip tap; openFeedPhoto() consumes it
let _feedSort                = 'date'; // 'date' | 'rating'
let _feedCurrentFilteredList = [];    // currently visible photos for swipe nav
let _feedCurrentIdx          = 0;
let _placeLogos              = {};    // placeId → logoUrl (cached for entry cards)

// ── Screen Restore ───────────────────────────────────────────
const MAIN_SCREEN_IDS = new Set(['home', 'journey', 'places', 'passport', 'feed']);

function getSavedMainScreen() {
  try {
    const saved = localStorage.getItem('crust:lastScreen');
    return MAIN_SCREEN_IDS.has(saved) ? saved : 'home';
  } catch (_) {
    return 'home';
  }
}

function rememberMainScreen(id) {
  if (!MAIN_SCREEN_IDS.has(id)) return;
  try { localStorage.setItem('crust:lastScreen', id); } catch (_) {}
}

// ── Toast ────────────────────────────────────────────────────
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = type;
  el.classList.add('visible');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('visible'), 3000);
}

// ── Router ───────────────────────────────────────────────────
function navigate(id) {
  const prev = document.querySelector('.screen.active');
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active', 'screen-enter', 'screen-enter-active');
  });

  const s = document.getElementById(`screen-${id}`);
  if (s) {
    s.classList.add('active');
    currentScreen = id;
    rememberMainScreen(id);

    // Tiny final-motion pass: gives bottom-nav screen changes a subtle
    // native-feeling fade/slide without changing layout or data logic.
    if (prev && prev !== s && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      s.classList.add('screen-enter');
      requestAnimationFrame(() => {
        s.classList.add('screen-enter-active');
        window.setTimeout(() => {
          s.classList.remove('screen-enter', 'screen-enter-active');
        }, 220);
      });
    }
  }

  document.querySelectorAll('.nav-btn[data-screen], .nav-fab[data-screen]').forEach(b => {
    b.classList.toggle('active', b.dataset.screen === id);
  });

  // Scroll to top on navigation
  if (s) s.scrollTop = 0;

  // Load screen data
  if (id === 'home')     loadHome();
  if (id === 'journey')  loadJourney();
  if (id === 'places')   loadPlaces();
  if (id === 'passport') loadPassport();
  if (id === 'feed')     loadFeed();
}

// ── Auth ─────────────────────────────────────────────────────
auth.onAuthStateChanged(user => {
  document.getElementById('loading-overlay').classList.add('hidden');
  if (user) {
    currentUser = user;
    document.getElementById('auth-screen').classList.remove('visible');
    document.getElementById('app').style.display = 'flex';
    renderAvatar(user);
    navigate(getSavedMainScreen());
  } else {
    currentUser = null;
    document.getElementById('app').style.display = 'none';
    document.getElementById('auth-screen').classList.add('visible');
  }
});

document.getElementById('google-signin-btn').addEventListener('click', async () => {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await auth.signInWithPopup(provider);
  } catch (e) {
    console.error(e);
    toast('Sign-in failed — try again.', 'error');
  }
});

function renderAvatar(user) {
  const c = document.getElementById('avatar-wrap');
  if (user.photoURL) {
    c.innerHTML = `<img src="${user.photoURL}" class="user-avatar" alt="You" onclick="profileMenu()">`;
  } else {
    const init = (user.displayName || user.email || 'U')[0].toUpperCase();
    c.innerHTML = `<div class="avatar-initial" onclick="profileMenu()">${init}</div>`;
  }
}

function profileMenu() {
  if (confirm('Sign out of Crust?')) {
    auth.signOut();
  }
}

// ── Home Screen ──────────────────────────────────────────────
async function loadHome() {
  if (!currentUser) return;
  const uid = currentUser.uid;
  // Load logos in background so entry cards can show them
  db.collection(`users/${uid}/places`).get().then(snap => {
    snap.docs.forEach(d => { const p = d.data(); if (p.logoUrl) _placeLogos[p.placeId || d.id] = p.logoUrl; });
  }).catch(() => {});
  await Promise.all([loadStats(uid), loadRecent(uid), loadPhotoGrid(uid)]);
}

async function loadStats(uid) {
  try {
    const [visitsSnap, settingsSnap] = await Promise.all([
      db.collection(`users/${uid}/visits`).get(),
      db.collection(`users/${uid}/settings`).doc('streakSettings').get().catch(() => null),
    ]);
    const visits = visitsSnap.docs.map(d => d.data());
    _streakStartDate = (settingsSnap && settingsSnap.exists)
      ? (settingsSnap.data().startDate || null) : null;

    const pies      = visits.length;
    const spots     = new Set(visits.map(v => v.placeId).filter(Boolean)).size;
    const cities    = new Set(visits.map(v => v.city).filter(Boolean)).size;
    const countries = new Set(visits.map(v => v.country).filter(Boolean)).size;
    const streak    = calcSundayStreak(visits, _streakStartDate);

    set('stat-pies',      pies);
    set('stat-spots',     spots);
    set('stat-cities',    cities);
    set('stat-countries', countries);
    set('stat-streak',   streak);
    set('streak-status', streakLabel(streak, _streakStartDate));
    set('globe-teaser-cities',    cities);
    set('globe-teaser-countries', countries);
    updateGlobeTeaser(visits);
  } catch (e) {
    console.error('loadStats:', e);
  }
}

function set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function streakLabel(n, startDate = null) {
  if (n === 0) return 'Tap to set your start date';
  if (startDate) {
    const d = new Date(startDate + 'T00:00:00');
    if (!isNaN(d)) {
      return `Since ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
  }
  if (n === 1) return '1 Sunday strong 🍕';
  return `${n} Sundays straight`;
}

// Sunday streak: counts consecutive Sundays with at least one logged visit,
// walking backward from the most recent Sunday (or today if today is Sunday).
// Backdating always allowed — streak recalculates from all stored data.
// startDate (YYYY-MM-DD string) optionally ignores Sundays before that date.
function calcSundayStreak(visits, startDate = null) {
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);

  if (startDate) {
    // ── DECLARED MODE ────────────────────────────────────────────
    // User vouches for the streak starting on this date.
    // Count ALL Sundays from startDate through today — no gap checking.
    const start = new Date(startDate + 'T00:00:00');
    if (isNaN(start)) return 0;

    let count = 0;
    const cur = new Date(start);
    // Advance to first Sunday on or after start date
    while (cur.getDay() !== 0) cur.setDate(cur.getDate() + 1);
    // Count every Sunday up to and including today
    while (cur <= todayDate) {
      count++;
      cur.setDate(cur.getDate() + 7);
    }
    return count;
  }

  // ── CONSECUTIVE MODE (no startDate set) ──────────────────────
  const sundaySet = new Set();
  visits.forEach(v => {
    const d = v.date?.toDate ? v.date.toDate() : (v.date ? new Date(v.date) : null);
    if (!d || isNaN(d)) return;
    if (d.getDay() === 0) sundaySet.add(ymd(d));
  });
  if (!sundaySet.size) return 0;

  const offset = todayDate.getDay();
  const anchor = new Date(todayDate);
  anchor.setDate(todayDate.getDate() - offset);

  // If today is Sunday and not yet logged, fall back to last Sunday
  if (todayDate.getDay() === 0 && !sundaySet.has(ymd(anchor))) {
    anchor.setDate(anchor.getDate() - 7);
  }
  if (!sundaySet.has(ymd(anchor))) return 0;

  let streak = 0;
  const cur = new Date(anchor);
  while (sundaySet.has(ymd(cur))) {
    streak++;
    cur.setDate(cur.getDate() - 7);
  }
  return streak;
}

function ymd(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// ── Home Photo Grid (Option D) ────────────────────────────────
async function loadPhotoGrid(uid) {
  const section = document.getElementById('home-photo-strip-section');
  const grid    = document.getElementById('home-photo-grid');
  if (!grid || !section) return;
  try {
    const snap = await db.collection(`users/${uid}/visits`)
      .orderBy('date', 'desc')
      .limit(30)
      .get();
    const withPhotos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(v => v.photoUrl).slice(0, 3);
    if (!withPhotos.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    grid.innerHTML = withPhotos.map(v =>
      `<div class="home-photo-cell" onclick="openFeedFromPhoto('${v.id}')">
        <img src="${esc(v.photoUrl)}" loading="lazy" />
      </div>`
    ).join('');
  } catch(e) {
    console.error('loadPhotoGrid:', e);
    if (section) section.style.display = 'none';
  }
}

function openFeedFromPhoto(id) {
  _pendingFeedOpenId = id;
  navigate('feed');
}

async function loadRecent(uid) {  const container = document.getElementById('recent-entries');
  try {
    const snap = await db.collection(`users/${uid}/visits`)
      .orderBy('date', 'desc')
      .limit(5)
      .get();

    if (snap.empty) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🍕</div>
          <div class="empty-title">No pizzas logged yet</div>
          <div class="empty-body">Tap + to log your first pizza.</div>
        </div>`;
      return;
    }
    container.innerHTML = snap.docs.map(d => entryCard(d.id, d.data(), 'open-place')).join('');
    initSwipeCards();
  } catch (e) {
    console.error('loadRecent:', e);
    container.innerHTML = `<div class="empty-state"><div class="empty-body">Couldn't load entries.</div></div>`;
  }
}

// context = 'open-place' → tap opens the restaurant/place detail (used on Home)
// context = 'open-entry' → tap opens the individual visit detail (used on Journey & Place detail)
function entryCard(id, v, context = 'open-entry') {
  const d    = v.date?.toDate ? v.date.toDate() : new Date(v.date);
  const dStr = isNaN(d) ? '' : d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  const tags = (v.styles || []).slice(0,2).map(s => `<span class="style-tag">${esc(s)}</span>`).join('');
  const thumb = v.photoUrl
    ? `<img src="${esc(v.photoUrl)}" class="entry-thumb" loading="lazy" />`
    : `<div class="entry-thumb-placeholder" aria-label="No pizza photo">${pizzaPlaceholderSvg(30)}</div>`;
  const tapFn = (context === 'open-place' && v.placeId)
    ? `openPlace('${esc(v.placeId)}')`
    : `openEntry('${id}')`;

  // Place logo: small circle before place name
  const logoUrl = v.placeId ? (_placeLogos[v.placeId] || null) : null;
  const logoHtml = logoUrl
    ? `<span class="entry-place-logo"><img src="${esc(logoUrl)}" loading="lazy" /></span>`
    : '';

  return `
    <div class="swipe-wrapper" data-entry-id="${id}">
      <div class="swipe-reveal swipe-reveal-edit">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Edit
      </div>
      <div class="swipe-reveal swipe-reveal-delete">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        Delete
      </div>
      <div class="entry-card" onclick="${tapFn}">
        ${thumb}
        <div class="entry-body">
          <div class="entry-place-row">
            ${logoHtml}
            <div class="entry-place">${esc(v.placeName || 'Unknown')}</div>
          </div>
          <div class="entry-sub">${esc(v.city || '')}${v.city && dStr ? ' · ' : ''}${dStr}</div>
          <div class="entry-tags">${tags}</div>
        </div>
        <div class="entry-right">
          <div class="entry-rating-num">${formatRating(v.rating)}</div>
        </div>
      </div>
    </div>`;
}

// ── Entry Detail + Edit + Delete ─────────────────────────────
let _detailVisitId   = null;
let _detailVisitData = null;

async function openEntry(id) {
  if (!currentUser) return;
  _detailVisitId = id;
  _detailVisitData = null;

  const overlay = document.getElementById('entry-detail-overlay');
  const body    = document.getElementById('detail-body');
  overlay.classList.remove('hidden');
  body.innerHTML = '<div style="text-align:center;padding:48px;opacity:.35;font-size:14px;">Loading…</div>';

  try {
    const snap = await db.collection(`users/${currentUser.uid}/visits`).doc(id).get();
    if (!snap.exists) {
      overlay.classList.add('hidden');
      toast('Entry not found', 'error');
      return;
    }
    _detailVisitData = snap.data();
    const v    = _detailVisitData;
    const d    = v.date?.toDate ? v.date.toDate() : new Date(v.date);
    const dStr = isNaN(d) ? '' : d.toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
    const tags = (v.styles || []).map(s => `<span class="style-tag">${esc(s)}</span>`).join('');
    const loc  = [v.city, v.country].filter(Boolean).join(', ');

    body.innerHTML = `
      ${v.photoUrl ? `<img src="${esc(v.photoUrl)}" class="detail-photo" />` : ''}
      <div class="detail-place-name">${esc(v.placeName || 'Unknown')}</div>
      ${loc ? `<div class="detail-location-line">${esc(loc)}</div>` : ''}
      <div class="detail-meta-row detail-meta-grid">
        <div class="detail-meta-item">
          <div class="detail-meta-label">Rating</div>
          <div class="detail-rating-big">${formatRating(v.rating)}</div>
        </div>
        <div class="detail-meta-item">
          <div class="detail-meta-label">Date</div>
          <div class="detail-date-str">${dStr}</div>
        </div>
      </div>
      ${tags ? `<div class="detail-tags-row">${tags}</div>` : ''}
      ${v.notes ? `<div class="detail-notes-box">${esc(v.notes)}</div>` : ''}
    `;
  } catch (e) {
    console.error('openEntry:', e);
    body.innerHTML = '<div style="text-align:center;padding:48px;opacity:.35;font-size:14px;">Couldn\'t load entry.</div>';
  }
}

function closeEntryDetail() {
  const overlay = document.getElementById('entry-detail-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    overlay.style.zIndex = '';
    delete overlay.dataset.returnTo;
  }
  _detailVisitId   = null;
  _detailVisitData = null;
}

function startEditEntry() {
  if (!_detailVisitId || !_detailVisitData) return;
  const id = _detailVisitId;
  const v  = _detailVisitData;

  editingVisitId = id;
  resetLog(); // clears state and resets form

  // Pre-fill place
  document.getElementById('place-input').value = v.placeName || '';
  selectedPlace = {
    placeId: v.placeId,
    name:    v.placeName,
    address: v.address || '',
    city:    v.city    || '',
    country: v.country || '',
    lat:     v.lat     ?? null,
    lng:     v.lng     ?? null,
  };

  // Show city/country row pre-filled
  qv('override-city',    v.city    || '');
  qv('override-country', v.country || '');
  const locRow = document.getElementById('place-location-row');
  if (locRow) locRow.classList.add('visible');

  // Date
  const d = v.date?.toDate ? v.date.toDate() : new Date(v.date);
  if (!isNaN(d)) {
    qv('log-date', d.toISOString().split('T')[0]);
  }

  // Rating
  selectedRating = v.rating ?? 8.0;
  qv('rating-slider', selectedRating);
  document.getElementById('rating-display').textContent = selectedRating.toFixed(1);

  // Styles
  selectedStyles = v.styles || [];
  renderLogStyleSummary();
  renderStyleSheetOptions();

  // Notes
  qv('log-notes', v.notes || '');

  // Existing photo
  existingPhotoUrl = v.photoUrl || null;
  if (v.photoUrl) {
    const pa = document.getElementById('photo-area-inner');
    if (pa) pa.innerHTML = photoAreaPreview(v.photoUrl);
  }

  // Update log screen title and button
  const logTitle = document.getElementById('log-title');
  if (logTitle) logTitle.textContent = 'Edit Entry';
  const saveBtn = document.getElementById('save-btn');
  if (saveBtn) saveBtn.textContent = 'Save Changes';

  // Close both overlays (edit can be triggered from entry detail OR swipe in place detail)
  document.getElementById('entry-detail-overlay')?.classList.add('hidden');
  document.getElementById('place-detail-overlay')?.classList.add('hidden');
  navigate('log');
}

async function confirmDeleteEntry() {
  if (!_detailVisitId) return;
  if (!confirm('Are you sure you want to delete this entry?')) return;

  try {
    await db.collection(`users/${currentUser.uid}/visits`).doc(_detailVisitId).delete();
    closeEntryDetail();
    toast('Entry deleted.', 'success');
    navigate('home');
  } catch (e) {
    console.error('deleteEntry:', e);
    toast('Delete failed — try again.', 'error');
  }
}

// ── Journey Screen ────────────────────────────────────────────

let _journeyVisits       = [];
let _journeySearch       = '';
let _journeyFilters      = { city: '', country: '', style: '', year: '' };
let _journeyFilterOpts   = { cities: [], countries: [], styles: [], years: [] };
let _journeyActiveFilter = null;
let _filterOptionsList   = [];

async function loadJourney() {
  if (!currentUser) return;
  const feed = document.getElementById('journey-feed');
  if (feed) feed.innerHTML = skeletonCards(3);

  try {
    const [visSnap, plSnap] = await Promise.all([
      db.collection(`users/${currentUser.uid}/visits`).orderBy('date', 'desc').get(),
      db.collection(`users/${currentUser.uid}/places`).get(),
    ]);
    _journeyVisits = visSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Populate logo cache
    plSnap.docs.forEach(d => { const p = d.data(); if (p.logoUrl) _placeLogos[p.placeId || d.id] = p.logoUrl; });
    buildJourneyFilterOpts();
    renderJourney();
  } catch (e) {
    console.error('loadJourney:', e);
    if (feed) feed.innerHTML = `<div class="empty-state"><div class="empty-body">Couldn't load entries.</div></div>`;
  }
}

function buildJourneyFilterOpts() {
  _journeyFilterOpts.cities    = [...new Set(_journeyVisits.map(v => (v.city    || '').trim()).filter(Boolean))].sort();
  _journeyFilterOpts.countries = [...new Set(_journeyVisits.map(v => (v.country || '').trim()).filter(Boolean))].sort();
  _journeyFilterOpts.styles    = [...new Set(_journeyVisits.flatMap(v => v.styles || []))].sort();
  _journeyFilterOpts.years     = [...new Set(_journeyVisits.map(v => {
    const d = v.date?.toDate ? v.date.toDate() : new Date(v.date);
    return isNaN(d) ? null : String(d.getFullYear());
  }).filter(Boolean))].sort((a, b) => b - a);
  renderJourneyFilterPills();
}

function renderJourney() {
  const feed  = document.getElementById('journey-feed');
  const count = document.getElementById('journey-count');
  if (!feed) return;

  let visits = _journeyVisits;

  // Search
  if (_journeySearch) {
    const q = _journeySearch.toLowerCase();
    visits = visits.filter(v =>
      (v.placeName || '').toLowerCase().includes(q) ||
      (v.notes     || '').toLowerCase().includes(q) ||
      (v.city      || '').toLowerCase().includes(q)
    );
  }

  // Filters — trim both sides so whitespace differences don't break matching
  if (_journeyFilters.city)    visits = visits.filter(v => (v.city    || '').trim() === _journeyFilters.city);
  if (_journeyFilters.country) visits = visits.filter(v => (v.country || '').trim() === _journeyFilters.country);
  if (_journeyFilters.style)   visits = visits.filter(v => (v.styles || []).includes(_journeyFilters.style));
  if (_journeyFilters.year) {
    const yr = parseInt(_journeyFilters.year);
    visits = visits.filter(v => {
      const d = v.date?.toDate ? v.date.toDate() : new Date(v.date);
      return !isNaN(d) && d.getFullYear() === yr;
    });
  }

  if (count) count.textContent = `${visits.length} ${visits.length === 1 ? 'pizza' : 'pizzas'}`;

  if (!visits.length) {
    feed.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No results</div>
        <div class="empty-body">Try adjusting your search or filters.</div>
      </div>`;
    return;
  }

  feed.innerHTML = visits.map(v => entryCard(v.id, v, 'open-entry')).join('');
  initSwipeCards();
}

function renderJourneyFilterPills() {
  const row = document.getElementById('journey-filters');
  if (!row) return;
  const pills = [];

  const pill = (key, label) => {
    const active = _journeyFilters[key];
    pills.push(`<button class="filter-pill ${active ? 'active' : ''}"
      onclick="openJourneyFilter('${key}')">${active ? esc(active) : label}</button>`);
  };

  if (_journeyFilterOpts.cities.length    > 1) pill('city',    'City');
  if (_journeyFilterOpts.countries.length > 1) pill('country', 'Country');
  if (_journeyFilterOpts.styles.length    > 0) pill('style',   'Style');
  if (_journeyFilterOpts.years.length     > 1) pill('year',    'Year');

  row.innerHTML = pills.join('');
}

function openJourneyFilter(key) {
  _journeyActiveFilter = key;
  const titles = { city: 'City', country: 'Country', style: 'Style', year: 'Year' };
  _filterOptionsList = ({
    city:    _journeyFilterOpts.cities,
    country: _journeyFilterOpts.countries,
    style:   _journeyFilterOpts.styles,
    year:    _journeyFilterOpts.years,
  })[key] || [];

  const current = _journeyFilters[key];
  document.getElementById('filter-sheet-title').textContent = titles[key] || key;
  const clearBtn = document.querySelector('#filter-sheet-overlay .filter-sheet-clear');
  if (clearBtn) clearBtn.setAttribute('onclick', 'clearJourneyFilter()');

  document.getElementById('filter-options-list').innerHTML = _filterOptionsList.map((o, i) => `
    <div class="filter-option ${o === current ? 'selected' : ''}" onclick="selectJourneyFilter(${i})">
      <span>${esc(o)}</span>
      <div class="filter-option-check">
        ${o === current
          ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#141414" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          : ''}
      </div>
    </div>`).join('');

  document.getElementById('filter-sheet-overlay').classList.remove('hidden');
}

function selectJourneyFilter(i) {
  const value = _filterOptionsList[i];
  if (value === undefined) return;
  // Toggle: tap same value to clear
  _journeyFilters[_journeyActiveFilter] = (_journeyFilters[_journeyActiveFilter] === value) ? '' : value;
  closeFilterSheet();
  renderJourneyFilterPills();
  renderJourney();
}

function clearJourneyFilter() {
  if (_journeyActiveFilter) {
    _journeyFilters[_journeyActiveFilter] = '';
    renderJourneyFilterPills();
    renderJourney();
  }
  closeFilterSheet();
}

function closeFilterSheet() {
  document.getElementById('filter-sheet-overlay').classList.add('hidden');
  _journeyActiveFilter = null;
}

document.getElementById('journey-search')?.addEventListener('input', function() {
  _journeySearch = this.value.trim();
  renderJourney();
});

// ── Places Screen ─────────────────────────────────────────────

let _placesAll  = [];
let _placesSort = 'recent';
let _placesTab  = 'visited';

// Wishlist filter state
let _wishlistFilters    = { city: '', country: '' };
let _wishlistFilterOpts = { cities: [], countries: [] };

async function loadPlaces() {
  if (!currentUser) return;
  const feed = document.getElementById('places-feed');
  if (feed) feed.innerHTML = skeletonCards(3);

  try {
    const snap = await db.collection(`users/${currentUser.uid}/places`).get();
    _placesAll = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Populate logo cache for use in entry cards throughout the app
    _placeLogos = {};
    _placesAll.forEach(p => { if (p.logoUrl) _placeLogos[p.placeId || p.id] = p.logoUrl; });
    if (_placesTab === 'destinations') { loadDestinations(); } else { renderPlaces(); }
  } catch (e) {
    console.error('loadPlaces:', e);
    if (feed) feed.innerHTML = `<div class="empty-state"><div class="empty-body">Couldn't load places.</div></div>`;
  }
}

// Small pizza SVG for use as default place logo
function pizzaLogoSvg(size = 20) {
  const scale = size / 20;
  return `<svg viewBox="0 0 20 20" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <path d="M 8 10 L 12.6 6.8 A 5.6 5.6 0 1 0 12.6 13.2 Z" fill="#F0EAD6"/>
    <path d="M 12.6 6.8 A 5.6 5.6 0 1 0 12.6 13.2" stroke="#C8A97E" stroke-width="0.9" fill="none" stroke-linecap="round"/>
    <circle cx="5.2" cy="8.4"  r="0.7" fill="#D85A30"/>
    <circle cx="4.4" cy="11"   r="0.6" fill="#D85A30"/>
    <circle cx="8"   cy="7"    r="0.6" fill="#D85A30"/>
    <circle cx="7.4" cy="12.6" r="0.5" fill="#D85A30"/>
  </svg>`;
}

// App-native placeholder for pizza entries without an uploaded photo.
function pizzaPlaceholderSvg(size = 30) {
  return `<svg class="pizza-placeholder-svg" viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M15 14c13.8 1.1 26.4 6.4 37 15.6L26.8 54.8C19.2 43.8 15.3 30.2 15 14Z" fill="none" stroke="#B99A72" stroke-width="2.8" stroke-linejoin="round"/>
    <path d="M15.4 14.2c13.3 1.2 25.5 6.3 35.7 15.1" fill="none" stroke="#E7D3AA" stroke-width="3.2" stroke-linecap="round"/>
    <path d="M22.4 25.2c6.9 1.9 13.2 5 18.7 9.1" fill="none" stroke="#8E7A61" stroke-width="1.8" stroke-linecap="round" opacity=".7"/>
    <circle cx="29.2" cy="33.4" r="2.2" fill="#D85A30" opacity=".86"/>
    <circle cx="36.7" cy="40.2" r="2.0" fill="#D85A30" opacity=".78"/>
    <circle cx="26.1" cy="44.1" r="1.85" fill="#D85A30" opacity=".74"/>
  </svg>`;
}


// App-native placeholder for restaurants/places without an uploaded logo.
function placePlaceholderSvg(size = 24) {
  return `<svg class="place-placeholder-svg" viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M19 30.5V52h26V30.5" fill="none" stroke="#B99A72" stroke-width="3" stroke-linejoin="round"/>
    <path d="M16 30.5h32l-4.8-12.5H20.8L16 30.5Z" fill="none" stroke="#E7D3AA" stroke-width="3" stroke-linejoin="round"/>
    <path d="M22 30.5c0 3.1 2.5 5.6 5.6 5.6s5.6-2.5 5.6-5.6" fill="none" stroke="#8E7A61" stroke-width="2.2" stroke-linecap="round" opacity=".75"/>
    <path d="M33.2 30.5c0 3.1 2.5 5.6 5.6 5.6s5.6-2.5 5.6-5.6" fill="none" stroke="#8E7A61" stroke-width="2.2" stroke-linecap="round" opacity=".75"/>
    <path d="M29 52V41h6v11" fill="none" stroke="#B99A72" stroke-width="2.4" stroke-linejoin="round"/>
    <circle cx="42.5" cy="22.5" r="2.3" fill="#D85A30" opacity=".84"/>
  </svg>`;
}

// App-native placeholder for city/country destinations without a cover image.
function destinationPlaceholderSvg(size = 30) {
  return `<svg class="destination-placeholder-svg" viewBox="0 0 64 64" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M32 55s16-13.3 16-29a16 16 0 1 0-32 0c0 15.7 16 29 16 29Z" fill="none" stroke="#E7D3AA" stroke-width="3" stroke-linejoin="round"/>
    <circle cx="32" cy="26" r="6.2" fill="none" stroke="#B99A72" stroke-width="2.8"/>
    <path d="M20 54h24" stroke="#8E7A61" stroke-width="2.4" stroke-linecap="round" opacity=".65"/>
    <circle cx="42.5" cy="18.5" r="2.2" fill="#D85A30" opacity=".82"/>
  </svg>`;
}

function formatDisplayDate(value, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  const d = value?.toDate ? value.toDate() : (value ? new Date(value) : null);
  return d && !isNaN(d) ? d.toLocaleDateString('en-US', opts) : '';
}

function formatRating(value) {
  if (value == null || value === '' || isNaN(Number(value))) return '—';
  return Number(value).toFixed(1);
}

function avgRating(ratingHistory) {
  if (!ratingHistory?.length) return 0;
  return ratingHistory.reduce((s, r) => s + (r.rating || 0), 0) / ratingHistory.length;
}

function renderPlaces() {
  const feed    = document.getElementById('places-feed');
  const sortBar = document.getElementById('places-sort-bar');
  if (!feed) return;

  if (sortBar) sortBar.style.display = _placesTab === 'visited' ? 'flex' : 'none';

  let places = _placesAll.filter(p => _placesTab === 'wishlist' ? p.isWishlist : !p.isWishlist);

  if (_placesTab === 'wishlist') {
    // Build filter opts from wishlist places
    _wishlistFilterOpts.cities    = [...new Set(places.map(p => p.city).filter(Boolean))].sort();
    _wishlistFilterOpts.countries = [...new Set(places.map(p => p.country).filter(Boolean))].sort();
    // Apply filters
    if (_wishlistFilters.city)    places = places.filter(p => p.city === _wishlistFilters.city);
    if (_wishlistFilters.country) places = places.filter(p => p.country === _wishlistFilters.country);
  }

  if (_placesTab === 'visited') {
    places = [...places].sort((a, b) => {
      if (_placesSort === 'most-visited')  return (b.visitCount || 0) - (a.visitCount || 0);
      if (_placesSort === 'highest-rated') return avgRating(b.ratingHistory) - avgRating(a.ratingHistory);
      if (_placesSort === 'alpha')         return (a.name || '').localeCompare(b.name || '');
      // recent (default)
      const da  = a.lastVisited?.toDate ? a.lastVisited.toDate() : new Date(a.lastVisited || 0);
      const db2 = b.lastVisited?.toDate ? b.lastVisited.toDate() : new Date(b.lastVisited || 0);
      return db2 - da;
    });
  }

  let html = '';

  if (_placesTab === 'wishlist') {
    html += wishlistAddBtn();
    // Render filter pills if we have options
    if (_wishlistFilterOpts.cities.length > 1 || _wishlistFilterOpts.countries.length > 0) {
      html += renderWishlistFilterPills();
    }
  }

  if (!places.length) {
    const msg = _placesTab === 'wishlist'
      ? 'Search for spots you want to try.'
      : 'Log a pizza to see places here.';
    html += `
      <div class="empty-state">
        <div class="empty-icon">${_placesTab === 'wishlist' ? '⭐' : '📍'}</div>
        <div class="empty-title">${_placesTab === 'wishlist' ? 'Bucket list is empty' : 'No places yet'}</div>
        <div class="empty-body">${msg}</div>
      </div>`;
    feed.innerHTML = html;
    return;
  }

  html += places.map(p => placeCard(p)).join('');
  feed.innerHTML = html;
  initWishlistSwipeCards();
}

function wishlistAddBtn() {
  return `<button class="btn-add-wishlist" onclick="openWishlistAdd()">
    <span class="btn-add-wishlist-icon">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </span>
    <span>Add a place</span>
  </button>`;
}


function renderWishlistFilterPills() {
  const pills = [];
  if (_wishlistFilterOpts.cities.length > 1) {
    const active = _wishlistFilters.city;
    pills.push(`<button class="filter-pill ${active ? 'active' : ''}" onclick="openWishlistFilter('city')">${active ? esc(active) : 'City'}</button>`);
  }
  if (_wishlistFilterOpts.countries.length > 1) {
    const active = _wishlistFilters.country;
    pills.push(`<button class="filter-pill ${active ? 'active' : ''}" onclick="openWishlistFilter('country')">${active ? esc(active) : 'Country'}</button>`);
  }
  if (!pills.length) return '';
  return `<div class="journey-filters" style="padding-bottom:8px;">${pills.join('')}</div>`;
}

let _wishlistActiveFilter   = null;
let _wishlistFilterOptsList = [];

function openWishlistFilter(key) {
  _wishlistActiveFilter   = key;
  _wishlistFilterOptsList = key === 'city' ? _wishlistFilterOpts.cities : _wishlistFilterOpts.countries;
  const current = _wishlistFilters[key];
  document.getElementById('filter-sheet-title').textContent = key === 'city' ? 'City' : 'Country';
  document.getElementById('filter-options-list').innerHTML = _wishlistFilterOptsList.map((o, i) => `
    <div class="filter-option ${o === current ? 'selected' : ''}" onclick="selectWishlistFilter(${i})">
      <span>${esc(o)}</span>
      <div class="filter-option-check">
        ${o === current ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#141414" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
      </div>
    </div>`).join('');
  // Reuse journey filter sheet but wire clear/select to wishlist handlers
  const clearBtn = document.querySelector('#filter-sheet-overlay .filter-sheet-clear');
  if (clearBtn) clearBtn.setAttribute('onclick', 'clearWishlistFilter()');
  document.getElementById('filter-sheet-overlay').classList.remove('hidden');
}

function selectWishlistFilter(i) {
  const value = _wishlistFilterOptsList[i];
  if (value === undefined) return;
  _wishlistFilters[_wishlistActiveFilter] = (_wishlistFilters[_wishlistActiveFilter] === value) ? '' : value;
  closeFilterSheet();
  renderPlaces();
}

function clearWishlistFilter() {
  if (_wishlistActiveFilter) {
    _wishlistFilters[_wishlistActiveFilter] = '';
    renderPlaces();
  }
  closeFilterSheet();
}

function placeCard(p) {
  const pid     = p.placeId || p.id;
  const avg     = avgRating(p.ratingHistory);
  const loc     = [p.city, p.country].filter(Boolean).join(', ');
  const lastD   = p.lastVisited?.toDate ? p.lastVisited.toDate()
                : (p.lastVisited ? new Date(p.lastVisited) : null);
  const lastStr = lastD && !isNaN(lastD)
    ? lastD.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  const logoHtml = p.logoUrl
    ? `<span class="place-card-logo"><img src="${esc(p.logoUrl)}" loading="lazy" /></span>`
    : `<span class="place-card-logo place-card-logo--default">${placePlaceholderSvg(23)}</span>`;

  if (p.isWishlist) {
    return `
      <div class="bucket-swipe-wrapper" data-place-id="${esc(pid)}">
        <div class="swipe-reveal swipe-reveal-delete bucket-delete-reveal">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          Delete
        </div>
        <div class="place-card wishlist" onclick="openPlace('${esc(pid)}')">
          <div class="place-card-top">
            <div class="place-card-name-row">
              ${logoHtml}
              <div class="place-card-text">
                <div class="place-card-name">${esc(p.name || 'Unknown')}</div>
                ${loc ? `<div class="place-card-sub">${esc(loc)}</div>` : ''}
              </div>
            </div>
            <span class="wishlist-badge">Want</span>
          </div>
        </div>
      </div>`;
  }

  return `
    <div class="place-card" onclick="openPlace('${esc(pid)}')">
      <div class="place-card-top">
        <div class="place-card-name-row">
          ${logoHtml}
          <div class="place-card-text">
            <div class="place-card-name">${esc(p.name || 'Unknown')}</div>
            ${loc ? `<div class="place-card-sub">${esc(loc)}</div>` : ''}
            <div class="place-card-meta">
              <span class="place-visit-badge">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
                </svg>
                ${p.visitCount || 1} ${(p.visitCount || 1) === 1 ? 'visit' : 'visits'}
              </span>
              ${lastStr ? `<span class="place-last-visit">Last: ${lastStr}</span>` : ''}
            </div>
          </div>
        </div>
        ${avg ? `<div class="place-card-rating">${formatRating(avg)}</div>` : ''}
      </div>
    </div>`;
}


function switchPlacesTab(tab) {
  _placesTab = tab;
  // Reset wishlist filters on tab switch
  if (tab !== 'wishlist') _wishlistFilters = { city: '', country: '' };
  document.querySelectorAll('.places-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab));
  if (tab === 'destinations') loadDestinations();
  else renderPlaces();
}

function setPlacesSort(sort) {
  _placesSort = sort;
  document.querySelectorAll('.sort-pill').forEach(p =>
    p.classList.toggle('active', p.dataset.sort === sort));
  renderPlaces();
}

// ── Place Detail ──────────────────────────────────────────────

async function openPlace(placeId) {
  if (!currentUser) return;
  const overlay = document.getElementById('place-detail-overlay');
  const body    = document.getElementById('place-detail-body');
  if (!overlay || !body) return;
  // Ensure place detail renders above destination detail and, when opened from Feed, above Feed viewer.
  const feedOverlay = document.getElementById('feed-photo-overlay');
  overlay.style.zIndex = (feedOverlay && !feedOverlay.classList.contains('hidden')) ? '940' : '620';
  overlay.classList.remove('hidden');
  body.innerHTML = '<div style="text-align:center;padding:48px;opacity:.35;font-size:14px;">Loading…</div>';

  try {
    const placeSnap = await db.collection(`users/${currentUser.uid}/places`).doc(placeId).get();
    if (!placeSnap.exists) { overlay.classList.add('hidden'); return; }
    const place = placeSnap.data();

    // Fetch visits and sort client-side to avoid requiring a Firestore composite index
    const visitsSnap = await db.collection(`users/${currentUser.uid}/visits`)
      .where('placeId', '==', placeId)
      .get();
    const visits = visitsSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const da  = a.date?.toDate ? a.date.toDate() : new Date(a.date);
        const db2 = b.date?.toDate ? b.date.toDate() : new Date(b.date);
        return db2 - da;
      });

    const loc = [place.city, place.country].filter(Boolean).join(', ');
    const avg = avgRating(place.ratingHistory);
    const vc  = place.visitCount || visits.length || 0;

    // Rating drift — only show if 2+ rated visits
    let driftHtml = '';
    if ((place.ratingHistory || []).length > 1) {
      const sorted = [...place.ratingHistory].sort((a, b) => new Date(b.date) - new Date(a.date));
      driftHtml = `
        <div class="place-section-label">Rating History</div>
        <div class="rating-drift">
          ${sorted.map(r => `
            <div class="rating-drift-item">
              <span class="rating-drift-date">${esc(formatDisplayDate(r.date, { month: 'long', day: 'numeric', year: 'numeric' }) || r.date || '')}</span>
              <span class="rating-drift-val">${formatRating(r.rating)}</span>
            </div>`).join('')}
        </div>`;
    }

    const logoMarkup = place.logoUrl
      ? `<img src="${esc(place.logoUrl)}" class="place-logo-img" />`
      : `<div class="place-logo-default">${placePlaceholderSvg(38)}</div>`;

    body.innerHTML = `
      <div class="place-detail-header ${place.isWishlist ? 'place-detail-header--wishlist' : ''}">
        <div class="place-logo-outer" onclick="changePlaceLogo('${esc(placeId)}')">
          <div class="place-logo-inner">
            ${logoMarkup}
          </div>
          <div class="place-logo-edit-hint">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </div>
        </div>
        <div class="place-detail-title-group">
          <div class="place-detail-name">${esc(place.name || 'Unknown')}</div>
          ${loc ? `<div class="place-detail-location">${esc(loc)}</div>` : ''}
        </div>
      </div>
      ${place.isWishlist ? `
      <div class="wishlist-cta-block">
        <button class="btn-save btn-log-here" onclick="logFromWishlist('${esc(placeId)}')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" style="vertical-align:middle;margin-right:6px;">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Log a Pizza Here
        </button>
      </div>` : ''}
      <div class="place-stats-row ${place.isWishlist ? 'place-stats-row--single' : ''}">
        <div class="place-stat-chip">
          <div class="place-stat-chip-num">${vc}</div>
          <div class="place-stat-chip-label">${vc === 1 ? 'Visit' : 'Visits'}</div>
        </div>
        ${(!place.isWishlist && avg) ? `<div class="place-stat-chip">
          <div class="place-stat-chip-num">${formatRating(avg)}</div>
          <div class="place-stat-chip-label">Avg Rating</div>
        </div>` : ''}
      </div>
      ${place.isWishlist && !visits.length ? `
        <div class="wishlist-empty-note">
          <div class="wishlist-empty-title">No pizzas logged here yet.</div>
          <div class="wishlist-empty-body">Log your first visit to move this spot into Visited.</div>
        </div>
        <button class="btn-remove-wishlist" onclick="deleteWishlistPlace('${esc(placeId)}', true)">Remove from Bucket List</button>
      ` : ''}
      ${driftHtml}
      ${visits.length ? `
        <div class="place-section-label" style="margin-top:${driftHtml ? '8px' : '0'};">Visit History</div>
        <div class="place-visit-history">
          ${visits.map(v => entryCard(v.id, v, 'open-entry')).join('')}
        </div>` : ''}
    `;
    initSwipeCards();
  } catch (e) {
    console.error('openPlace:', e);
    body.innerHTML = '<div style="text-align:center;padding:48px;opacity:.35;font-size:14px;">Couldn\'t load place.</div>';
  }
}


function closePlaceDetail() {
  const overlay = document.getElementById('place-detail-overlay');
  overlay.classList.add('hidden');
  overlay.style.zIndex = ''; // reset so it doesn't stay elevated
}

// ── Log Pizza from Bucket List ────────────────────────────────
// Opens the log form with the wishlist place pre-loaded.
// saveEntry() already sets isWishlist:false on commit, so the
// bucket-list entry converts automatically once the visit is saved.
function logFromWishlist(placeId) {
  const p = _placesAll.find(pl => (pl.placeId || pl.id) === placeId);
  if (!p) return;

  closePlaceDetail();
  openLog();

  requestAnimationFrame(() => {
    document.getElementById('place-input').value = p.name || '';
    selectedPlace = {
      placeId: p.placeId || placeId,
      name:    p.name    || '',
      address: p.address || '',
      city:    p.city    || '',
      country: p.country || '',
      lat:     p.lat     ?? null,
      lng:     p.lng     ?? null,
    };
    qv('override-city',    p.city    || '');
    qv('override-country', p.country || '');
    const locRow = document.getElementById('place-location-row');
    if (locRow) locRow.classList.add('visible');
  });
}

async function changePlaceLogo(placeId) {
  if (!currentUser) return;
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = async function() {
    const file = this.files[0];
    if (!file) return;
    try {
      const compressed = await compressPhoto(file, 80); // smaller target for logos
      const ref = storage.ref(`users/${currentUser.uid}/placeLogos/${placeId}.jpg`);
      await ref.put(compressed, { contentType: 'image/jpeg' });
      const url = await ref.getDownloadURL();
      await db.collection(`users/${currentUser.uid}/places`).doc(placeId).set(
        { logoUrl: url },
        { merge: true }
      );
      // Update cache
      _placeLogos[placeId] = url;
      // Update the logo in the open detail sheet
      const wrap = document.querySelector('.place-logo-outer');
      if (wrap) {
        const existing = wrap.querySelector('.place-logo-img, .place-logo-default');
        if (existing) existing.outerHTML = `<img src="${esc(url)}" class="place-logo-img" />`;
      }
      // Update the place doc in _placesAll cache
      const cached = _placesAll.find(p => (p.placeId || p.id) === placeId);
      if (cached) cached.logoUrl = url;
      toast('Logo updated ✓', 'success');
    } catch(e) {
      console.error('changePlaceLogo:', e);
      toast('Logo upload failed — try again.', 'error');
    }
  };
  input.click();
}

// ── Wishlist ──────────────────────────────────────────────────

let _wishlistPlace       = null;
let _wishlistSuggestions = [];

function openWishlistAdd() {
  _wishlistPlace       = null;
  _wishlistSuggestions = [];
  const inp  = document.getElementById('wishlist-place-input');
  const list = document.getElementById('wishlist-autocomplete-list');
  const btn  = document.getElementById('wishlist-save-btn');
  if (inp)  inp.value = '';
  if (list) list.innerHTML = '';
  if (btn)  { btn.disabled = false; btn.textContent = 'Add to Bucket List'; }
  document.getElementById('wishlist-add-overlay').classList.remove('hidden');
}

function closeWishlistAdd() {
  document.getElementById('wishlist-add-overlay').classList.add('hidden');
}

document.getElementById('wishlist-place-input')?.addEventListener('input', async function() {
  const q    = this.value.trim();
  const list = document.getElementById('wishlist-autocomplete-list');
  if (!list) return;
  if (q.length < 2) { list.innerHTML = ''; return; }
  if (typeof PLACES_API_KEY === 'undefined' || PLACES_API_KEY === 'YOUR_PLACES_API_KEY') return;

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': PLACES_API_KEY },
      body: JSON.stringify({ input: q, sessionToken: crypto.randomUUID() }),
    });
    const data = await res.json();
    _wishlistSuggestions = (data.suggestions || []).slice(0, 5);
    list.innerHTML = _wishlistSuggestions.map((s, i) => {
      const p    = s.placePrediction;
      const main = p.structuredFormat?.mainText?.text || p.text?.text || '';
      const sub  = p.structuredFormat?.secondaryText?.text || '';
      return `<div class="autocomplete-item" onclick="selectWishlistPlace(${i})">
        <div class="place-name">${esc(main)}</div>
        <div class="place-sub">${esc(sub)}</div>
      </div>`;
    }).join('');
  } catch (e) { console.warn('[Crust] Wishlist autocomplete:', e); }
});

async function selectWishlistPlace(i) {
  const s = _wishlistSuggestions[i];
  if (!s) return;
  const p    = s.placePrediction;
  const main = p.structuredFormat?.mainText?.text || p.text?.text || '';
  const sub  = p.structuredFormat?.secondaryText?.text || '';

  document.getElementById('wishlist-place-input').value = main;
  document.getElementById('wishlist-autocomplete-list').innerHTML = '';
  _wishlistPlace = { placeId: p.placeId, name: main, address: sub, city: '', country: '', lat: null, lng: null };

  if (typeof PLACES_API_KEY !== 'undefined' && PLACES_API_KEY !== 'YOUR_PLACES_API_KEY') {
    try {
      const res = await fetch(
        `https://places.googleapis.com/v1/places/${p.placeId}?fields=displayName,formattedAddress,location,addressComponents`,
        { headers: { 'X-Goog-Api-Key': PLACES_API_KEY } }
      );
      const place = await res.json();
      const comps = place.addressComponents || [];
      const find  = type => (comps.find(c => c.types?.includes(type)) || {}).longText || '';
      _wishlistPlace = {
        placeId: p.placeId,
        name:    place.displayName?.text || main,
        address: place.formattedAddress  || sub,
        city:    find('locality') || find('administrative_area_level_2'),
        country: find('country'),
        lat:     place.location?.latitude  ?? null,
        lng:     place.location?.longitude ?? null,
      };
    } catch (e) { console.warn('[Crust] Wishlist place details:', e); }
  }
}

async function saveWishlistPlace() {
  if (!currentUser) return;
  if (!_wishlistPlace) { toast('Search for a place first', 'error'); return; }

  const btn = document.getElementById('wishlist-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    await db.collection(`users/${currentUser.uid}/places`).doc(_wishlistPlace.placeId).set({
      placeId:    _wishlistPlace.placeId,
      name:       _wishlistPlace.name,
      address:    _wishlistPlace.address,
      city:       _wishlistPlace.city,
      country:    _wishlistPlace.country,
      lat:        _wishlistPlace.lat,
      lng:        _wishlistPlace.lng,
      isWishlist: true,
      visitCount: 0,
      createdAt:  firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Update local cache
    const existing = _placesAll.findIndex(p => (p.placeId || p.id) === _wishlistPlace.placeId);
    const newEntry  = { ..._wishlistPlace, isWishlist: true, visitCount: 0 };
    if (existing >= 0) _placesAll[existing] = newEntry;
    else               _placesAll.push(newEntry);

    toast('Added to bucket list! ⭐', 'success');
    closeWishlistAdd();
    renderPlaces();
  } catch (e) {
    console.error('saveWishlistPlace:', e);
    toast('Save failed — try again.', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Add to Bucket List'; }
  }
}


// ── Bucket List delete handling ──────────────────────────────
function initWishlistSwipeCards() {
  document.querySelectorAll('.bucket-swipe-wrapper:not([data-swipe-init])').forEach(wrapper => {
    wrapper.setAttribute('data-swipe-init', '1');
    const card = wrapper.querySelector('.place-card');
    if (!card) return;

    const deleteReveal = wrapper.querySelector('.bucket-delete-reveal');
    if (deleteReveal) {
      deleteReveal.addEventListener('click', e => {
        e.stopPropagation();
        const placeId = wrapper.dataset.placeId;
        card.style.transition = 'transform 0.22s ease';
        card.style.transform = '';
        deleteWishlistPlace(placeId);
      });
    }

    let startX = 0, startY = 0, dx = 0;
    let dragging = false, isScrolling = false;

    const REVEAL = 88;
    const MENU_TRIGGER = 34;
    const FULL_RATIO = 0.72;

    wrapper.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dx = 0; dragging = true; isScrolling = false;
      card.style.transition = 'none';
      wrapper.classList.remove('swipe-full-delete');
    }, { passive: true });

    wrapper.addEventListener('touchmove', e => {
      if (!dragging) return;
      const moveX = e.touches[0].clientX - startX;
      const moveY = e.touches[0].clientY - startY;

      if (!isScrolling && Math.abs(moveY) > Math.abs(moveX) + 6) {
        isScrolling = true;
        card.style.transition = 'transform 0.22s ease';
        card.style.transform = '';
        wrapper.classList.remove('swipe-full-delete');
        return;
      }

      if (isScrolling) return;
      e.preventDefault();

      dx = moveX;
      const width = Math.max(wrapper.offsetWidth || 320, 240);
      const clamped = Math.max(-width, Math.min(0, dx));
      const fullThreshold = width * FULL_RATIO;

      wrapper.classList.toggle('swipe-full-delete', clamped < -fullThreshold);
      card.style.transform = `translateX(${clamped}px)`;
    }, { passive: false });

    wrapper.addEventListener('touchend', () => {
      if (!dragging || isScrolling) { dragging = false; return; }
      dragging = false;
      card.style.transition = 'transform 0.24s ease';
      wrapper.classList.remove('swipe-full-delete');

      const placeId = wrapper.dataset.placeId;
      const width = Math.max(wrapper.offsetWidth || 320, 240);
      const fullThreshold = width * FULL_RATIO;

      if (dx <= -fullThreshold) {
        card.style.transform = `translateX(-${width}px)`;
        window.setTimeout(() => {
          card.style.transform = '';
          deleteWishlistPlace(placeId);
        }, 180);
      } else if (dx <= -MENU_TRIGGER) {
        card.style.transform = `translateX(-${REVEAL}px)`;
      } else {
        card.style.transform = '';
      }
    });
  });
}

async function deleteWishlistPlace(placeId, fromDetail = false) {
  if (!currentUser || !placeId) return;
  if (!confirm('Remove this place from your bucket list?')) return;
  try {
    await db.collection(`users/${currentUser.uid}/places`).doc(placeId).delete();
    _placesAll = _placesAll.filter(p => (p.placeId || p.id) !== placeId);
    if (fromDetail) closePlaceDetail();
    toast('Removed from bucket list.', 'success');
    if (currentScreen === 'places') renderPlaces();
  } catch (e) {
    console.error('deleteWishlistPlace:', e);
    toast('Remove failed — try again.', 'error');
  }
}

// ── Skeleton helper ───────────────────────────────────────────
function skeletonCards(n = 2) {
  return Array(n).fill(`
    <div class="entry-card" style="pointer-events:none">
      <div class="entry-thumb-placeholder" style="border-radius:8px;">
        <div class="skel" style="width:100%;height:100%;border-radius:8px;"></div>
      </div>
      <div class="entry-body">
        <div class="skel" style="height:15px;width:65%;margin-bottom:6px;border-radius:6px;"></div>
        <div class="skel" style="height:11px;width:42%;margin-bottom:8px;border-radius:6px;"></div>
        <div class="skel" style="height:16px;width:52px;border-radius:20px;"></div>
      </div>
    </div>`).join('');
}

// ── LOG SCREEN ───────────────────────────────────────────────

// Open log screen
function openLog() {
  resetLog();
  navigate('log');
  // Attach autocomplete listener fresh each time the form opens
  const placeInput = document.getElementById('place-input');
  if (placeInput) {
    placeInput.oninput = function() {
      const q = this.value.trim();
      // Clear previous place selection and hide city/country row the moment
      // the user edits the field — prevents the row from overlapping the dropdown
      selectedPlace = null;
      const locRow = document.getElementById('place-location-row');
      if (locRow) locRow.classList.remove('visible');
      qv('override-city', '');
      qv('override-country', '');

      if (q.length >= 2) runAutocomplete(q);
      else document.getElementById('autocomplete-list').innerHTML = '';
    };
  }
}

function resetLog() {
  selectedStyles   = [];
  selectedRating   = 8.0;
  selectedPlace    = null;
  selectedPhoto    = null;
  existingPhotoUrl = null;
  editingVisitId   = null;
  autocompleteSession = null;

  const today = new Date().toISOString().split('T')[0];
  qv('log-date', today);
  qv('place-input', '');
  qv('log-notes', '');
  qv('rating-slider', '8');
  document.getElementById('rating-display').textContent = '8.0';
  document.getElementById('autocomplete-list').innerHTML = '';
  document.getElementById('place-hidden').value = '';

  renderLogStyleSummary();
  renderStyleSheetOptions();

  // Reset photo
  const pa = document.getElementById('photo-area-inner');
  if (pa) pa.innerHTML = photoAreaDefault();

  // Reset save button (critical — fixes stuck "Saving…" bug on second entry)
  const saveBtn = document.getElementById('save-btn');
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Pizza'; }

  // Reset log title
  const logTitle = document.getElementById('log-title');
  if (logTitle) logTitle.textContent = 'Log a Pizza';

  // Hide city/country override row
  const locRow = document.getElementById('place-location-row');
  if (locRow) locRow.classList.remove('visible');
  qv('override-city', '');
  qv('override-country', '');
}

function qv(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

// Rating slider
document.getElementById('rating-slider').addEventListener('input', function() {
  selectedRating = parseFloat(this.value);
  document.getElementById('rating-display').textContent = selectedRating.toFixed(1);
});

// Style picker bottom sheet
const LOG_STYLE_OPTIONS = [
  'Al Taglio', 'Deep Dish', 'Detroit',
  'Neapolitan', 'New York', 'Pan Pizza',
  'Sicilian', 'Tavern Style', 'Other'
];

function renderLogStyleSummary() {
  const el = document.getElementById('style-summary');
  if (!el) return;
  if (!selectedStyles.length) {
    el.textContent = 'Pick styles';
    el.classList.add('muted');
    return;
  }
  el.textContent = selectedStyles.join(', ');
  el.classList.remove('muted');
}

function renderStyleSheetOptions() {
  const list = document.getElementById('style-sheet-options');
  if (!list) return;
  list.innerHTML = LOG_STYLE_OPTIONS.map(style => {
    const active = selectedStyles.includes(style);
    return `
      <button type="button" class="style-sheet-chip ${active ? 'on' : ''}" onclick="toggleLogStyle('${esc(style)}')">
        <span>${esc(style)}</span>
        ${active ? '<span class="style-sheet-check">✓</span>' : ''}
      </button>`;
  }).join('');
}

function openStyleSheet() {
  renderStyleSheetOptions();
  document.getElementById('style-sheet-overlay')?.classList.remove('hidden');
}

function closeStyleSheet() {
  document.getElementById('style-sheet-overlay')?.classList.add('hidden');
}

function clearLogStyles() {
  selectedStyles = [];
  renderLogStyleSummary();
  renderStyleSheetOptions();
}

function toggleLogStyle(style) {
  if (selectedStyles.includes(style)) {
    selectedStyles = selectedStyles.filter(x => x !== style);
  } else {
    selectedStyles.push(style);
  }
  renderLogStyleSummary();
  renderStyleSheetOptions();
}

// ── Google Places Autocomplete (REST API — no JS SDK needed) ──
// Uses Places API (New) directly via fetch. No script tag required.
// Event delegation on document avoids DOM timing issues.

let acDebounce;
let _acSuggestions = []; // cache raw suggestions — onclick references by index to avoid apostrophe-escaping bugs

// autocomplete is attached in openLog() each time the form opens

async function runAutocomplete(query) {
  const list = document.getElementById('autocomplete-list');

  // If no API key configured, hide dropdown silently
  if (typeof PLACES_API_KEY === 'undefined' || PLACES_API_KEY === 'YOUR_PLACES_API_KEY') return;

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': PLACES_API_KEY,
      },
      body: JSON.stringify({
        input: query,
        sessionToken: crypto.randomUUID()
      }),
    });

    if (!res.ok) { list.innerHTML = ''; return; }
    const data = await res.json();
    const suggestions = data.suggestions || [];

    if (!suggestions.length) { list.innerHTML = ''; return; }

    // Store raw suggestions so selectPlaceByIndex() can read them safely —
    // avoids passing name/address as escaped strings in onclick attributes,
    // which breaks on apostrophes (e.g. "Joe's Pizza", "Mama's TOO!")
    _acSuggestions = suggestions.slice(0, 5);

    list.innerHTML = _acSuggestions.map((s, i) => {
      const p    = s.placePrediction;
      const main = p.structuredFormat?.mainText?.text || p.text?.text || '';
      const sub  = p.structuredFormat?.secondaryText?.text || '';
      return `
        <div class="autocomplete-item" onclick="selectPlaceByIndex(${i})">
          <div class="place-name">${esc(main)}</div>
          <div class="place-sub">${esc(sub)}</div>
        </div>`;
    }).join('');

  } catch (e) {
    console.warn('[Crust] Autocomplete error:', e);
    list.innerHTML = '';
  }
}

// Reads from _acSuggestions by index — no string escaping risk
function selectPlaceByIndex(i) {
  const s = _acSuggestions[i];
  if (!s) return;
  const p    = s.placePrediction;
  const main = p.structuredFormat?.mainText?.text || p.text?.text || '';
  const sub  = p.structuredFormat?.secondaryText?.text || '';
  selectPlace(p.placeId, main, sub);
}

// Called when user taps a suggestion
async function selectPlace(placeId, name, sub) {
  document.getElementById('place-input').value = name;
  document.getElementById('autocomplete-list').innerHTML = '';

  // Store minimal record immediately so save works even if details fail
  selectedPlace = { placeId, name, address: sub, city: '', country: '', lat: null, lng: null };

  // Fetch full details: coordinates, city, country
  try {
    const res = await fetch(
      `https://places.googleapis.com/v1/places/${placeId}?fields=displayName,formattedAddress,location,addressComponents`,
      { headers: { 'X-Goog-Api-Key': PLACES_API_KEY } }
    );
    if (!res.ok) return;
    const place = await res.json();

    const comps  = place.addressComponents || [];
    const find   = type => (comps.find(c => c.types?.includes(type)) || {}).longText || '';

    selectedPlace = {
      placeId,
      name:    place.displayName?.text || name,
      address: place.formattedAddress || sub,
      city:    find('locality') || find('administrative_area_level_2'),
      country: find('country'),
      lat:     place.location?.latitude  ?? null,
      lng:     place.location?.longitude ?? null,
    };
  } catch (e) {
    console.warn('[Crust] Place details error:', e);
    // selectedPlace already set above — save will still work
  }

  // Show editable city/country row so user can correct if Google got it wrong
  const locRow = document.getElementById('place-location-row');
  if (locRow) {
    qv('override-city',    selectedPlace.city);
    qv('override-country', selectedPlace.country);
    locRow.classList.add('visible');
  }
}

// ── Photo Handling ────────────────────────────────────────────
document.getElementById('photo-input').addEventListener('change', function() {
  if (!this.files[0]) return;
  selectedPhoto = this.files[0];
  const url = URL.createObjectURL(selectedPhoto);
  const pa  = document.getElementById('photo-area-inner');
  if (pa) pa.innerHTML = photoAreaPreview(url);
});

function photoAreaDefault() {
  return `
    <span class="photo-row-icon">+</span>
    <span class="photo-row-copy">Add photo</span>`;
}

function photoAreaPreview(url) {
  return `
    <img src="${esc(url)}" class="photo-row-preview" alt="Pizza photo preview" />
    <span class="photo-row-copy">Change photo</span>`;
}

// ── Save Entry ────────────────────────────────────────────────
async function saveEntry() {
  if (!currentUser) { toast('Not signed in', 'error'); return; }

  const placeInputVal = document.getElementById('place-input').value.trim();
  if (!placeInputVal) { toast('Add a place first', 'error'); return; }

  const dateInput = document.getElementById('log-date').value;
  if (!dateInput) { toast('Choose a date', 'error'); return; }

  const saveBtn = document.getElementById('save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const uid   = currentUser.uid;
    const date  = firebase.firestore.Timestamp.fromDate(new Date(dateInput + 'T12:00:00'));
    const notes = document.getElementById('log-notes').value.trim();

    // City/country: honour manual overrides from the editable fields
    const overrideCity    = document.getElementById('override-city')?.value.trim()    || '';
    const overrideCountry = document.getElementById('override-country')?.value.trim() || '';

    const place = selectedPlace || {
      placeId:  'manual_' + Date.now(),
      name:     placeInputVal,
      address:  '',
      city:     '',
      country:  '',
      lat:      null,
      lng:      null,
    };

    const finalCity    = overrideCity    || place.city;
    const finalCountry = overrideCountry || place.country;

    // Photo: new upload wins; otherwise keep existing (for edit mode)
    let photoUrl = existingPhotoUrl;
    if (selectedPhoto) {
      try {
        const compressed = await compressPhoto(selectedPhoto);
        const ref = storage.ref(`users/${uid}/photos/${Date.now()}.jpg`);
        // 30-second timeout — prevents infinite "Saving…" if network stalls
        await Promise.race([
          ref.put(compressed, { contentType: 'image/jpeg' }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Photo upload timed out')), 30000)
          )
        ]);
        photoUrl = await ref.getDownloadURL();
      } catch (photoErr) {
        console.warn('[Crust] Photo upload failed:', photoErr);
        toast('Photo upload failed — saving without photo.', 'error');
        photoUrl = existingPhotoUrl;
      }
    }

    const visit = {
      placeId:   place.placeId,
      placeName: place.name,
      address:   place.address,
      city:      finalCity,
      country:   finalCountry,
      lat:       place.lat,
      lng:       place.lng,
      date,
      rating:    selectedRating,
      styles:    selectedStyles,
      notes,
      photoUrl:  photoUrl || null,
    };

    if (editingVisitId) {
      // ── UPDATE existing entry ──────────────────────────────
      visit.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await db.collection(`users/${uid}/visits`).doc(editingVisitId).update(visit);

      // Correct city/country on the place doc too
      if (place.placeId) {
        await db.collection(`users/${uid}/places`).doc(place.placeId)
          .set({ city: finalCity, country: finalCountry }, { merge: true })
          .catch(() => {});
      }

      toast('Entry updated! ✓', 'success');
      closeEntryDetail();
      navigate('home');

    } else {
      // ── CREATE new entry ───────────────────────────────────
      visit.createdAt = firebase.firestore.FieldValue.serverTimestamp();

      const batch    = db.batch();
      const visitRef = db.collection(`users/${uid}/visits`).doc();
      batch.set(visitRef, visit);

      const placeRef = db.collection(`users/${uid}/places`).doc(place.placeId);
      batch.set(placeRef, {
        placeId:     place.placeId,
        name:        place.name,
        address:     place.address,
        city:        finalCity,
        country:     finalCountry,
        lat:         place.lat,
        lng:         place.lng,
        lastVisited: date,
        visitCount:  firebase.firestore.FieldValue.increment(1),
        isWishlist:  false,
      }, { merge: true });

      await batch.commit();

      // Must run AFTER batch so the place doc exists for new places
      await placeRef.update({
        ratingHistory: firebase.firestore.FieldValue.arrayUnion({
          date:   dateInput,
          rating: selectedRating,
        }),
      }).catch(() => {});

      toast('Pizza logged! 🍕', 'success');
      navigate('home');
    }

  } catch (e) {
    console.error('saveEntry:', e);
    toast('Save failed — try again.', 'error');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Pizza';
  }
}

// ── Photo Compression ─────────────────────────────────────────
// Target ~150 KB. Uses a canvas to re-encode as JPEG.
function compressPhoto(file, targetKB = 150) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const max   = 1400; // px on longest side
      let   w     = img.width;
      let   h     = img.height;
      if (w > max || h > max) {
        if (w > h) { h = Math.round(h * max / w); w = max; }
        else       { w = Math.round(w * max / h); h = max; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);

      // Binary-search quality to hit ~targetKB
      let lo = 0.3, hi = 0.92, q = 0.75;
      for (let i = 0; i < 6; i++) {
        const dataUrl = canvas.toDataURL('image/jpeg', q);
        const kb = (dataUrl.length * 3 / 4) / 1024;
        if (Math.abs(kb - targetKB) < 10) break;
        if (kb > targetKB) hi = q; else lo = q;
        q = (lo + hi) / 2;
      }

      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas toBlob failed')), 'image/jpeg', q);
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ── Swipe Gesture Handling ────────────────────────────────────
let _openSwipeWrapper = null;

function resetAllSwipes() {
  if (_openSwipeWrapper) {
    const card = _openSwipeWrapper.querySelector('.entry-card');
    if (card) {
      card.style.transition = 'transform 0.22s ease';
      card.style.transform  = '';
    }
    _openSwipeWrapper = null;
  }
}

function initSwipeCards() {
  document.querySelectorAll('.swipe-wrapper:not([data-swipe-init])').forEach(wrapper => {
    wrapper.setAttribute('data-swipe-init', '1');
    const card = wrapper.querySelector('.entry-card');
    if (!card) return;

    const editReveal = wrapper.querySelector('.swipe-reveal-edit');
    const deleteReveal = wrapper.querySelector('.swipe-reveal-delete');

    if (editReveal) {
      editReveal.addEventListener('click', e => {
        e.stopPropagation();
        const entryId = wrapper.dataset.entryId;
        resetAllSwipes();
        loadAndEditEntry(entryId);
      });
    }

    if (deleteReveal) {
      deleteReveal.addEventListener('click', e => {
        e.stopPropagation();
        const entryId = wrapper.dataset.entryId;
        resetAllSwipes();
        deleteEntryById(entryId);
      });
    }

    let startX = 0, startY = 0, dx = 0;
    let dragging = false, isScrolling = false;

    const REVEAL = 88;
    const MENU_TRIGGER = 34;
    const FULL_RATIO = 0.72;

    wrapper.addEventListener('touchstart', e => {
      if (_openSwipeWrapper && _openSwipeWrapper !== wrapper) resetAllSwipes();
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dx = 0; dragging = true; isScrolling = false;
      card.style.transition = 'none';
      wrapper.classList.remove('swipe-full-edit', 'swipe-full-delete');
    }, { passive: true });

    wrapper.addEventListener('touchmove', e => {
      if (!dragging) return;
      const moveX = e.touches[0].clientX - startX;
      const moveY = e.touches[0].clientY - startY;

      // If primarily vertical — it's a scroll, don't interfere
      if (!isScrolling && Math.abs(moveY) > Math.abs(moveX) + 6) {
        isScrolling = true;
        card.style.transition = 'transform 0.22s ease';
        card.style.transform  = '';
        wrapper.classList.remove('swipe-full-edit', 'swipe-full-delete');
        return;
      }

      if (isScrolling) return;
      e.preventDefault(); // prevent page scroll during horizontal swipe

      dx = moveX;
      const width = Math.max(wrapper.offsetWidth || 320, 240);
      const clamped = Math.max(-width, Math.min(width, dx));
      const fullThreshold = width * FULL_RATIO;

      wrapper.classList.toggle('swipe-full-edit', clamped > fullThreshold);
      wrapper.classList.toggle('swipe-full-delete', clamped < -fullThreshold);
      card.style.transform = `translateX(${clamped}px)`;
    }, { passive: false });

    wrapper.addEventListener('touchend', () => {
      if (!dragging || isScrolling) { dragging = false; return; }
      dragging = false;
      card.style.transition = 'transform 0.24s ease';
      wrapper.classList.remove('swipe-full-edit', 'swipe-full-delete');

      const entryId = wrapper.dataset.entryId;
      const width = Math.max(wrapper.offsetWidth || 320, 240);
      const fullThreshold = width * FULL_RATIO;

      if (dx <= -fullThreshold) {
        // Full left swipe → delete after confirmation
        card.style.transform = `translateX(-${width}px)`;
        _openSwipeWrapper = null;
        window.setTimeout(() => {
          card.style.transform = '';
          deleteEntryById(entryId);
        }, 180);
      } else if (dx >= fullThreshold) {
        // Full right swipe → edit
        card.style.transform = `translateX(${width}px)`;
        _openSwipeWrapper = null;
        window.setTimeout(() => {
          card.style.transform = '';
          loadAndEditEntry(entryId);
        }, 180);
      } else if (dx <= -MENU_TRIGGER) {
        // Short left swipe → reveal delete
        card.style.transform = `translateX(-${REVEAL}px)`;
        _openSwipeWrapper = wrapper;
      } else if (dx >= MENU_TRIGGER) {
        // Short right swipe → reveal edit
        card.style.transform = `translateX(${REVEAL}px)`;
        _openSwipeWrapper = wrapper;
      } else {
        // Partial swipe — snap back
        card.style.transform = '';
        _openSwipeWrapper = null;
      }
    });
  });
}

// Reset any open swipe when user taps outside a card
document.addEventListener('touchstart', e => {
  if (_openSwipeWrapper && !_openSwipeWrapper.contains(e.target)) resetAllSwipes();
}, { passive: true });

async function loadAndEditEntry(id) {
  if (!currentUser) return;
  try {
    const snap = await db.collection(`users/${currentUser.uid}/visits`).doc(id).get();
    if (!snap.exists) { toast('Entry not found', 'error'); return; }
    _detailVisitId   = id;
    _detailVisitData = snap.data();
    startEditEntry();
  } catch(e) {
    console.error('loadAndEditEntry:', e);
    toast('Couldn\'t load entry — try again.', 'error');
  }
}

async function deleteEntryById(id) {
  if (!currentUser) return;
  if (!confirm('Are you sure you want to delete this entry?')) return;
  try {
    await db.collection(`users/${currentUser.uid}/visits`).doc(id).delete();
    toast('Entry deleted.', 'success');
    document.getElementById('entry-detail-overlay')?.classList.add('hidden');
    document.getElementById('place-detail-overlay')?.classList.add('hidden');
    if (currentScreen === 'home')         loadHome();
    else if (currentScreen === 'journey') loadJourney();
    else if (currentScreen === 'places')  loadPlaces();
  } catch(e) {
    console.error('deleteEntryById:', e);
    toast('Delete failed — try again.', 'error');
  }
}

// ── Streak Settings ────────────────────────────────────────────
function openStreakSettings() {
  const overlay = document.getElementById('streak-settings-overlay');
  if (!overlay) return;
  const inp = document.getElementById('streak-start-input');
  if (inp && _streakStartDate) inp.value = _streakStartDate;
  overlay.classList.remove('hidden');
}

function closeStreakSettings() {
  document.getElementById('streak-settings-overlay')?.classList.add('hidden');
}

async function saveStreakStart() {
  if (!currentUser) return;
  const inp = document.getElementById('streak-start-input');
  if (!inp || !inp.value) { toast('Pick a start date', 'error'); return; }
  const dateVal = inp.value;
  try {
    await db.collection(`users/${currentUser.uid}/settings`).doc('streakSettings').set({
      startDate: dateVal,
    });
    _streakStartDate = dateVal;
    closeStreakSettings();
    loadHome();
    toast('Streak start saved ✓', 'success');
  } catch(e) {
    console.error('saveStreakStart:', e);
    toast('Couldn\'t save — try again.', 'error');
  }
}

// ── Navigation wiring ─────────────────────────────────────────
document.querySelectorAll('.nav-btn[data-screen]').forEach(btn => {
  btn.addEventListener('click', () => navigate(btn.dataset.screen));
});
document.querySelector('.nav-fab').addEventListener('click', openLog);
document.getElementById('log-close-btn').addEventListener('click', () => navigate('home'));
document.getElementById('save-btn').addEventListener('click', saveEntry);
document.getElementById('photo-area').addEventListener('click', () =>
  document.getElementById('photo-input').click()
);

// ── Swipe-down to close sheets / popups ───────────────────────
// Works from anywhere on the sheet. When scroll content is below top, normal
// scroll happens; swipe-dismiss only fires when sheet is scrolled to the top.
(function() {
  const overlayMap = {
    'place-detail-overlay':       closePlaceDetail,
    'dest-detail-overlay':        closeDestination,
    'entry-detail-overlay':       closeEntryDetail,
    'wishlist-add-overlay':       closeWishlistAdd,
    'streak-settings-overlay':    closeStreakSettings,
    'filter-sheet-overlay':       closeFilterSheet,
    'feed-filter-sheet-overlay':  closeFeedFilterSheet,
  };

  Object.entries(overlayMap).forEach(([id, closeFn]) => {
    const overlay = document.getElementById(id);
    if (!overlay) return;

    // Tap backdrop (dark area outside sheet) → close without disturbing sheet content.
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeFn();
    });

    const sheet = overlay.querySelector('.place-detail-sheet, .detail-sheet, .filter-sheet');
    const scrollArea = overlay.querySelector('.place-detail-scroll, .detail-scroll, .filter-options');
    if (!sheet) return;

    makeSwipeDismissible(sheet, closeFn, scrollArea);
  });

  const globePopup = document.getElementById('globe-pin-popup');
  if (globePopup) {
    makeSwipeDismissible(globePopup, () => {
      if (typeof closeGlobePopup === 'function') closeGlobePopup();
      else globePopup.classList.add('hidden');
    }, globePopup.querySelector('.globe-pin-popup-body'));
  }
})();

function makeSwipeDismissible(sheet, closeFn, scrollArea = null) {
  let startY = 0, tracking = false;

  sheet.addEventListener('touchstart', e => {
    startY   = e.touches[0].clientY;
    tracking = true;
    sheet.style.transition = 'none';
  }, { passive: true });

  sheet.addEventListener('touchmove', e => {
    if (!tracking) return;
    const scrollTop = scrollArea ? scrollArea.scrollTop : 0;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0 && scrollTop <= 1) {
      // Dragging down at top of content — animate dismiss
      e.preventDefault();
      sheet.style.transform = `translateY(${Math.min(dy, 240)}px)`;
    } else {
      // Scrolling content — let it scroll normally
      tracking = false;
      sheet.style.transform = '';
    }
  }, { passive: false });

  sheet.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const dy = e.changedTouches[0].clientY - startY;
    sheet.style.transition = 'transform 0.22s ease';
    sheet.style.transform  = '';
    if (dy > 80) closeFn();
  });
}

// ── Service Worker ────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(r => console.log('[Crust] SW registered:', r.scope))
      .catch(e => console.warn('[Crust] SW failed:', e));
  });
}

// ── Log Screen — swipe-down to dismiss ───────────────────────
// Drag down on the log header to close. Works even when the
// log scroll area is at the top. Uses translateY on the whole
// screen so it feels like a native sheet being pulled away.
(function() {
  const logScreen = document.getElementById('screen-log');
  const logHeader = logScreen?.querySelector('.log-header');
  if (!logScreen || !logHeader) return;

  let startY = 0, tracking = false;

  logHeader.addEventListener('touchstart', e => {
    startY    = e.touches[0].clientY;
    tracking  = true;
    logScreen.style.transition = 'none';
  }, { passive: true });

  logHeader.addEventListener('touchmove', e => {
    if (!tracking) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { tracking = false; logScreen.style.transform = ''; return; }
    e.preventDefault();
    logScreen.style.transform = `translateY(${Math.min(dy, 320)}px)`;
  }, { passive: false });

  logHeader.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 88) {
      // Fly off screen then navigate home
      logScreen.style.transition = 'transform 0.22s ease';
      logScreen.style.transform  = 'translateY(100%)';
      setTimeout(() => {
        logScreen.style.transition = '';
        logScreen.style.transform  = '';
        navigate('home');
      }, 230);
    } else {
      // Snap back
      logScreen.style.transition = 'transform 0.28s cubic-bezier(.25,.46,.45,.94)';
      logScreen.style.transform  = '';
    }
  });
})();

// ── Helpers ───────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}


// ============================================================
// PHASE 3A — Passport + Feed + Destinations
// ============================================================

// ── Style colors for donut chart ──────────────────────────────
const STYLE_COLORS = {
  'Neapolitan':   '#C8A97E',
  'New York':     '#D4C5A0',
  'Detroit':      '#D85A30',
  'Sicilian':     '#A07850',
  'Deep Dish':    '#E8905A',
  'Tavern Style': '#8A7260',
  'Al Taglio':    '#6A9070',
  'Pan Pizza':    '#7080A0',
  'Other':        '#6A6A7A',
};

// ── PASSPORT ──────────────────────────────────────────────────

let _passportYearOrder = [];
let _passportYearIndex = 0;
let _passportYearStats = {};

async function loadPassport() {
  if (!currentUser) return;
  const body = document.getElementById('passport-body');
  if (!body) return;
  body.innerHTML = '<div class="empty-state"><div class="empty-body" style="opacity:.35;font-size:14px;">Loading…</div></div>';

  try {
    const [visSnap, plSnap, settingsSnap] = await Promise.all([
      db.collection(`users/${currentUser.uid}/visits`).get(),
      db.collection(`users/${currentUser.uid}/places`).get(),
      db.collection(`users/${currentUser.uid}/settings`).doc('streakSettings').get().catch(() => null),
    ]);
    const visits = visSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const places = plSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => !p.isWishlist);
    const passportStreakStart = (settingsSnap && settingsSnap.exists)
      ? (settingsSnap.data().startDate || null) : null;
    const passportStreak = calcSundayStreak(visits, passportStreakStart);
    renderPassportContent(visits, places, body, passportStreak, passportStreakStart);
  } catch (e) {
    console.error('loadPassport:', e);
    if (body) body.innerHTML = '<div class="empty-state"><div class="empty-body">Couldn\'t load stats.</div></div>';
  }
}

function renderPassportContent(visits, places, body, streak = 0, streakStartDate = null) {
  if (!visits.length) {
    body.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🛂</div>
      <div class="empty-title">No data yet</div>
      <div class="empty-body">Log some pizzas to see your stats.</div>
    </div>`;
    return;
  }

  const ratedVisits = visits.filter(v => v.rating != null && !isNaN(Number(v.rating)));
  const pies      = visits.length;
  const spots     = new Set(visits.map(v => v.placeId).filter(Boolean)).size;
  const cities    = new Set(visits.map(v => v.city).filter(Boolean)).size;
  const countries = new Set(visits.map(v => v.country).filter(Boolean)).size;
  const avgLife   = ratedVisits.length ? ratedVisits.reduce((s, v) => s + Number(v.rating), 0) / ratedVisits.length : 0;

  const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;
  const cleanMeta = (...parts) => parts.filter(Boolean).join(' · ');
  const scoreLabel = (n) => formatRating(n);

  const bestByAverage = (items, minCount = 1) => Object.values(items)
    .filter(x => x.count >= minCount)
    .map(x => ({ ...x, avg: x.total / x.count }))
    .sort((a, b) => (b.avg - a.avg) || (b.count - a.count) || String(a.label).localeCompare(String(b.label)))[0] || null;

  // Style breakdown by total logged styles
  const styleCounts = {};
  visits.forEach(v => (v.styles || []).forEach(s => {
    styleCounts[s] = (styleCounts[s] || 0) + 1;
  }));
  const styleData = Object.entries(styleCounts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  // Top rated style/city based on ratings, not total count
  const styleRatings = {};
  ratedVisits.forEach(v => (v.styles || []).forEach(style => {
    if (!styleRatings[style]) styleRatings[style] = { label: style, count: 0, total: 0 };
    styleRatings[style].count++;
    styleRatings[style].total += Number(v.rating);
  }));
  const topRatedStyle = bestByAverage(styleRatings, 3);

  const cityRatings = {};
  ratedVisits.forEach(v => {
    const city = (v.city || '').trim();
    if (!city) return;
    if (!cityRatings[city]) cityRatings[city] = { label: city, count: 0, total: 0 };
    cityRatings[city].count++;
    cityRatings[city].total += Number(v.rating);
  });
  const topRatedCity = bestByAverage(cityRatings, 3);

  const countryRatings = {};
  ratedVisits.forEach(v => {
    const country = (v.country || '').trim();
    if (!country) return;
    if (!countryRatings[country]) countryRatings[country] = { label: country, count: 0, total: 0 };
    countryRatings[country].count++;
    countryRatings[country].total += Number(v.rating);
  });
  const topRatedCountry = bestByAverage(countryRatings, 3);

  const explorerPct = pies ? Math.round((spots / pies) * 100) : 0;

  // Top rated places / Hall of Fame
  const ratedPlaces = places
    .filter(p => p.ratingHistory?.length)
    .map(p => ({ ...p, avg: avgRating(p.ratingHistory) }))
    .sort((a, b) => b.avg - a.avg || (b.visitCount || 0) - (a.visitCount || 0))
    .slice(0, 5);

  // Most visited / Repeat favorite
  const hof = places
    .filter(p => (p.visitCount || 0) > 0)
    .sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0) || (avgRating(b.ratingHistory) - avgRating(a.ratingHistory)))
    .slice(0, 5);
  const repeatFavorite = hof[0] || null;

  // Pies by year
  const byYear = {};
  visits.forEach(v => {
    const d = v.date?.toDate ? v.date.toDate() : new Date(v.date);
    if (isNaN(d)) return;
    const yr = String(d.getFullYear());
    byYear[yr] = (byYear[yr] || 0) + 1;
  });
  const yearKeys = Object.keys(byYear).sort((a, b) => Number(b) - Number(a));
  const maxPies  = Math.max(...Object.values(byYear), 1);
  const bestYear = yearKeys.reduce((best, yr) =>
    byYear[yr] > (byYear[best] || 0) ? yr : best, yearKeys[0]);

  const monthCounts = {};
  visits.forEach(v => {
    const d = v.date?.toDate ? v.date.toDate() : new Date(v.date);
    if (isNaN(d)) return;
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!monthCounts[key]) monthCounts[key] = {
      count: 0,
      label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
      monthOnly: d.toLocaleDateString('en-US', { month: 'short' }),
    };
    monthCounts[key].count++;
  });
  const bestMonth = Object.values(monthCounts).sort((a, b) => b.count - a.count)[0];

  const buildYearReviewStats = (year) => {
    const yearVisits = visits.filter(v => {
      const d = v.date?.toDate ? v.date.toDate() : new Date(v.date);
      return !isNaN(d) && d.getFullYear() === Number(year);
    });
    const ySpots = new Set(yearVisits.map(v => v.placeId).filter(Boolean)).size;
    const yCities = new Set(yearVisits.map(v => v.city).filter(Boolean)).size;
    const yCountries = new Set(yearVisits.map(v => v.country).filter(Boolean)).size;

    const yPlaceRatings = {};
    yearVisits.filter(v => v.rating != null && !isNaN(Number(v.rating))).forEach(v => {
      const key = v.placeId || v.placeName || 'unknown';
      if (!yPlaceRatings[key]) yPlaceRatings[key] = { count: 0, name: v.placeName || 'Unknown', total: 0 };
      yPlaceRatings[key].count++;
      yPlaceRatings[key].total += Number(v.rating);
    });
    const yTopSpot = Object.values(yPlaceRatings)
      .map(x => ({ ...x, avg: x.total / x.count }))
      .sort((a, b) => (b.avg - a.avg) || (b.count - a.count) || String(a.name).localeCompare(String(b.name)))[0] || null;

    const yStyleRatings = {};
    yearVisits.filter(v => v.rating != null && !isNaN(Number(v.rating))).forEach(v => (v.styles || []).forEach(style => {
      if (!yStyleRatings[style]) yStyleRatings[style] = { label: style, count: 0, total: 0 };
      yStyleRatings[style].count++;
      yStyleRatings[style].total += Number(v.rating);
    }));
    const yTopStyle = bestByAverage(yStyleRatings);
    return { year: String(year), visits: yearVisits, spots: ySpots, cities: yCities, countries: yCountries, topSpot: yTopSpot, topStyle: yTopStyle };
  };

  const currentYear = new Date().getFullYear();
  _passportYearOrder = yearKeys.length ? [...yearKeys] : [String(currentYear)];
  const currentYearIdx = _passportYearOrder.indexOf(String(currentYear));
  _passportYearIndex = currentYearIdx >= 0 ? currentYearIdx : 0;
  _passportYearStats = {};
  _passportYearOrder.forEach(yr => { _passportYearStats[yr] = buildYearReviewStats(yr); });

  body.innerHTML = `
    <div class="pp-section-label">Lifetime</div>
    <div class="stats-grid passport-lifetime-grid">
      <div class="stat-card"><div class="stat-label">Pizzas</div><div class="stat-num">${pies}</div></div>
      <div class="stat-card"><div class="stat-label">Spots</div><div class="stat-num">${spots}</div></div>
      <div class="stat-card"><div class="stat-label">Cities</div><div class="stat-num">${cities}</div></div>
      <div class="stat-card"><div class="stat-label">Countries</div><div class="stat-num">${countries}</div></div>
      <div class="stat-card streak" style="grid-column:span 2;cursor:default;">
        <div class="streak-emoji streak-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22c3.9 0 7-2.7 7-6.5 0-2.2-1-4.1-2.4-5.6-.7 2.2-2 3.3-3.1 3.8.7-3.6-.7-6.7-4-9.7.2 3.3-1.2 5.1-2.7 6.7C5.6 12 5 13.6 5 15.5 5 19.3 8.1 22 12 22Z"/>
            <path d="M12 18.8c1.4 0 2.6-1 2.6-2.4 0-.9-.4-1.6-1-2.2-.3.8-.8 1.2-1.3 1.4.2-1.4-.3-2.5-1.5-3.6.1 1.3-.5 2-1.1 2.6-.5.5-.7 1.1-.7 1.8 0 1.4 1.2 2.4 3 2.4Z"/>
          </svg>
        </div>
        <div class="streak-num">${streak}</div>
        <div class="streak-body">
          <div class="streak-title">Sunday Streak</div>
          <div class="streak-status">${streakLabel(streak, streakStartDate)}</div>
        </div>
      </div>
    </div>

    <div class="pp-section-label">Taste Profile</div>
    <div class="pp-insight-grid">
      <div class="pp-insight-card">
        <div class="pp-insight-value pp-insight-name">${topRatedStyle ? esc(topRatedStyle.label) : '—'}</div>
        <div class="pp-insight-label">Top Rated Style</div>
        <div class="pp-insight-sub">${topRatedStyle ? `Avg: ${scoreLabel(topRatedStyle.avg)} · Pizzas: ${topRatedStyle.count}` : 'Need 3 rated pizzas'}</div>
      </div>
      <div class="pp-insight-card">
        <div class="pp-insight-value">${ratedVisits.length ? scoreLabel(avgLife) : '—'}</div>
        <div class="pp-insight-label">Avg Rating</div>
        <div class="pp-insight-sub">Pizzas rated: ${ratedVisits.length}</div>
      </div>
      <div class="pp-insight-card">
        <div class="pp-insight-value pp-insight-name">${topRatedCity ? esc(topRatedCity.label) : '—'}</div>
        <div class="pp-insight-label">Top Rated City</div>
        <div class="pp-insight-sub">${topRatedCity ? `Avg: ${scoreLabel(topRatedCity.avg)} · Pizzas: ${topRatedCity.count}` : 'Need 3 rated pizzas'}</div>
      </div>
      <div class="pp-insight-card">
        <div class="pp-insight-value">${explorerPct}%</div>
        <div class="pp-insight-label">Explorer Score</div>
        <div class="pp-insight-sub">${spots}/${pies} unique spots</div>
      </div>
      <div class="pp-insight-card">
        <div class="pp-insight-value pp-insight-name">${topRatedCountry ? esc(topRatedCountry.label) : '—'}</div>
        <div class="pp-insight-label">Top Rated Country</div>
        <div class="pp-insight-sub">${topRatedCountry ? `Avg: ${scoreLabel(topRatedCountry.avg)} · Pizzas: ${topRatedCountry.count}` : 'Need 3 rated pizzas'}</div>
      </div>
      <div class="pp-insight-card">
        <div class="pp-insight-value">${repeatFavorite ? (repeatFavorite.visitCount || 0) : '—'}</div>
        <div class="pp-insight-label">Repeat Favorite</div>
        <div class="pp-insight-sub">${repeatFavorite ? esc(repeatFavorite.name || 'Unknown') : 'No repeats yet'}</div>
      </div>
    </div>

    ${styleData.length ? `
    <div class="pp-section-label">Style Breakdown</div>
    <div class="pp-card pp-style-card">${buildPizzaChart(styleData, pies)}</div>
    ` : ''}

    ${ratedPlaces.length ? `
    <div class="pp-section-label" style="margin-top:4px;">Hall of Fame</div>
    <div class="pp-rank-list">
      ${ratedPlaces.map((p, i) => {
        const loc = [p.city, p.country].filter(Boolean).join(', ');
        return `<div class="pp-rank-row" onclick="openPlace('${esc(p.placeId || p.id)}')" style="cursor:pointer;">
          <div class="pp-rank-num">${i + 1}</div>
          <div class="pp-rank-body">
            <div class="pp-rank-name">${esc(p.name || 'Unknown')}</div>
            <div class="pp-rank-sub">${esc(cleanMeta(loc, plural(p.ratingHistory?.length || 0, 'visit')))}</div>
          </div>
          <div class="pp-rank-score-wrap"><div class="pp-rank-score">${scoreLabel(p.avg)}</div><span>avg</span></div>
        </div>`;
      }).join('')}
    </div>
    ` : ''}

    ${hof.length ? `
    <div class="pp-section-label" style="margin-top:4px;">Most Visited</div>
    <div class="pp-rank-list pp-rank-list--compact">
      ${hof.map((p, i) => `
        <div class="pp-rank-row pp-rank-row--visits" onclick="openPlace('${esc(p.placeId || p.id)}')" style="cursor:pointer;">
          <div class="pp-rank-num">${i + 1}</div>
          <div class="pp-rank-body">
            <div class="pp-rank-name">${esc(p.name || 'Unknown')}</div>
            <div class="pp-rank-sub">${esc([p.city, p.country].filter(Boolean).join(', '))}</div>
          </div>
          <div class="pp-visit-count"><div>${p.visitCount || 1}</div><span>${(p.visitCount || 1) === 1 ? 'visit' : 'visits'}</span></div>
        </div>`).join('')}
    </div>
    ` : ''}

    ${yearKeys.length ? `
    <div class="pp-section-label" style="margin-top:4px;">Pizzas by Year</div>
    <div class="pp-card pp-year-card">
      <div class="pp-year-bars">
        ${yearKeys.map(yr => `
          <div class="pp-year-row">
            <div class="pp-year-label">${yr}</div>
            <div class="pp-year-track"><div class="pp-year-fill" style="width:${Math.max(7, Math.round((byYear[yr] / maxPies) * 100))}%"></div></div>
            <div class="pp-year-count">${byYear[yr]}</div>
          </div>`).join('')}
      </div>
    </div>
    ` : ''}

    <div class="pp-section-label" style="margin-top:4px;">Year in Review</div>
    <div class="pp-yir-shell" id="passport-yir-shell">
      <div class="pp-yir-switcher">
        <button class="pp-yir-arrow" onclick="passportChangeYear(1)" aria-label="Previous year">${chevronSvg('left')}</button>
        <div class="pp-yir-current-year" id="passport-yir-current-year">${_passportYearOrder[_passportYearIndex] || currentYear}</div>
        <button class="pp-yir-arrow" onclick="passportChangeYear(-1)" aria-label="Next year">${chevronSvg('right')}</button>
      </div>
      <div class="pp-yir-grid pp-yir-grid--new" id="passport-yir-content">
        ${buildPassportYearReviewHtml(_passportYearStats[_passportYearOrder[_passportYearIndex]], scoreLabel, plural)}
      </div>
    </div>
  `;

  updatePassportYearControls();
  initPassportYearReviewGestures();
}


function chevronSvg(direction = 'right') {
  const pts = direction === 'left' ? '15 18 9 12 15 6' : '9 18 15 12 9 6';
  return `<svg class="pp-yir-arrow-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round"></polyline>
  </svg>`;
}

function buildPassportYearReviewHtml(data, scoreLabel = formatRating, plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`) {
  if (!data) return '';
  const topSpot = data.topSpot;
  const topStyle = data.topStyle;
  const pizzaLabel = data.visits.length === 1 ? 'pizza' : 'pizzas';
  const spotLabel = data.spots === 1 ? 'spot' : 'spots';
  const cityLabel = data.cities === 1 ? 'city' : 'cities';
  const countryLabel = data.countries === 1 ? 'country' : 'countries';
  return `
    <div class="pp-yir-card pp-yir-snapshot">
      <div class="pp-yir-value pp-yir-name">${data.visits.length} ${pizzaLabel} · ${data.spots} ${spotLabel}</div>
      <div class="pp-yir-label">Pizzas</div>
      <div class="pp-yir-sub">Year in Review</div>
    </div>
    <div class="pp-yir-card pp-yir-snapshot">
      <div class="pp-yir-value pp-yir-name">${data.cities} ${cityLabel} · ${data.countries} ${countryLabel}</div>
      <div class="pp-yir-label">Destinations</div>
      <div class="pp-yir-sub">Year in Review</div>
    </div>
    <div class="pp-yir-card">
      <div class="pp-yir-value pp-yir-name">${topSpot ? esc(topSpot.name) : '—'}</div>
      <div class="pp-yir-label">Top Rated Spot</div>
      <div class="pp-yir-sub">${topSpot ? `Avg: ${scoreLabel(topSpot.avg)} · Visits: ${topSpot.count}` : 'No rated spots this year'}</div>
    </div>
    <div class="pp-yir-card">
      <div class="pp-yir-value pp-yir-name">${topStyle ? esc(topStyle.label) : '—'}</div>
      <div class="pp-yir-label">Top Rated Style</div>
      <div class="pp-yir-sub">${topStyle ? `Avg: ${scoreLabel(topStyle.avg)} · Pizzas: ${topStyle.count}` : 'No style ratings this year'}</div>
    </div>
  `;
}

function updatePassportYearControls() {
  const label = document.getElementById('passport-yir-current-year');
  const year = _passportYearOrder[_passportYearIndex];
  if (label && year) label.textContent = year;
  document.querySelectorAll('.pp-yir-arrow').forEach((btn, idx) => {
    btn.disabled = idx === 0 ? _passportYearIndex >= _passportYearOrder.length - 1 : _passportYearIndex <= 0;
  });
}

function initPassportYearReviewGestures() {
  const shell = document.getElementById('passport-yir-shell');
  if (!shell) return;

  // Rebind cleanly every render/load so the carousel never gets stuck with stale handlers.
  if (shell._yirCleanup) shell._yirCleanup();

  let startX = 0;
  let startY = 0;
  let tracking = false;

  const begin = (x, y) => {
    startX = x;
    startY = y;
    tracking = true;
  };

  const finish = (x, y) => {
    if (!tracking) return;
    tracking = false;

    const dx = x - startX;
    const dy = y - startY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    // Horizontal intent only: small threshold, but ignore normal vertical scrolls.
    if (adx < 34 || adx < ady * 1.15) return;

    // Natural carousel feel: swipe left moves toward the newer/previous item, swipe right moves toward the older/next item.
    passportChangeYear(dx < 0 ? -1 : 1);
  };

  const onTouchStart = (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    begin(e.touches[0].clientX, e.touches[0].clientY);
  };
  const onTouchEnd = (e) => {
    if (!e.changedTouches || !e.changedTouches.length) return;
    finish(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
  };
  const onTouchCancel = () => { tracking = false; };

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    begin(e.clientX, e.clientY);
  };
  const onPointerUp = (e) => finish(e.clientX, e.clientY);
  const onPointerCancel = () => { tracking = false; };

  shell.addEventListener('touchstart', onTouchStart, { passive: true });
  shell.addEventListener('touchend', onTouchEnd, { passive: true });
  shell.addEventListener('touchcancel', onTouchCancel, { passive: true });
  shell.addEventListener('pointerdown', onPointerDown);
  shell.addEventListener('pointerup', onPointerUp);
  shell.addEventListener('pointercancel', onPointerCancel);
  shell.addEventListener('lostpointercapture', onPointerCancel);

  shell._yirCleanup = () => {
    shell.removeEventListener('touchstart', onTouchStart);
    shell.removeEventListener('touchend', onTouchEnd);
    shell.removeEventListener('touchcancel', onTouchCancel);
    shell.removeEventListener('pointerdown', onPointerDown);
    shell.removeEventListener('pointerup', onPointerUp);
    shell.removeEventListener('pointercancel', onPointerCancel);
    shell.removeEventListener('lostpointercapture', onPointerCancel);
    shell._yirCleanup = null;
  };
}

function passportChangeYear(delta) {
  if (!_passportYearOrder.length || !delta) {
    updatePassportYearControls();
    return;
  }
  const nextIndex = Math.max(0, Math.min(_passportYearOrder.length - 1, _passportYearIndex + delta));
  if (nextIndex === _passportYearIndex) {
    updatePassportYearControls();
    return;
  }
  _passportYearIndex = nextIndex;
  const year = _passportYearOrder[_passportYearIndex];
  const content = document.getElementById('passport-yir-content');
  if (content) content.innerHTML = buildPassportYearReviewHtml(_passportYearStats[year]);
  updatePassportYearControls();
}

function buildPizzaChart(styleData, totalPies) {
  const total = styleData.reduce((sum, d) => sum + d.count, 0);
  if (!total) return '';

  const cx = 86;
  const cy = 86;
  const radius = 58;
  const stroke = 18;
  const gapDeg = styleData.length === 1 ? 0 : 1.1;
  let angle = -90;

  const polar = (r, deg) => {
    const rad = (deg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };

  const arcPath = (startDeg, endDeg) => {
    const start = polar(radius, startDeg);
    const end = polar(radius, endDeg);
    const largeArc = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  };

  const segments = styleData.map((d, i) => {
    const frac = d.count / total;
    const sweep = frac * 360;
    const start = angle + gapDeg / 2;
    const end = angle + sweep - gapDeg / 2;
    angle += sweep;
    return {
      ...d,
      pct: Math.round(frac * 100),
      color: STYLE_COLORS[d.label] || '#777',
      start,
      end,
      delay: i * 55,
    };
  });

  return `
    <div class="pp-style-breakdown">
      <div class="pp-style-donut-wrap">
        <svg viewBox="0 0 172 172" class="pp-style-donut" aria-label="Pizza style breakdown chart">
          <circle class="pp-style-track" cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke-width="${stroke}" />
          ${segments.map(s => `
            <path class="pp-style-segment" d="${arcPath(s.start, s.end)}" fill="none" stroke="${s.color}" stroke-width="${stroke}" style="--delay:${s.delay}ms;" />
          `).join('')}
          <circle class="pp-style-inner" cx="${cx}" cy="${cy}" r="40" />
          <text x="${cx}" y="${cy - 2}" class="pp-style-total" text-anchor="middle">${totalPies}</text>
          <text x="${cx}" y="${cy + 20}" class="pp-style-label" text-anchor="middle">PIZZAS</text>
        </svg>
      </div>
      <div class="pp-style-list">
        ${segments.map((s, i) => `
          <div class="pp-style-row">
            <div class="pp-style-rank">${i + 1}</div>
            <div class="pp-style-dot" style="background:${s.color}"></div>
            <div class="pp-style-name">${esc(s.label)}</div>
            <div class="pp-style-count">${s.count}</div>
            <div class="pp-style-pct">${s.pct}%</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function buildDonutChart(styleData, totalPies) {
  return buildPizzaChart(styleData, totalPies);
}

// ── PHOTO FEED ────────────────────────────────────────────────

let _feedVisits         = [];
let _feedFilters        = { city: '', style: '' };
let _feedFilterOpts     = { cities: [], styles: [] };
let _feedActiveFilter   = null;
let _feedFilterOptsList = [];

async function loadFeed() {
  if (!currentUser) return;
  const grid = document.getElementById('feed-grid');
  if (!grid) return;

  grid.innerHTML = `
    <div class="feed-loading" style="grid-column:1/-1;">
      <div class="skel" style="height:110px;border-radius:18px;"></div>
      <div class="skel" style="height:110px;border-radius:18px;"></div>
      <div class="skel" style="height:110px;border-radius:18px;"></div>
    </div>`;

  try {
    const snap = await db.collection(`users/${currentUser.uid}/visits`)
      .orderBy('date', 'desc')
      .get();

    _feedVisits = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(v => v.photoUrl);

    _feedFilterOpts.cities = [...new Set(_feedVisits.map(v => (v.city || '').trim()).filter(Boolean))].sort();
    _feedFilterOpts.styles = [...new Set(_feedVisits.flatMap(v => v.styles || []))].sort();

    _feedFilters = { city: '', style: '' };

    renderFeedFilterPills();
    renderFeedSortPills();
    renderFeedGrid();

    if (_pendingFeedOpenId) {
      openFeedPhoto(_pendingFeedOpenId);
      _pendingFeedOpenId = null;
    }
  } catch (e) {
    console.error('loadFeed:', e);
    grid.innerHTML = `
      <div class="empty-state feed-empty" style="grid-column:1/-1">
        <div class="empty-icon">📷</div>
        <div class="empty-title">Couldn’t load photos</div>
        <div class="empty-body">Try again in a moment.</div>
      </div>`;
  }
}

function feedDateValue(v) {
  const d = v.date?.toDate ? v.date.toDate() : new Date(v.date);
  return isNaN(d) ? 0 : d.getTime();
}

function getFilteredFeedVisits() {
  let visits = _feedVisits;

  if (_feedFilters.city) {
    visits = visits.filter(v => (v.city || '').trim() === _feedFilters.city);
  }
  if (_feedFilters.style) {
    visits = visits.filter(v => (v.styles || []).includes(_feedFilters.style));
  }

  visits = [...visits];

  if (_feedSort === 'rating') {
    visits.sort((a, b) => {
      const ratingDelta = (b.rating ?? -1) - (a.rating ?? -1);
      if (ratingDelta !== 0) return ratingDelta;
      return feedDateValue(b) - feedDateValue(a);
    });
  } else {
    visits.sort((a, b) => feedDateValue(b) - feedDateValue(a));
  }

  return visits;
}

function renderFeedFilterPills() {
  const row       = document.getElementById('feed-filters');
  const filterRow = document.getElementById('feed-filters-row');
  if (!row) return;

  const pills = [];
  const pill = (key, label) => {
    const active = _feedFilters[key];
    pills.push(`
      <button class="filter-pill feed-pill ${active ? 'active' : ''}" onclick="openFeedFilter('${key}')">
        ${active ? esc(active) : label}
      </button>`);
  };

  if (_feedFilterOpts.cities.length > 1) pill('city',  'City');
  if (_feedFilterOpts.styles.length > 0) pill('style', 'Style');

  row.innerHTML = pills.join('');
  if (filterRow) filterRow.style.display = pills.length ? 'flex' : 'none';
}

function renderFeedSortPills() {
  document.querySelectorAll('#feed-sort-row .filter-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.sort === _feedSort);
  });
}

function setFeedSort(sort) {
  if (!['date', 'rating'].includes(sort)) return;
  _feedSort = sort;
  renderFeedSortPills();
  renderFeedGrid();
}

function feedActiveLabel() {
  const filters = [];
  if (_feedFilters.city) filters.push(_feedFilters.city);
  if (_feedFilters.style) filters.push(_feedFilters.style);
  return filters.join(' · ');
}

function renderFeedCount(visits) {
  const count = document.getElementById('feed-count');
  if (!count) return;
  const total = visits.length;
  const active = feedActiveLabel();
  const photoLabel = total === 1 ? 'Photo' : 'Photos';
  count.textContent = active ? `${total} ${photoLabel} · ${active}` : `${total} ${photoLabel}`;
}

function renderFeedGrid() {
  const grid = document.getElementById('feed-grid');
  if (!grid) return;

  const visits = getFilteredFeedVisits();
  renderFeedCount(visits);

  if (!visits.length) {
    grid.innerHTML = `
      <div class="empty-state feed-empty" style="grid-column:1/-1">
        <div class="empty-icon">📷</div>
        <div class="empty-title">No photos here</div>
        <div class="empty-body">Try adjusting your filters or add photos when logging pizzas.</div>
      </div>`;
    return;
  }

  grid.innerHTML = visits.map((v) => {
    return `
      <button class="feed-cell" onclick="openFeedPhoto('${v.id}')" aria-label="Open ${esc(v.placeName || 'photo')}">
        <img src="${esc(v.photoUrl)}" loading="lazy" onerror="this.closest('.feed-cell').classList.add('image-error');this.remove();" />
        <div class="feed-cell-fallback">${pizzaPlaceholderSvg(26)}</div>
        <div class="feed-cell-overlay">
          <div class="feed-cell-title">${esc(v.placeName || 'Unknown')}</div>
        </div>
      </button>`;
  }).join('');
}

function openFeedFilter(key) {
  _feedActiveFilter   = key;
  _feedFilterOptsList = key === 'city' ? _feedFilterOpts.cities : _feedFilterOpts.styles;
  const current       = _feedFilters[key];
  const titles        = { city: 'City', style: 'Style' };

  document.getElementById('feed-filter-sheet-title').textContent = titles[key] || key;
  document.getElementById('feed-filter-options-list').innerHTML = _feedFilterOptsList.map((o, i) => `
    <div class="filter-option ${o === current ? 'selected' : ''}" onclick="selectFeedFilter(${i})">
      <span>${esc(o)}</span>
      <div class="filter-option-check">
        ${o === current ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="#141414" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
      </div>
    </div>`).join('');

  document.getElementById('feed-filter-sheet-overlay').classList.remove('hidden');
}

function selectFeedFilter(i) {
  const value = _feedFilterOptsList[i];
  if (value === undefined) return;
  _feedFilters[_feedActiveFilter] = (_feedFilters[_feedActiveFilter] === value) ? '' : value;
  closeFeedFilterSheet();
  renderFeedFilterPills();
  renderFeedGrid();
}

function clearFeedFilter() {
  if (_feedActiveFilter) {
    _feedFilters[_feedActiveFilter] = '';
    renderFeedFilterPills();
    renderFeedGrid();
  }
  closeFeedFilterSheet();
}

function closeFeedFilterSheet() {
  document.getElementById('feed-filter-sheet-overlay').classList.add('hidden');
  _feedActiveFilter = null;
}

function openFeedPhoto(id) {
  const visits = getFilteredFeedVisits();
  _feedCurrentFilteredList = visits;
  _feedCurrentIdx = Math.max(0, visits.findIndex(v => v.id === id));

  const scroll = document.getElementById('ifeed-scroll');
  if (!scroll) return;

  scroll.innerHTML = visits.map((v, idx) => buildIFeedPost(v, idx, visits.length)).join('');
  document.getElementById('feed-photo-overlay').classList.remove('hidden');

  requestAnimationFrame(() => {
    const target = document.getElementById(`ifeed-post-${id}`);
    if (target) target.scrollIntoView({ behavior: 'auto', block: 'start' });
  });
}

function buildIFeedPost(v, idx = 0, total = 0) {
  const d    = v.date?.toDate ? v.date.toDate() : new Date(v.date);
  const dStr = isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const loc  = [v.city, v.country].filter(Boolean).join(', ');
  const tags = (v.styles || []).map(s => `<span class="style-tag">${esc(s)}</span>`).join('');
  const position = total > 1 ? `${idx + 1} of ${total}` : '1 photo';

  const placeAction = v.placeId
    ? `openFeedPlace('${esc(v.placeId)}')`
    : `openFeedEntry('${v.id}')`;

  return `
    <article class="ifeed-post" id="ifeed-post-${v.id}">
      <div class="ifeed-photo-wrap">
        <img src="${esc(v.photoUrl)}" class="ifeed-photo" loading="lazy" onerror="this.closest('.ifeed-photo-wrap').classList.add('image-error');this.remove();" />
        <div class="ifeed-photo-fallback">${pizzaPlaceholderSvg(44)}</div>
      </div>
      <div class="ifeed-meta">
        <div class="ifeed-top-row">
          ${v.rating != null ? `<button class="ifeed-rating" onclick="openFeedEntry('${v.id}')" aria-label="Open entry rated ${formatRating(v.rating)}">${formatRating(v.rating)}</button>` : '<div></div>'}
          ${tags ? `<div class="ifeed-tags">${tags}</div>` : ''}
        </div>
        <button class="ifeed-place" onclick="${placeAction}" aria-label="Open ${esc(v.placeName || 'place')}">${esc(v.placeName || 'Unknown')}</button>
        <div class="ifeed-subline">
          ${loc ? `<span>${esc(loc)}</span>` : ''}
          ${loc && dStr ? '<span class="ifeed-dot">·</span>' : ''}
          ${dStr ? `<span>${dStr}</span>` : ''}
        </div>
        ${v.notes ? `<div class="ifeed-notes">${esc(v.notes)}</div>` : ''}
        <div class="ifeed-actions ifeed-actions--position-only">
          <span class="ifeed-position">${position}</span>
        </div>
      </div>
    </article>`;
}

function openFeedEntry(id) {
  const overlay = document.getElementById('entry-detail-overlay');
  if (overlay) {
    overlay.dataset.returnTo = 'feed';
    overlay.style.zIndex = '940';
  }
  openEntry(id);
}

function openFeedPlace(placeId) {
  openPlace(placeId);
}

function closeFeedPhoto() {
  document.getElementById('feed-photo-overlay').classList.add('hidden');
  const scroll = document.getElementById('ifeed-scroll');
  if (scroll) scroll.innerHTML = '';
  _feedCurrentFilteredList = [];
}


// ── DESTINATIONS ──────────────────────────────────────────────

let _destVisits = null;
let _destView   = 'city'; // 'city' | 'country'

async function loadDestinations() {
  const feed    = document.getElementById('places-feed');
  const sortBar = document.getElementById('places-sort-bar');
  if (!feed || !currentUser) return;
  if (sortBar) sortBar.style.display = 'none';
  feed.innerHTML = destViewToggle() + skeletonCards(3);

  try {
    const [visSnap, coverSnap] = await Promise.all([
      db.collection(`users/${currentUser.uid}/visits`).get(),
      db.collection(`users/${currentUser.uid}/destCovers`).get().catch(() => null),
    ]);
    _destVisits = visSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    _destCovers = {};
    if (coverSnap) {
      coverSnap.docs.forEach(d => { _destCovers[d.id] = d.data().photoUrl || null; });
    }
    renderDestCards();
  } catch (e) {
    console.error('loadDestinations:', e);
    if (feed) feed.innerHTML = `<div class="empty-state"><div class="empty-body">Couldn't load destinations.</div></div>`;
  }
}

function setDestView(view) {
  _destView = view;
  renderDestCards();
}

function navigateToDestinations(view) {
  _destView  = view;
  _placesTab = 'destinations';
  navigate('places');
  // Sync tab button states after nav
  requestAnimationFrame(() => {
    document.querySelectorAll('.places-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === 'destinations'));
  });
}

function destViewToggle() {
  return `<div class="dest-toggle">
    <button class="dest-toggle-btn ${_destView === 'city'    ? 'active' : ''}" onclick="setDestView('city')">Cities</button>
    <button class="dest-toggle-btn ${_destView === 'country' ? 'active' : ''}" onclick="setDestView('country')">Countries</button>
  </div>`;
}

function renderDestCards() {
  const feed = document.getElementById('places-feed');
  if (!feed || !_destVisits) return;

  const key    = _destView === 'city' ? 'city' : 'country';
  const groups = {};
  _destVisits.forEach(v => {
    const k = v[key];
    if (!k) return;
    if (!groups[k]) groups[k] = { name: k, visits: [], places: new Set(), photo: null };
    groups[k].visits.push(v);
    if (v.placeId) groups[k].places.add(v.placeId);
    if (!groups[k].photo && v.photoUrl) groups[k].photo = v.photoUrl;
  });

  _destGroups = Object.values(groups).sort((a, b) => b.visits.length - a.visits.length);
  // Overlay custom cover photos
  _destGroups.forEach(g => {
    const ck = `${_destView}__${g.name}`;
    if (_destCovers[ck]) g.customPhoto = _destCovers[ck];
  });

  if (!_destGroups.length) {
    feed.innerHTML = destViewToggle() + `<div class="empty-state">
      <div class="empty-icon">🌍</div>
      <div class="empty-title">No destinations yet</div>
      <div class="empty-body">Log a pizza to start your pizza passport.</div>
    </div>`;
    return;
  }

  feed.innerHTML = destViewToggle() + `<div class="dest-feed">${_destGroups.map((g, i) => destCard(g, i)).join('')}</div>`;
}

function destCard(g, i) {
  const spots = g.places.size;
  const photo = g.customPhoto || g.photo;
  return `
    <div class="dest-card" onclick="openDestination(${i})">
      <div class="dest-card-photo-wrap">
        ${photo
          ? `<img src="${esc(photo)}" class="dest-card-photo" loading="lazy" />`
          : `<div class="dest-card-photo dest-card-photo-empty">${destinationPlaceholderSvg(30)}</div>`}
      </div>
      <div class="dest-card-body">
        <div class="dest-card-name">${esc(g.name)}</div>
        <div class="dest-card-meta">
          <span class="place-visit-badge" style="font-size:10px;">${g.visits.length} ${g.visits.length === 1 ? 'pizza' : 'pizzas'}</span>
          <span class="place-last-visit">${spots} ${spots === 1 ? 'spot' : 'spots'}</span>
        </div>
      </div>
    </div>`;
}


async function openDestination(idx) {
  const g = _destGroups[idx];
  if (!g) return;
  const name    = g.name;
  const overlay = document.getElementById('dest-detail-overlay');
  const body    = document.getElementById('dest-detail-body');
  const titleEl = document.getElementById('dest-detail-title');
  if (!overlay || !body || !_destVisits) return;

  if (titleEl) titleEl.textContent = name;
  overlay.classList.remove('hidden');
  body.innerHTML = '<div style="text-align:center;padding:48px;opacity:.35;font-size:14px;">Loading…</div>';

  const key  = _destView === 'city' ? 'city' : 'country';
  const mine = _destVisits.filter(v => v[key] === name);

  // Group visits by place
  const placeMap = {};
  mine.forEach(v => {
    const pid = v.placeId || ('noplace_' + v.id);
    if (!placeMap[pid]) placeMap[pid] = { placeId: pid, name: v.placeName, city: v.city, country: v.country, visits: [], ratings: [] };
    placeMap[pid].visits.push(v);
    if (v.rating != null) placeMap[pid].ratings.push(v.rating);
  });

  const placeList = Object.values(placeMap).sort((a, b) => {
    const avgA = a.ratings.length ? (a.ratings.reduce((s, r) => s + Number(r), 0) / a.ratings.length) : -Infinity;
    const avgB = b.ratings.length ? (b.ratings.reduce((s, r) => s + Number(r), 0) / b.ratings.length) : -Infinity;
    if (avgB !== avgA) return avgB - avgA;
    if (b.visits.length !== a.visits.length) return b.visits.length - a.visits.length;
    const lastA = Math.max(...a.visits.map(v => {
      const d = v.date?.toDate ? v.date.toDate() : new Date(v.date || 0);
      return isNaN(d) ? 0 : d.getTime();
    }));
    const lastB = Math.max(...b.visits.map(v => {
      const d = v.date?.toDate ? v.date.toDate() : new Date(v.date || 0);
      return isNaN(d) ? 0 : d.getTime();
    }));
    return lastB - lastA;
  });
  const bestRated = [...placeList].filter(p => p.ratings.length).sort((a, b) => {
    const avgA = a.ratings.reduce((s, r) => s + Number(r), 0) / a.ratings.length;
    const avgB = b.ratings.reduce((s, r) => s + Number(r), 0) / b.ratings.length;
    return (avgB - avgA) || (b.visits.length - a.visits.length);
  })[0];

  const coverKey   = `${_destView}__${name}`;
  const coverPhoto = _destCovers[coverKey] || mine.find(v => v.photoUrl)?.photoUrl;

  body.innerHTML = `
    <div class="dest-cover-wrap">
      ${coverPhoto
        ? `<img src="${esc(coverPhoto)}" class="dest-cover-img" />`
        : `<div class="dest-cover-placeholder">${destinationPlaceholderSvg(42)}</div>`}
      <button class="dest-cover-change-btn" onclick="changeDestCover('${esc(coverKey)}')">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        Change photo
      </button>
    </div>
    <div class="place-stats-row" style="margin-bottom:20px;">
      <div class="place-stat-chip">
        <div class="place-stat-chip-num">${mine.length}</div>
        <div class="place-stat-chip-label">Pizzas</div>
      </div>
      <div class="place-stat-chip">
        <div class="place-stat-chip-num">${placeList.length}</div>
        <div class="place-stat-chip-label">Spots</div>
      </div>
    </div>

    ${bestRated ? `
    <div class="place-section-label">Best Spot</div>
    <div class="dest-best-spot">
      <div class="dest-best-body">
        <div class="dest-best-name">${esc(bestRated.name || 'Unknown')}</div>
        <div class="dest-best-meta">${bestRated.visits.length} ${bestRated.visits.length === 1 ? 'visit' : 'visits'}</div>
      </div>
      <div class="dest-best-rating">${formatRating(bestRated.ratings.reduce((s, r) => s + r, 0) / bestRated.ratings.length)}</div>
    </div>` : ''}

    <div class="place-section-label" style="margin-top:${bestRated ? '20px' : '0'};">All Spots</div>
    ${placeList.map(p => {
      const avg       = p.ratings.length ? (p.ratings.reduce((s, r) => s + r, 0) / p.ratings.length) : null;
      const tappable  = p.placeId && !p.placeId.startsWith('noplace_');
      const clickAttr = tappable ? `onclick="openPlace('${esc(p.placeId)}')" style="cursor:pointer;"` : '';
      return `<div class="dest-spot-row" ${clickAttr}>
        <div class="dest-spot-body">
          <div class="dest-spot-name${tappable ? ' dest-spot-name--link' : ''}">${esc(p.name || 'Unknown')}</div>
          <div class="dest-spot-sub">${p.visits.length} ${p.visits.length === 1 ? 'visit' : 'visits'}</div>
        </div>
        ${avg !== null ? `<div class="dest-spot-rating">${formatRating(avg)}</div>` : ''}
      </div>`;
    }).join('')}
  `;
}

async function changeDestCover(coverKey) {
  if (!currentUser) return;
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = async function() {
    const file = this.files[0];
    if (!file) return;
    try {
      const compressed = await compressPhoto(file);
      const ref = storage.ref(`users/${currentUser.uid}/destCovers/${Date.now()}.jpg`);
      await ref.put(compressed, { contentType: 'image/jpeg' });
      const url = await ref.getDownloadURL();
      await db.collection(`users/${currentUser.uid}/destCovers`).doc(coverKey).set({
        photoUrl: url,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      _destCovers[coverKey] = url;
      // Update visible cover in the open detail sheet
      const img = document.querySelector('.dest-cover-img');
      if (img) { img.src = url; }
      else {
        const ph = document.querySelector('.dest-cover-placeholder');
        if (ph) ph.outerHTML = `<img src="${esc(url)}" class="dest-cover-img" />`;
      }
      // Update cache so card updates on next render
      const g = _destGroups.find(g => `${_destView}__${g.name}` === coverKey);
      if (g) g.customPhoto = url;
      toast('Cover photo updated ✓', 'success');
    } catch(e) {
      console.error('changeDestCover:', e);
      toast('Photo update failed — try again.', 'error');
    }
  };
  input.click();
}

function closeDestination() {
  document.getElementById('dest-detail-overlay').classList.add('hidden');
}

