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
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const s = document.getElementById(`screen-${id}`);
  if (s) { s.classList.add('active'); currentScreen = id; }

  document.querySelectorAll('.nav-btn[data-screen], .nav-fab[data-screen]').forEach(b => {
    b.classList.toggle('active', b.dataset.screen === id);
  });

  // Scroll to top on navigation
  if (s) s.scrollTop = 0;

  // Load screen data
  if (id === 'home')    loadHome();
  if (id === 'journey') loadJourney();
  if (id === 'places')  loadPlaces();
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
    navigate('home');
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
  await Promise.all([loadStats(uid), loadRecent(uid)]);
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
    set('stat-streak',    streak);
    set('streak-status',  streakLabel(streak));
  } catch (e) {
    console.error('loadStats:', e);
  }
}

function set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function streakLabel(n) {
  if (n === 0) return 'Log a Sunday to start';
  if (n === 1) return '1 Sunday strong 🍕';
  return `${n} Sundays straight`;
}

// Sunday streak: counts consecutive Sundays with at least one logged visit,
// walking backward from the most recent Sunday (or today if today is Sunday).
// Backdating always allowed — streak recalculates from all stored data.
// startDate (YYYY-MM-DD string) optionally ignores Sundays before that date.
function calcSundayStreak(visits, startDate = null) {
  const startMs = startDate ? new Date(startDate + 'T00:00:00').getTime() : 0;
  // Build a set of "YYYY-MM-DD" keys for all visit dates that are Sundays
  const sundaySet = new Set();
  visits.forEach(v => {
    const d = v.date?.toDate ? v.date.toDate() : (v.date ? new Date(v.date) : null);
    if (!d || isNaN(d)) return;
    if (startDate && d.getTime() < startMs) return;
    if (d.getDay() === 0) sundaySet.add(ymd(d));
  });
  if (!sundaySet.size) return 0;

  // Most recent past Sunday (today if today is Sunday)
  const today = new Date();
  const offset = today.getDay() === 0 ? 0 : today.getDay();
  const anchor = new Date(today);
  anchor.setDate(today.getDate() - offset);
  anchor.setHours(0,0,0,0);

  // If the anchor Sunday was not logged and today isn't Sunday → streak broken
  if (!sundaySet.has(ymd(anchor)) && today.getDay() !== 0) return 0;

  // Walk backward counting consecutive logged Sundays
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

async function loadRecent(uid) {
  const container = document.getElementById('recent-entries');
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
    : `<div class="entry-thumb-placeholder">🍕</div>`;
  const tapFn = (context === 'open-place' && v.placeId)
    ? `openPlace('${esc(v.placeId)}')`
    : `openEntry('${id}')`;

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
          <div class="entry-place">${esc(v.placeName || 'Unknown')}</div>
          <div class="entry-sub">${esc(v.city || '')}${v.city && dStr ? ' · ' : ''}${dStr}</div>
          <div class="entry-tags">${tags}</div>
        </div>
        <div class="entry-right">
          <div class="entry-rating-num">${v.rating ?? '—'}</div>
          <div class="entry-rating-denom">/ 10</div>
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
      <div class="detail-meta-row">
        <div class="detail-rating-big">${(v.rating ?? '—')}<span> / 10</span></div>
        <div class="detail-date-str">${dStr}</div>
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
  document.getElementById('entry-detail-overlay').classList.add('hidden');
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
  document.querySelectorAll('.style-chip').forEach(c => {
    c.classList.toggle('on', selectedStyles.includes(c.dataset.style));
  });

  // Notes
  qv('log-notes', v.notes || '');

  // Existing photo
  existingPhotoUrl = v.photoUrl || null;
  if (v.photoUrl) {
    const pa = document.getElementById('photo-area-inner');
    if (pa) pa.innerHTML = `<img src="${esc(v.photoUrl)}" /><div class="photo-overlay">Tap to change</div>`;
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
  if (!confirm('Delete this entry? This can\'t be undone.')) return;

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
    const snap = await db.collection(`users/${currentUser.uid}/visits`)
      .orderBy('date', 'desc')
      .get();
    _journeyVisits = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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

async function loadPlaces() {
  if (!currentUser) return;
  const feed = document.getElementById('places-feed');
  if (feed) feed.innerHTML = skeletonCards(3);

  try {
    const snap = await db.collection(`users/${currentUser.uid}/places`).get();
    _placesAll = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (_placesTab === 'destinations') { loadDestinations(); } else { renderPlaces(); }
  } catch (e) {
    console.error('loadPlaces:', e);
    if (feed) feed.innerHTML = `<div class="empty-state"><div class="empty-body">Couldn't load places.</div></div>`;
  }
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
}

function wishlistAddBtn() {
  return `<button class="btn-add-wishlist" onclick="openWishlistAdd()">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
    Add a place
  </button>`;
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

  if (p.isWishlist) {
    return `
      <div class="place-card wishlist" onclick="openPlace('${pid}')">
        <div class="place-card-top">
          <div class="place-card-name">${esc(p.name || 'Unknown')}</div>
          <span class="wishlist-badge">Want</span>
        </div>
        ${loc ? `<div class="place-card-sub">${esc(loc)}</div>` : ''}
      </div>`;
  }

  return `
    <div class="place-card" onclick="openPlace('${pid}')">
      <div class="place-card-top">
        <div class="place-card-name">${esc(p.name || 'Unknown')}</div>
        ${avg ? `<div class="place-card-rating">${avg.toFixed(1)}<span>/ 10</span></div>` : ''}
      </div>
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
    </div>`;
}

function switchPlacesTab(tab) {
  _placesTab = tab;
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
              <span class="rating-drift-date">${esc(r.date)}</span>
              <span class="rating-drift-val">${r.rating}</span>
            </div>`).join('')}
        </div>`;
    }

    body.innerHTML = `
      <div class="place-detail-name">${esc(place.name || 'Unknown')}</div>
      ${loc ? `<div class="place-detail-location">${esc(loc)}</div>` : ''}
      <div class="place-stats-row">
        <div class="place-stat-chip">
          <div class="place-stat-chip-num">${vc}</div>
          <div class="place-stat-chip-label">${vc === 1 ? 'Visit' : 'Visits'}</div>
        </div>
        ${avg ? `<div class="place-stat-chip">
          <div class="place-stat-chip-num">${avg.toFixed(1)}</div>
          <div class="place-stat-chip-label">Avg Rating</div>
        </div>` : ''}
      </div>
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
  document.getElementById('place-detail-overlay').classList.add('hidden');
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

  document.querySelectorAll('.style-chip').forEach(c => c.classList.remove('on'));

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

// Style chips
document.querySelectorAll('.style-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const s = chip.dataset.style;
    if (selectedStyles.includes(s)) {
      selectedStyles = selectedStyles.filter(x => x !== s);
      chip.classList.remove('on');
    } else {
      selectedStyles.push(s);
      chip.classList.add('on');
    }
  });
});

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
  pa.innerHTML = `
    <img src="${url}" />
    <div class="photo-overlay">Tap to change</div>`;
});

function photoAreaDefault() {
  return `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".45">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
      <circle cx="12" cy="13" r="4"/>
    </svg>
    <span>Add photo</span>`;
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

      await placeRef.update({
        ratingHistory: firebase.firestore.FieldValue.arrayUnion({
          date:   dateInput,
          rating: selectedRating,
        }),
      }).catch(() => {});

      await batch.commit();

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

    let startX = 0, startY = 0, dx = 0;
    let dragging = false, isScrolling = false;
    const TRIGGER = 72; // px to trigger action

    wrapper.addEventListener('touchstart', e => {
      if (_openSwipeWrapper && _openSwipeWrapper !== wrapper) resetAllSwipes();
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dx = 0; dragging = true; isScrolling = false;
      card.style.transition = 'none';
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
        return;
      }
      if (isScrolling) return;
      e.preventDefault(); // prevent page scroll during horizontal swipe
      dx = moveX;
      const clamped = Math.max(-(TRIGGER + 24), Math.min(TRIGGER, dx));
      card.style.transform = `translateX(${clamped}px)`;
    }, { passive: false });

    wrapper.addEventListener('touchend', () => {
      if (!dragging || isScrolling) { dragging = false; return; }
      dragging = false;
      card.style.transition = 'transform 0.22s ease';
      const entryId = wrapper.dataset.entryId;

      if (dx < -TRIGGER) {
        // Left swipe → delete
        card.style.transform = '';
        _openSwipeWrapper = null;
        deleteEntryById(entryId);
      } else if (dx > TRIGGER) {
        // Right swipe → edit
        card.style.transform = '';
        _openSwipeWrapper = null;
        loadAndEditEntry(entryId);
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
  if (!confirm('Delete this entry? This can\'t be undone.')) return;
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

// ── Service Worker ────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(r => console.log('[Crust] SW registered:', r.scope))
      .catch(e => console.warn('[Crust] SW failed:', e));
  });
}

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

async function loadPassport() {
  if (!currentUser) return;
  const body = document.getElementById('passport-body');
  if (!body) return;
  body.innerHTML = '<div class="empty-state"><div class="empty-body" style="opacity:.35;font-size:14px;">Loading…</div></div>';

  try {
    const [visSnap, plSnap] = await Promise.all([
      db.collection(`users/${currentUser.uid}/visits`).get(),
      db.collection(`users/${currentUser.uid}/places`).get(),
    ]);
    const visits = visSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const places = plSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => !p.isWishlist);
    renderPassportContent(visits, places, body);
  } catch (e) {
    console.error('loadPassport:', e);
    if (body) body.innerHTML = '<div class="empty-state"><div class="empty-body">Couldn\'t load stats.</div></div>';
  }
}

function renderPassportContent(visits, places, body) {
  if (!visits.length) {
    body.innerHTML = `<div class="empty-state">
      <div class="empty-icon">🛂</div>
      <div class="empty-title">No data yet</div>
      <div class="empty-body">Log some pizzas to see your stats.</div>
    </div>`;
    return;
  }

  // Lifetime stats
  const pies      = visits.length;
  const spots     = new Set(visits.map(v => v.placeId).filter(Boolean)).size;
  const cities    = new Set(visits.map(v => v.city).filter(Boolean)).size;
  const countries = new Set(visits.map(v => v.country).filter(Boolean)).size;

  // Style breakdown
  const styleCounts = {};
  visits.forEach(v => (v.styles || []).forEach(s => {
    styleCounts[s] = (styleCounts[s] || 0) + 1;
  }));
  const styleData = Object.entries(styleCounts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  // Top 10 rated
  const ratedPlaces = places
    .filter(p => p.ratingHistory?.length)
    .map(p => ({ ...p, avg: avgRating(p.ratingHistory) }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 10);

  // Hall of Fame
  const hof = places
    .filter(p => (p.visitCount || 0) > 0)
    .sort((a, b) => (b.visitCount || 0) - (a.visitCount || 0))
    .filter(p => (p.visitCount || 0) > 1)
    .slice(0, 10);

  // Pies by year
  const byYear = {};
  visits.forEach(v => {
    const d = v.date?.toDate ? v.date.toDate() : new Date(v.date);
    if (isNaN(d)) return;
    const yr = String(d.getFullYear());
    byYear[yr] = (byYear[yr] || 0) + 1;
  });
  const yearKeys = Object.keys(byYear).sort();
  const maxPies  = Math.max(...Object.values(byYear), 1);

  // Year in review
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

  const currentYear = new Date().getFullYear();
  const tyPlaceCount = {};
  visits.forEach(v => {
    const d = v.date?.toDate ? v.date.toDate() : new Date(v.date);
    if (isNaN(d) || d.getFullYear() !== currentYear) return;
    if (!v.placeId) return;
    if (!tyPlaceCount[v.placeId]) tyPlaceCount[v.placeId] = { count: 0, name: v.placeName };
    tyPlaceCount[v.placeId].count++;
  });
  const topSpot = Object.values(tyPlaceCount).sort((a, b) => b.count - a.count)[0];

  body.innerHTML = `
    <div class="pp-section-label">Lifetime</div>
    <div class="stats-grid" style="padding:0 16px 16px;">
      <div class="stat-card"><div class="stat-label">Pizzas</div><div class="stat-num">${pies}</div></div>
      <div class="stat-card"><div class="stat-label">Spots</div><div class="stat-num">${spots}</div></div>
      <div class="stat-card"><div class="stat-label">Cities</div><div class="stat-num">${cities}</div></div>
      <div class="stat-card"><div class="stat-label">Countries</div><div class="stat-num">${countries}</div></div>
    </div>

    ${styleData.length ? `
    <div class="pp-section-label">Style Breakdown</div>
    <div class="pp-card">${buildDonutChart(styleData, pies)}</div>
    ` : ''}

    ${ratedPlaces.length ? `
    <div class="pp-section-label" style="margin-top:4px;">Top 10 Rated</div>
    <div class="pp-rank-list">
      ${ratedPlaces.map((p, i) => `
        <div class="pp-rank-row">
          <div class="pp-rank-num">${i + 1}</div>
          <div class="pp-rank-body">
            <div class="pp-rank-name">${esc(p.name || 'Unknown')}</div>
            <div class="pp-rank-sub">${esc([p.city, p.country].filter(Boolean).join(', '))}${p.ratingHistory?.length ? ` · ${p.ratingHistory.length} ${p.ratingHistory.length === 1 ? 'visit' : 'visits'}` : ''}</div>
          </div>
          <div class="pp-rank-score">${p.avg.toFixed(1)}</div>
        </div>`).join('')}
    </div>
    ` : ''}

    ${hof.length ? `
    <div class="pp-section-label" style="margin-top:4px;">Hall of Fame</div>
    <div class="pp-rank-list">
      ${hof.map((p, i) => `
        <div class="pp-rank-row">
          <div class="pp-rank-num">${i + 1}</div>
          <div class="pp-rank-body">
            <div class="pp-rank-name">${esc(p.name || 'Unknown')}</div>
            <div class="pp-rank-sub">${esc([p.city, p.country].filter(Boolean).join(', '))}</div>
          </div>
          <div class="pp-rank-score pp-rank-visits">${p.visitCount || 1}<span>×</span></div>
        </div>`).join('')}
    </div>
    ` : ''}

    ${yearKeys.length ? `
    <div class="pp-section-label" style="margin-top:4px;">Pies by Year</div>
    <div class="pp-card">
      <div class="bar-chart">
        ${yearKeys.map(yr => `
          <div class="bar-col">
            <div class="bar-count">${byYear[yr]}</div>
            <div class="bar-fill" style="height:${Math.max(4, Math.round((byYear[yr] / maxPies) * 80))}px"></div>
            <div class="bar-label">${yr.slice(2)}</div>
          </div>`).join('')}
      </div>
    </div>
    ` : ''}

    <div class="pp-section-label" style="margin-top:4px;">Year in Review</div>
    <div class="pp-yir-grid">
      <div class="pp-yir-card">
        <div class="pp-yir-value">${bestYear || '—'}</div>
        <div class="pp-yir-label">Best Year</div>
        <div class="pp-yir-sub">${bestYear ? `${byYear[bestYear]} pies` : ''}</div>
      </div>
      <div class="pp-yir-card">
        <div class="pp-yir-value">${bestMonth?.monthOnly || '—'}</div>
        <div class="pp-yir-label">Top Month</div>
        <div class="pp-yir-sub">${bestMonth ? `${bestMonth.count} pies · ${bestMonth.label}` : ''}</div>
      </div>
      <div class="pp-yir-card pp-yir-full">
        <div class="pp-yir-value" style="font-size:${topSpot && topSpot.name.length > 18 ? '14px' : '18px'};line-height:1.3;">${topSpot ? esc(topSpot.name) : '—'}</div>
        <div class="pp-yir-label">${currentYear} Top Spot</div>
        <div class="pp-yir-sub">${topSpot ? `${topSpot.count} ${topSpot.count === 1 ? 'visit' : 'visits'} this year` : 'No visits logged this year'}</div>
      </div>
    </div>
  `;
}

function buildDonutChart(styleData, totalPies) {
  const r = 50, cx = 68, cy = 68, sw = 20;
  const circ = 2 * Math.PI * r;
  const total = styleData.reduce((s, d) => s + d.count, 0);

  let cumFrac = 0;
  const slices = styleData.map(d => {
    const frac = d.count / total;
    const dashArray = `${frac * circ} ${circ}`;
    const dashOffset = -(cumFrac * circ);
    cumFrac += frac;
    return {
      label: d.label,
      count: d.count,
      color: STYLE_COLORS[d.label] || '#6A6A7A',
      dashArray,
      dashOffset,
    };
  });

  const legend = slices.map(s =>
    `<div class="donut-legend-item">
      <div class="donut-dot" style="background:${s.color}"></div>
      <span class="donut-lbl">${esc(s.label)}</span>
      <span class="donut-cnt">${s.count}</span>
    </div>`
  ).join('');

  return `
    <div class="donut-wrap">
      <svg viewBox="0 0 136 136" width="136" height="136" style="flex-shrink:0">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
          stroke="rgba(240,234,214,0.07)" stroke-width="${sw}"/>
        <g transform="rotate(-90 ${cx} ${cy})">
          ${slices.map(s => `
            <circle cx="${cx}" cy="${cy}" r="${r}"
              fill="none" stroke="${s.color}"
              stroke-width="${sw}"
              stroke-dasharray="${s.dashArray}"
              stroke-dashoffset="${s.dashOffset}"
            />`).join('')}
        </g>
        <text x="${cx}" y="${cy - 5}" text-anchor="middle" fill="#F0EAD6"
          font-family="Outfit,sans-serif" font-size="24" font-weight="200">${totalPies}</text>
        <text x="${cx}" y="${cy + 13}" text-anchor="middle" fill="rgba(240,234,214,0.4)"
          font-family="Outfit,sans-serif" font-size="9" font-weight="600" letter-spacing="1.5">PIES</text>
      </svg>
      <div class="donut-legend">${legend}</div>
    </div>`;
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
  grid.innerHTML = '<div style="grid-column:1/-1;padding:48px;text-align:center;opacity:.35;font-size:14px;">Loading…</div>';

  try {
    const snap = await db.collection(`users/${currentUser.uid}/visits`)
      .orderBy('date', 'desc')
      .get();
    _feedVisits = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(v => v.photoUrl);

    _feedFilterOpts.cities = [...new Set(_feedVisits.map(v => v.city).filter(Boolean))].sort();
    _feedFilterOpts.styles = [...new Set(_feedVisits.flatMap(v => v.styles || []))].sort();
    _feedFilters = { city: '', style: '' };

    renderFeedFilterPills();
    renderFeedGrid();
  } catch (e) {
    console.error('loadFeed:', e);
    if (grid) grid.innerHTML = '<div style="grid-column:1/-1;padding:48px;text-align:center;opacity:.35;font-size:14px;">Couldn\'t load photos.</div>';
  }
}

function renderFeedFilterPills() {
  const row = document.getElementById('feed-filters');
  if (!row) return;
  const pills = [];
  const pill = (key, label) => {
    const active = _feedFilters[key];
    pills.push(`<button class="filter-pill ${active ? 'active' : ''}" onclick="openFeedFilter('${key}')">${active ? esc(active) : label}</button>`);
  };
  if (_feedFilterOpts.cities.length > 1) pill('city',  'City');
  if (_feedFilterOpts.styles.length > 0) pill('style', 'Style');
  row.innerHTML = pills.join('');
}

function renderFeedGrid() {
  const grid = document.getElementById('feed-grid');
  if (!grid) return;

  let visits = _feedVisits;
  if (_feedFilters.city)  visits = visits.filter(v => v.city === _feedFilters.city);
  if (_feedFilters.style) visits = visits.filter(v => (v.styles || []).includes(_feedFilters.style));

  if (!visits.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <div class="empty-icon">📷</div>
      <div class="empty-title">No photos here</div>
      <div class="empty-body">Add photos when logging pizzas to see them here.</div>
    </div>`;
    return;
  }

  grid.innerHTML = visits.map(v => `
    <div class="feed-cell" onclick="openFeedPhoto('${v.id}')">
      <img src="${esc(v.photoUrl)}" loading="lazy" />
    </div>`).join('');
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
  const v = _feedVisits.find(x => x.id === id);
  if (!v) return;

  const d    = v.date?.toDate ? v.date.toDate() : new Date(v.date);
  const dStr = isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const loc  = [v.city, v.country].filter(Boolean).join(', ');

  document.getElementById('feed-photo-img').src            = v.photoUrl;
  document.getElementById('feed-photo-place').textContent  = v.placeName || '';
  document.getElementById('feed-photo-sub').textContent    = [loc, dStr].filter(Boolean).join(' · ');
  document.getElementById('feed-photo-rating').textContent = v.rating != null ? `${v.rating} / 10` : '';

  const notesEl = document.getElementById('feed-photo-notes');
  if (notesEl) {
    notesEl.textContent  = v.notes || '';
    notesEl.style.display = v.notes ? 'block' : 'none';
  }

  document.getElementById('feed-photo-overlay').classList.remove('hidden');
}

function closeFeedPhoto() {
  document.getElementById('feed-photo-overlay').classList.add('hidden');
  document.getElementById('feed-photo-img').src = '';
}

// ── DESTINATIONS ──────────────────────────────────────────────

let _destVisits = null;
let _destView   = 'city'; // 'city' | 'country'

async function loadDestinations() {
  const feed = document.getElementById('places-feed');
  if (!feed || !currentUser) return;
  feed.innerHTML = destViewToggle() + skeletonCards(3);

  try {
    const snap = await db.collection(`users/${currentUser.uid}/visits`).get();
    _destVisits = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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

  const sorted = Object.values(groups).sort((a, b) => b.visits.length - a.visits.length);

  if (!sorted.length) {
    feed.innerHTML = destViewToggle() + `<div class="empty-state">
      <div class="empty-icon">🌍</div>
      <div class="empty-title">No destinations yet</div>
      <div class="empty-body">Log a pizza to start your pizza passport.</div>
    </div>`;
    return;
  }

  feed.innerHTML = destViewToggle() + `<div class="dest-feed">${sorted.map(g => destCard(g)).join('')}</div>`;
}

function destCard(g) {
  const spots = g.places.size;
  const nameJson = JSON.stringify(g.name);
  return `
    <div class="dest-card" onclick="openDestination(${nameJson})">
      <div class="dest-card-photo-wrap">
        ${g.photo
          ? `<img src="${esc(g.photo)}" class="dest-card-photo" loading="lazy" />`
          : `<div class="dest-card-photo dest-card-photo-empty">🍕</div>`}
      </div>
      <div class="dest-card-body">
        <div class="dest-card-name">${esc(g.name)}</div>
        <div class="dest-card-meta">
          <span class="place-visit-badge" style="font-size:10px;">${g.visits.length} ${g.visits.length === 1 ? 'pie' : 'pies'}</span>
          <span class="place-last-visit">${spots} ${spots === 1 ? 'spot' : 'spots'}</span>
        </div>
      </div>
    </div>`;
}

async function openDestination(name) {
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
    if (!placeMap[pid]) placeMap[pid] = { name: v.placeName, city: v.city, country: v.country, visits: [], ratings: [] };
    placeMap[pid].visits.push(v);
    if (v.rating != null) placeMap[pid].ratings.push(v.rating);
  });

  const placeList = Object.values(placeMap).sort((a, b) => b.visits.length - a.visits.length);
  const bestRated = [...placeList].filter(p => p.ratings.length).sort((a, b) => {
    const avgA = a.ratings.reduce((s, r) => s + r, 0) / a.ratings.length;
    const avgB = b.ratings.reduce((s, r) => s + r, 0) / b.ratings.length;
    return avgB - avgA;
  })[0];

  const coverPhoto = mine.find(v => v.photoUrl)?.photoUrl;

  body.innerHTML = `
    ${coverPhoto ? `<img src="${esc(coverPhoto)}" style="width:100%;border-radius:14px;margin-bottom:16px;max-height:200px;object-fit:cover;" />` : ''}
    <div class="place-stats-row" style="margin-bottom:20px;">
      <div class="place-stat-chip">
        <div class="place-stat-chip-num">${mine.length}</div>
        <div class="place-stat-chip-label">Pies</div>
      </div>
      <div class="place-stat-chip">
        <div class="place-stat-chip-num">${placeList.length}</div>
        <div class="place-stat-chip-label">Spots</div>
      </div>
    </div>

    ${bestRated ? `
    <div class="place-section-label">Best Spot</div>
    <div class="dest-best-spot">
      <div class="dest-best-name">${esc(bestRated.name || 'Unknown')}</div>
      <div class="dest-best-meta">${bestRated.visits.length} ${bestRated.visits.length === 1 ? 'visit' : 'visits'} · Avg ${(bestRated.ratings.reduce((s, r) => s + r, 0) / bestRated.ratings.length).toFixed(1)}</div>
    </div>` : ''}

    <div class="place-section-label" style="margin-top:${bestRated ? '20px' : '0'};">All Spots</div>
    ${placeList.map(p => {
      const avg = p.ratings.length ? (p.ratings.reduce((s, r) => s + r, 0) / p.ratings.length) : null;
      return `<div class="dest-spot-row">
        <div class="dest-spot-body">
          <div class="dest-spot-name">${esc(p.name || 'Unknown')}</div>
          <div class="dest-spot-sub">${p.visits.length} ${p.visits.length === 1 ? 'visit' : 'visits'}</div>
        </div>
        ${avg !== null ? `<div class="dest-spot-rating">${avg.toFixed(1)}</div>` : ''}
      </div>`;
    }).join('')}
  `;
}

function closeDestination() {
  document.getElementById('dest-detail-overlay').classList.add('hidden');
}
