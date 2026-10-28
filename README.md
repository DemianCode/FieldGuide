# FieldGuide — Visual Flashcards, Recall & Quiz PWA

A sleek, mobile-first Progressive Web App (PWA) for Android and desktop designed for visual identification and knowledge training.

## Built-in Starter Decks
1. **🦅 Bird Identification** (Common name, scientific name, raptor/waterbird/songbird badges, field notes, key traits, and Wikipedia links)
2. **🌸 Flower Identification** (Common name, botanical Latin name, plant family, petal structure traits, and Wikipedia links)
3. **✈️ Plane Identification** (Commercial airliners, fighters, supersonic & transport aircraft, spotting cues, and Wikipedia links)

Plus a sample custom import deck in [`data/sample-deck-butterflies.json`](./data/sample-deck-butterflies.json).

## Look and feel
- Mobile-first, one-handed layout: 44px minimum touch targets, 56–64px primary buttons.
- **Today** home screen with a practice button, daily streak and a 2-column deck grid.
- **Light, dark or automatic** appearance (home menu → Appearance). Remembered between visits.
- Gestures: swipe left/right to move through cards in Read, swipe the revealed card right (*Got it*) or left (*Still learning*) in Recall, drag a sheet's handle down to close it.

## 3 Practice Modes
- **📖 Browse Mode (Field Guide)**: Casual reading through cards with zoomable high-res photos, Fit/Fill toggle, common & scientific names, key identification features, full descriptions, and direct links to Wikipedia/sources.
- **🔄 Recall Mode (3D Flip Flashcards)**: Practice active recall with smooth 3D card flips. Switch between **Photo First** or **Name First**, filter to **Needs Practice Only**, and grade yourself (*Still Learning* vs *Got It!*).
- **🎯 Quiz Mode (Multiple-Choice Game)**: Interactive 4-option multiple-choice quiz with streak counters (`🔥`), instant visual feedback, explanations on answer, and 4 question styles (*Mixed*, *Photo → Common Name*, *Photo → Scientific/Model*, or *Clues → Name*).

## Offline Image Caching & Smart Wikipedia Image Resolver
- Every deck has a **📥 Save Images Offline** button that downloads the actual image blobs and stores them in **IndexedDB** on your device so they work 100% offline.
- **Resilient to AI URL hallucinations**: When you ask an AI to build a JSON deck, you don't even have to worry if the AI omits `imageUrl` or provides a broken image URL—as long as `name` or `sourceUrl` (Wikipedia link) is present, the app automatically queries the official Wikipedia REST API, fetches the lead photo, and saves it locally to IndexedDB!

## Generate Cards In-App With Your Own AI Key
Home menu → **AI connection** lets you plug in your own model. Then tap **New deck → AI**, type a topic, pick 10/20/30 cards and the deck is generated, photo-matched from Wikipedia and saved. From any deck's sheet → **Add, edit or generate cards** you can ask the AI for 5/10/20 *more* cards (with an optional focus); it is told which cards already exist so it doesn't repeat them.

Supported connections:
- **Gemini**: a free key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey). Default model `gemini-2.5-flash`.
- **OpenRouter**: a key from [openrouter.ai/keys](https://openrouter.ai/keys). Default model `openrouter/auto`; any OpenRouter model id works.
- **Custom / local (OpenAI-compatible)**: any server with an OpenAI-style `/chat/completions` endpoint, such as Ollama (`http://localhost:11434/v1`), LM Studio (`http://localhost:1234/v1`), llama.cpp, OpenAI, Groq or Mistral. The key is optional. Local servers must allow the app's origin via CORS (for Ollama, start it with `OLLAMA_ORIGINS=*`).

**List models** fills the model picker from the provider, and **Test** sends a one-word request. Keys are stored only in this browser's `localStorage` and are sent straight to the provider you pick; FieldGuide has no server of its own.

## Write Your Own Cards
- **New deck → Write**: name a deck (plus an optional emoji and folder), then type cards in one after another (**Save & add another**).
- **Add, edit or generate cards** on any deck, including the built-in starter decks, adds, edits or deletes individual cards.
- Each card has a name, subtitle, group tag, key features, notes and a link. For the photo, either pick one from your device (it's resized and stored offline in IndexedDB), paste an image link, or let the app find one on Wikipedia.
- Cards you add to starter decks are kept when the app updates. **Restore built-in starter decks** undoes your edits and deletions to the built-in cards but keeps the cards you added.

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
