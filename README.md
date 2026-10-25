# FieldGuide — Visual Flashcards, Recall & Quiz PWA

A sleek, mobile-first Progressive Web App (PWA) for Android and desktop designed for visual identification and knowledge training.

## Built-in Starter Decks
1. **🦅 Bird Identification** (Common name, scientific name, raptor/waterbird/songbird badges, field notes, key traits, and Wikipedia links)
2. **🌸 Flower Identification** (Common name, botanical Latin name, plant family, petal structure traits, and Wikipedia links)
3. **✈️ Plane Identification** (Commercial airliners, fighters, supersonic & transport aircraft, spotting cues, and Wikipedia links)

Plus a sample custom import deck in [`data/sample-deck-butterflies.json`](./data/sample-deck-butterflies.json).

## 3 Practice Modes
- **📖 Browse Mode (Field Guide)**: Casual reading through cards with zoomable high-res photos, Fit/Fill toggle, common & scientific names, key identification features, full descriptions, and direct links to Wikipedia/sources.
- **🔄 Recall Mode (3D Flip Flashcards)**: Practice active recall with smooth 3D card flips. Switch between **Photo First** or **Name First**, filter to **Needs Practice Only**, and grade yourself (*Still Learning* vs *Got It!*).
- **🎯 Quiz Mode (Multiple-Choice Game)**: Interactive 4-option multiple-choice quiz with streak counters (`🔥`), instant visual feedback, explanations on answer, and 4 question styles (*Mixed*, *Photo → Common Name*, *Photo → Scientific/Model*, or *Clues → Name*).

## Offline Image Caching & Smart Wikipedia Image Resolver
- Every deck has a **📥 Save Images Offline** button that downloads the actual image blobs and stores them in **IndexedDB** on your device so they work 100% offline.
- **Resilient to AI URL hallucinations**: When you ask an AI to build a JSON deck, you don't even have to worry if the AI omits `imageUrl` or provides a broken image URL—as long as `name` or `sourceUrl` (Wikipedia link) is present, the app automatically queries the official Wikipedia REST API, fetches the lead photo, and saves it locally to IndexedDB!

## AI Deck JSON Schema
Tap **＋ AI / JSON Deck** in the top header to either:
1. Copy a ready-made prompt for ChatGPT, Claude, or Gemini for any topic you type, or
2. Upload a `.json` file / paste JSON text directly.

```json
{
  "title": "Australian Backyard Birds",
  "category": "Nature & Wildlife",
  "icon": "🦜",
  "color": "#10b981",
  "description": "Identify common Australian birds.",
  "cards": [
    {
      "id": "magpie-1",
      "name": "Australian Magpie",
      "subtitle": "Gymnorhina tibicen",
      "badge": "Artamidae",
      "imageUrl": "https://upload.wikimedia.org/...",
      "description": "Medium-sized black and white passerine bird native to Australia and southern New Guinea.",
      "keyFeatures": "Pied black-and-white plumage, wedge-shaped bluish-white bill, melodic warbling call.",
      "sourceUrl": "https://en.wikipedia.org/wiki/Australian_magpie"
    }
  ]
}
```

## Running Locally & Installing on Android
1. Serve the folder over HTTP (e.g., `npx serve .` or `python -m http.server 8080`).
2. To install on **Android**: host the static files (e.g., on GitHub Pages, Netlify, Cloudflare Pages, or LAN IP) and open in Chrome on Android → tap **⋮ Menu → Add to Home screen / Install app**.
