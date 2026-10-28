import { STARTER_DECKS } from '../data/starter-decks.js';

const DB_NAME = 'FieldGuideTrainerDB';
const DB_VERSION = 2;

let dbInstance = null;
const memoryObjectUrls = new Map();

export function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('decks')) {
        db.createObjectStore('decks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('progress')) {
        const progressStore = db.createObjectStore('progress', { keyPath: 'cardId' });
        progressStore.createIndex('deckId', 'deckId', { unique: false });
      }
      if (!db.objectStoreNames.contains('images')) {
        const imageStore = db.createObjectStore('images', { keyPath: 'cardId' });
        imageStore.createIndex('deckId', 'deckId', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

// --- DECKS ---

export async function initDecksIfEmpty() {
  const existingDecks = await getAllDecks();
  const existingById = new Map(existingDecks.map((d) => [d.id, d]));

  // Always ensure starter decks have the latest verified image URLs while preserving user folder changes
  for (const starter of STARTER_DECKS) {
    const prev = existingById.get(starter.id);
    if (!prev) {
      await saveDeck(starter);
    } else {
      await saveDeck({
        ...starter,
        category: prev.category || starter.category,
        cards: mergeStarterCards(starter, prev),
        removedCardIds: prev.removedCardIds || []
      });
    }
  }
  return getAllDecks();
}

// Keeps cards the user wrote or edited (and hides ones they deleted) when starter decks refresh.
function mergeStarterCards(starter, prev) {
  const removed = new Set(prev.removedCardIds || []);
  const userCards = (prev.cards || []).filter((c) => c.userAdded);
  const userById = new Map(userCards.map((c) => [c.id, c]));
  const starterIds = new Set(starter.cards.map((c) => c.id));
  return [
    ...starter.cards.filter((c) => !removed.has(c.id)).map((c) => userById.get(c.id) || c),
    ...userCards.filter((c) => !starterIds.has(c.id))
  ];
}

// Restores the built-in cards (undoing edits and deletions) but keeps cards the user added.
export async function resetStarterDecks() {
  const existingById = new Map((await getAllDecks()).map((d) => [d.id, d]));
  for (const deck of STARTER_DECKS) {
    const prev = existingById.get(deck.id);
    const starterIds = new Set(deck.cards.map((c) => c.id));
    const extraCards = (prev?.cards || []).filter((c) => c.userAdded && !starterIds.has(c.id));
    await saveDeck({ ...deck, cards: [...deck.cards, ...extraCards], removedCardIds: [] });
  }
  return getAllDecks();
}

export async function getAllDecks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('decks', 'readonly');
    const store = tx.objectStore('decks');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDeck(deck) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('decks', 'readwrite');
    const store = tx.objectStore('decks');
    const req = store.put(deck);
    req.onsuccess = () => resolve(deck);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteDeck(deckId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['decks', 'progress', 'images'], 'readwrite');
    tx.objectStore('decks').delete(deckId);

    const progStore = tx.objectStore('progress');
    const progIdx = progStore.index('deckId');
    progIdx.openCursor(IDBKeyRange.only(deckId)).onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    const imgStore = tx.objectStore('images');
    const imgIdx = imgStore.index('deckId');
    imgIdx.openCursor(IDBKeyRange.only(deckId)).onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        memoryObjectUrls.delete(cursor.value.cardId);
        cursor.delete();
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- PROGRESS / MASTERY ---

export async function getAllProgress() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('progress', 'readonly');
    const store = tx.objectStore('progress');
    const req = store.getAll();
    req.onsuccess = () => {
      const map = {};
      for (const item of req.result || []) {
        map[item.cardId] = item;
      }
      resolve(map);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function updateCardProgress(cardId, deckId, status) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('progress', 'readwrite');
    const store = tx.objectStore('progress');
    const getReq = store.get(cardId);

    getReq.onsuccess = () => {
      const existing = getReq.result || {
        cardId,
        deckId,
        status: 'new',
        reviews: 0,
        streak: 0
      };
      existing.status = status;
      existing.reviews = (existing.reviews || 0) + 1;
      existing.streak = status === 'mastered' ? (existing.streak || 0) + 1 : 0;
      existing.lastReviewed = new Date().toISOString();

      store.put(existing);
      resolve(existing);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function resetDeckProgress(deckId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('progress', 'readwrite');
    const store = tx.objectStore('progress');
    const idx = store.index('deckId');
    idx.openCursor(IDBKeyRange.only(deckId)).onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- OFFLINE IMAGE CACHING & BATCH WIKIPEDIA RESOLVER ---

export async function getCachedImageRecord(cardId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('images', 'readonly');
    const store = tx.objectStore('images');
    const req = store.get(cardId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function loadCachedDeckObjectUrls(deckId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('images', 'readonly');
    const store = tx.objectStore('images');
    const idx = store.index('deckId');
    const req = idx.getAll(IDBKeyRange.only(deckId));
    req.onsuccess = () => {
      const records = req.result || [];
      for (const rec of records) {
        if (rec.blob && !memoryObjectUrls.has(rec.cardId)) {
          memoryObjectUrls.set(rec.cardId, URL.createObjectURL(rec.blob));
        }
      }
      resolve(records.length);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getDeckCachedImageIds(deckId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('images', 'readonly');
    const store = tx.objectStore('images');
    const idx = store.index('deckId');
    const req = idx.getAllKeys(IDBKeyRange.only(deckId));
    req.onsuccess = () => resolve(new Set(req.result || []));
    req.onerror = () => reject(req.error);
  });
}

export async function saveCachedImage(cardId, deckId, blob, resolvedUrl) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('images', 'readwrite');
    const store = tx.objectStore('images');
    const req = store.put({
      cardId,
      deckId,
      blob,
      resolvedUrl,
      cachedAt: new Date().toISOString()
    });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Stores a photo the user picked from their device as the card's image. */
export async function setLocalCardImage(cardId, deckId, blob) {
  await saveCachedImage(cardId, deckId, blob, 'local');
  const prevUrl = memoryObjectUrls.get(cardId);
  if (prevUrl) URL.revokeObjectURL(prevUrl);
  memoryObjectUrls.set(cardId, URL.createObjectURL(blob));
}

/** Removes a card's saved photo and study progress (used when a card is deleted or its image changes). */
export async function deleteCardData(cardId, { keepProgress = false } = {}) {
  const db = await openDB();
  const stores = keepProgress ? ['images'] : ['images', 'progress'];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    for (const name of stores) tx.objectStore(name).delete(cardId);
    tx.oncomplete = () => {
      const prevUrl = memoryObjectUrls.get(cardId);
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      memoryObjectUrls.delete(cardId);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

function extractWikiTitle(card) {
  if (card.sourceUrl && card.sourceUrl.includes('wikipedia.org/wiki/')) {
    const parts = card.sourceUrl.split('/wiki/');
    if (parts[1]) {
      return decodeURIComponent(parts[1].split('#')[0].split('?')[0]).replace(/_/g, ' ');
    }
  }
  return card.name || card.subtitle || '';
}

/**
 * Batch-resolves Wikipedia thumbnail URLs for an entire deck in ONE single API request
 * so Wikimedia never rate-limits the client!
 */
export async function resolveDeckWikipediaImages(deck) {
  const cardsToResolve = (deck.cards || []).filter((c) => !c.imageUrl && !c.noAutoImage);
  if (cardsToResolve.length === 0) return deck;

  const titleToCards = new Map();
  for (const card of cardsToResolve) {
    const title = extractWikiTitle(card);
    if (title) {
      if (!titleToCards.has(title)) titleToCards.set(title, []);
      titleToCards.get(title).push(card);
    }
  }

  const allTitles = Array.from(titleToCards.keys());
  if (allTitles.length === 0) return deck;

  try {
    const joined = allTitles.slice(0, 50).map(encodeURIComponent).join('|');
    const apiUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=pageimages&piprop=thumbnail&pithumbsize=960&redirects=1&format=json&origin=*&titles=${joined}`;
    const res = await fetch(apiUrl);
    if (res.ok) {
      const data = await res.json();
      const pages = data.query?.pages || {};
      const redirects = data.query?.redirects || [];
      const normalized = data.query?.normalized || [];

      const mapTitle = (fromTitle) => {
        let cur = fromTitle;
        const norm = normalized.find((n) => n.from === cur);
        if (norm) cur = norm.to;
        const redir = redirects.find((r) => r.from === cur);
        if (redir) cur = redir.to;
        return cur.toLowerCase();
      };

      const thumbByResolvedTitle = new Map();
      for (const page of Object.values(pages)) {
        if (page.title && page.thumbnail?.source) {
          thumbByResolvedTitle.set(page.title.toLowerCase(), page.thumbnail.source);
        }
      }

      let updated = false;
      for (const [origTitle, cards] of titleToCards.entries()) {
        const targetKey = mapTitle(origTitle);
        const foundUrl = thumbByResolvedTitle.get(targetKey) || thumbByResolvedTitle.get(origTitle.toLowerCase());
        if (foundUrl) {
          for (const c of cards) {
            c.imageUrl = foundUrl;
            updated = true;
          }
        }
      }
      if (updated) {
        await saveDeck(deck);
      }
    }
  } catch (_) {}

  return deck;
}

/**
 * Fallback single-card Wikipedia image lookup if an <img> fails to load
 */
export async function resolveSingleCardWikiImage(card, deck) {
  if (card.noAutoImage) return null;
  const title = extractWikiTitle(card) || card.name || card.subtitle;
  if (!title) return null;
  try {
    const apiUrl = `https://en.wikipedia.org/w/api.php?action=query&prop=pageimages&piprop=thumbnail&pithumbsize=960&redirects=1&format=json&origin=*&titles=${encodeURIComponent(title)}`;
    const res = await fetch(apiUrl);
    if (res.ok) {
      const data = await res.json();
      const pages = Object.values(data.query?.pages || {});
      if (pages[0]?.thumbnail?.source) {
        card.imageUrl = pages[0].thumbnail.source;
        if (deck) await saveDeck(deck);
        return card.imageUrl;
      }
    }
  } catch (_) {}
  return null;
}

// `mystery` hides the name so a photo-less card doesn't give away a quiz or recall answer.
export function createFallbackSvgDataUrl(card, deckColor = '#6366f1', { mystery = false } = {}) {
  const title = mystery ? '?' : (card.name || 'Card').replace(/[<>&"']/g, '');
  const sub = mystery ? 'No photo for this card' : (card.subtitle || '').replace(/[<>&"']/g, '');
  const badge = mystery ? '' : (card.badge || '').replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520" viewBox="0 0 800 520">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${deckColor}" stop-opacity="0.85"/>
        <stop offset="100%" stop-color="#0f172a" stop-opacity="0.95"/>
      </linearGradient>
    </defs>
    <rect width="800" height="520" fill="url(#g)"/>
    <circle cx="680" cy="110" r="180" fill="#ffffff" fill-opacity="0.06"/>
    <circle cx="120" cy="440" r="220" fill="#ffffff" fill-opacity="0.05"/>
    <text x="400" y="230" text-anchor="middle" fill="#ffffff" font-family="system-ui, sans-serif" font-size="38" font-weight="700">${title}</text>
    <text x="400" y="280" text-anchor="middle" fill="#cbd5e1" font-family="system-ui, sans-serif" font-size="24" font-style="italic">${sub}</text>
    <text x="400" y="340" text-anchor="middle" fill="#94a3b8" font-family="system-ui, sans-serif" font-size="18">${badge ? `[ ${badge} ]` : ''}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function getBestCardImageSrc(card, deckColor = '#6366f1', options = {}) {
  if (memoryObjectUrls.has(card.id)) {
    return memoryObjectUrls.get(card.id);
  }
  if (card.imageUrl) {
    return card.imageUrl;
  }
  return createFallbackSvgDataUrl(card, deckColor, options);
}

/**
 * Explicitly downloads and caches all images for a deck into IndexedDB when the user taps "Download Offline".
 */
export async function cacheDeckImagesToIndexedDB(deck, onProgress) {
  await resolveDeckWikipediaImages(deck);
  let count = 0;
  const total = deck.cards.length;

  for (const card of deck.cards) {
    if (memoryObjectUrls.has(card.id)) {
      count++;
      if (onProgress) onProgress(count, total);
      continue;
    }

    const existing = await getCachedImageRecord(card.id);
    if (existing && existing.blob) {
      memoryObjectUrls.set(card.id, URL.createObjectURL(existing.blob));
      count++;
      if (onProgress) onProgress(count, total);
      continue;
    }

    let url = card.imageUrl;
    if (!url) {
      url = await resolveSingleCardWikiImage(card, deck);
    }

    if (url) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const blob = await res.blob();
          if (blob.size > 0 && blob.type.startsWith('image/')) {
            await saveCachedImage(card.id, deck.id, blob, url);
            memoryObjectUrls.set(card.id, URL.createObjectURL(blob));
          }
        }
      } catch (_) {}
      // Polite 250ms delay between downloads so Wikimedia CDN does not rate-limit
      await new Promise((r) => setTimeout(r, 250));
    }

    count++;
    if (onProgress) onProgress(count, total);
  }
}
