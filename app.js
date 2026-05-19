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
    const snap = await db.collection(`users/${uid}/visits`).get();
    const visits = snap.docs.map(d => d.data());

    const pies      = visits.length;
    const spots     = new Set(visits.map(v => v.placeId).filter(Boolean)).size;
    const cities    = new Set(visits.map(v => v.city).filter(Boolean)).size;
    const countries = new Set(visits.map(v => v.country).filter(Boolean)).size;
    const streak    = calcSundayStreak(visits);

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
function calcSundayStreak(visits) {
  // Build a set of "YYYY-MM-DD" keys for all visit dates that are Sundays
  const sundaySet = new Set();
  visits.forEach(v => {
    const d = v.date?.toDate ? v.date.toDate() : (v.date ? new Date(v.date) : null);
    if (!d || isNaN(d)) return;
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
      .limit(4)
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
    container.innerHTML = snap.docs.map(d => entryCard(d.id, d.data())).join('');
  } catch (e) {
    console.error('loadRecent:', e);
    container.innerHTML = `<div class="empty-state"><div class="empty-body">Couldn't load entries.</div></div>`;
  }
}

function entryCard(id, v) {
  const d    = v.date?.toDate ? v.date.toDate() : new Date(v.date);
  const dStr = isNaN(d) ? '' : d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  const tags = (v.styles || []).slice(0,2).map(s => `<span class="style-tag">${esc(s)}</span>`).join('');
  const thumb = v.photoUrl
    ? `<img src="${esc(v.photoUrl)}" class="entry-thumb" loading="lazy" />`
    : `<div class="entry-thumb-placeholder">🍕</div>`;

  return `
    <div class="entry-card" onclick="openEntry('${id}')">
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

  document.getElementById('entry-detail-overlay').classList.add('hidden');
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

// ── Journey Screen (Phase 2 placeholder) ─────────────────────
function loadJourney() {
  // Full implementation in Phase 2
}

// ── Places Screen (Phase 2 placeholder) ──────────────────────
function loadPlaces() {
  // Full implementation in Phase 2
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
    console.log(data);
    const suggestions = data.suggestions || [];

    if (!suggestions.length) { list.innerHTML = ''; return; }

    list.innerHTML = suggestions.slice(0, 5).map(s => {
      const p = s.placePrediction;
      const main = p.structuredFormat?.mainText?.text || p.text?.text || '';
      const sub  = p.structuredFormat?.secondaryText?.text || '';
      return `
        <div class="autocomplete-item" onclick="selectPlace('${esc(p.placeId)}','${esc(main)}','${esc(sub)}')">
          <div class="place-name">${esc(main)}</div>
          <div class="place-sub">${esc(sub)}</div>
        </div>`;
    }).join('');

  } catch (e) {
    console.warn('[Crust] Autocomplete error:', e);
    list.innerHTML = '';
  }
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
    navigator.serviceWorker.register('/sw.js')
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
