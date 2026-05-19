// ============================================================
// CRUST — Firebase Configuration
// Fill in your Firebase project values below, then deploy.
// See SETUP.md for step-by-step instructions.
// ============================================================

const firebaseConfig = {
  apiKey:            "AIzaSyCWF7nR3aJ-APQw8hP4TseAi6RuWGmVwjs",
  authDomain:        "crust-pizza-7f4ca.firebaseapp.com",
  projectId:         "crust-pizza-7f4ca",
  storageBucket:     "crust-pizza-7f4ca.firebasestorage.app",
  messagingSenderId: "896891153651",
  appId:             "1:896891153651:web:ecbb04487e199714c2db86"
};

// Google Places API key — restricted to your domain
const PLACES_API_KEY = "AIzaSyCE3P3SOuA4B5b7H6v47OscxTByex6_jfo";

// ── Initialize Firebase ──────────────────────────────────────
firebase.initializeApp(firebaseConfig);

const auth    = firebase.auth();
const db      = firebase.firestore();
const storage = firebase.storage();

// Offline persistence — Firestore caches locally so the app
// works even with a spotty connection. Data syncs on reconnect.
db.enablePersistence({ synchronizeTabs: true }).catch(err => {
  if (err.code === 'failed-precondition') {
    console.warn('[Crust] Persistence unavailable: multiple tabs open');
  } else if (err.code === 'unimplemented') {
    console.warn('[Crust] Persistence not supported in this browser');
  }
});
