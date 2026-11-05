// Deck library: large, ready-made decks (regional species, flags) that are fetched
// on demand instead of being bundled into the app shell. Built by tools/*.py.

const PACKS_BASE = new URL('../data/packs/', import.meta.url);

async function fetchJson(file) {
  const res = await fetch(new URL(file, PACKS_BASE));
  if (!res.ok) throw new Error(`Could not load ${file} (${res.status})`);
  return res.json();
}

export async function loadLibraryCatalog() {
  const index = await fetchJson('index.json');
  return Array.isArray(index.packs) ? index.packs : [];
}

export async function loadLibraryPack(file) {
  const deck = await fetchJson(file);
  if (!deck || !Array.isArray(deck.cards) || !deck.cards.length) {
    throw new Error('That deck is empty.');
  }
  return { ...deck, createdAt: new Date().toISOString(), fromLibrary: true };
}
