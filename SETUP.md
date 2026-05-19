# Crust — Setup Guide

## What you'll need
- Firebase account (free tier is fine)  
- Google Cloud Console access (same project as Firebase)  
- Netlify account (free tier is fine)  
- A simple local server for dev (one command below)

---

## Step 1 — Create a Firebase Project

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. **Add project** → name it `crust` (or anything)
3. Disable Google Analytics — not needed
4. Click **Create project**

---

## Step 2 — Enable Authentication

1. Firebase Console → **Authentication** → Get started
2. **Sign-in method** tab → **Google** → Enable → Save
3. Still in Authentication → **Settings** → **Authorized domains**  
   Add: `localhost` (for dev) — your Netlify URL comes later

---

## Step 3 — Create Firestore Database

1. Firebase Console → **Firestore Database** → Create database
2. Choose **Production mode**
3. Pick a region (e.g., `nam5` for US Central)
4. After creation → **Rules** tab → replace everything with the contents of `firestore.rules`  
5. **Publish**

---

## Step 4 — Enable Firebase Storage

1. Firebase Console → **Storage** → Get started
2. Production mode → same region as Firestore
3. After creation → **Rules** tab → replace everything with the contents of `storage.rules`  
4. **Publish**

---

## Step 5 — Get Your Firebase Config

1. Firebase Console → **Project Settings** (gear icon, top left) → **General** tab
2. Scroll to **Your apps** → click the Web icon (`</>`) → **Register app**
3. Name it `Crust Web` → Register
4. Copy the `firebaseConfig` object that appears
5. Open `firebase-config.js` and paste your values:

```js
const firebaseConfig = {
  apiKey:            "AIza...",
  authDomain:        "your-project.firebaseapp.com",
  projectId:         "your-project",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123...:web:abc..."
};
```

---

## Step 6 — Google Places API

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Make sure your **Firebase project** is selected in the project dropdown
3. **APIs & Services** → **Library** → search **Places API (New)** → Enable
4. **APIs & Services** → **Credentials** → **Create Credentials** → **API Key**
5. After creation, click **Edit API key**:
   - Under **API restrictions**: select **Restrict key** → choose **Places API (New)**
   - Under **Application restrictions**: **HTTP referrers** → add:
     - `http://localhost:3000/*`
     - `https://your-netlify-app.netlify.app/*` (add after you deploy)
6. Copy the key → paste into `firebase-config.js`:

```js
const PLACES_API_KEY = "AIza...";
```

> **Cost note:** Places API has a generous free tier ($200/month credit). Personal
> use logging a few pies per week won't come close to incurring charges.

---

## Step 7 — Generate App Icons

The icon SVG is in `index.html` (inside the loading overlay). To export PNGs:

**Recommended: Figma (free)**
1. Create a new frame: `100 × 100` with corner radius `22`, background `#141414`
2. Paste the SVG paths from the Icon spec into the frame
3. Export at:
   - `192 × 192` → save as `icons/icon-192.png`
   - `512 × 512` → save as `icons/icon-512.png`
   - `180 × 180` → save as `icons/icon-180.png` (Apple touch icon)

**Quick alternative:** [svgtopng.com](https://svgtopng.com) — paste the SVG from the
loading overlay, export at each size.

---

## Step 8 — Local Development

No build step needed. Just serve the root directory:

```bash
# Option A — Python (built-in)
python3 -m http.server 3000

# Option B — npx (Node)
npx serve . -p 3000

# Option C — npm global
npm install -g serve && serve . -p 3000
```

Open `http://localhost:3000` → you should see the Crust loading screen → sign in with Google.

> **iOS testing:** Use `https://` for full PWA behavior. Either deploy to Netlify
> (free) or use a tunnel like `ngrok http 3000` to get an HTTPS URL for local testing.

---

## Step 9 — Deploy to Netlify

1. Push all files to a **GitHub repo** (public or private, both work)
2. [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import an existing project** → GitHub
3. Select your repo
4. **Build settings:**
   - Build command: *(leave empty)*
   - Publish directory: `.`
5. **Deploy site**

6. Copy your Netlify URL (e.g., `https://crust-pizza.netlify.app`)
7. Firebase Console → Authentication → Settings → Authorized domains → **Add domain** → paste Netlify URL
8. Google Cloud Console → Credentials → Edit your API key → HTTP referrers → add `https://your-netlify-app.netlify.app/*`

---

## File Structure

```
crust/
├── index.html          ← App shell (all screens)
├── styles.css          ← Design system
├── app.js              ← All app logic, auth, Firestore queries
├── firebase-config.js  ← YOUR CONFIG — fill this in first
├── manifest.json       ← PWA manifest
├── sw.js               ← Service worker (offline + installability)
├── netlify.toml        ← SPA redirect rule for Netlify
├── firestore.rules     ← Paste into Firebase Console
├── storage.rules       ← Paste into Firebase Console
└── icons/
    ├── icon-180.png    ← Apple touch icon (generate from SVG)
    ├── icon-192.png    ← PWA manifest icon
    └── icon-512.png    ← PWA manifest icon (maskable)
```

---

## Firestore Data Structure

```
users/
  {uid}/
    visits/
      {visitId}: {
        placeId, placeName, address, city, country,
        lat, lng, date, rating, styles[], notes,
        photoUrl, createdAt
      }
    places/
      {placeId}: {
        placeId, name, address, city, country, lat, lng,
        visitCount, lastVisited, ratingHistory[], isWishlist
      }
```

---

## Phase Roadmap

| Phase | Screens |
|-------|---------|
| ✅ 1 | Auth, App shell, Home stats, Log a pie (full save) |
| 2     | Journey Log (full feed, filters, search) |
| 2     | Places (cards, visit history, rating drift, bucket list) |
| 3     | Destinations (city/country cards) |
| 3     | World Map (globe pins, clustering) |
| 3     | The Passport (stats hub, charts) |
| 4     | The Feed (photo grid) |
