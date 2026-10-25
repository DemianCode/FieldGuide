import {
  initDecksIfEmpty,
  saveDeck,
  deleteDeck,
  resetStarterDecks,
  getAllProgress,
  updateCardProgress,
  resetDeckProgress,
  getDeckCachedImageIds,
  loadCachedDeckObjectUrls,
  resolveDeckWikipediaImages,
  resolveSingleCardWikiImage,
  getBestCardImageSrc,
  createFallbackSvgDataUrl,
  cacheDeckImagesToIndexedDB
} from './db.js';
import { AI_DECK_PROMPT_TEMPLATE } from '../data/starter-decks.js';

const state = {
  view: 'home', // 'home' | 'study'
  decks: [],
  progressMap: {},
  cachedCountByDeck: {},
  downloadingDeckId: null,
  downloadProgressText: '',

  // Active study session
  activeDeckId: null,
  studyMode: 'browse', // 'browse' | 'recall' | 'quiz'
  imageFitContain: true,

  // Browse (Read) state
  browseFilter: 'all', // 'all' | 'new' | 'learning' | 'mastered'
  browseIndex: 0,

  // Recall state
  recallFilter: 'all', // 'all' | 'unmastered'
  recallPromptType: 'image-first', // 'image-first' | 'name-first'
  recallQueue: [],
  recallIndex: 0,
  recallFlipped: false,
  recallShowHint: false,
  recallStats: { gotIt: 0, learning: 0 },
  recallFinished: false,

  // Quiz state
  quizQuestionType: 'mixed', // 'mixed' | 'photo-to-name' | 'photo-to-sub' | 'clues-to-name'
  quizQuestions: [],
  quizIndex: 0,
  quizSelectedOptionId: null,
  quizScore: 0,
  quizStreak: 0,
  quizBestStreak: 0,
  quizMissedCards: [],
  quizFinished: false,
  quizViewingLast: false,

  // Home folder & filtering state
  homeFolderFilter: 'all', // 'all' or folder name
  homeSearchQuery: '',
  homeGroupByFolder: true,
  collapsedFolders: {},
  customFolders: [],
  importFolderInput: '',
  newFolderInput: '',
  renamingFolder: null,
  renameFolderInput: '',

  // Menus / Bottom Sheets
  activeSheet: null, // null | 'study-options' | 'deck-context' | 'add-deck' | 'home-menu' | 'manage-folders'
  contextDeckId: null,
  addDeckTab: 'paste', // 'paste' | 'prompt'
  confirmAction: null, // null | 'reset-progress' | 'delete-deck' | 'restore-starters'
  importTopicInput: '',
  importRawText: '',
  importAutoDownload: true,
  lightboxUrl: null,
  lightboxCaption: ''
};

const appRoot = document.getElementById('app');
let touchStartX = null;
let touchStartY = null;
let quizAutoAdvanceTimer = null;
const cardOrientationMap = new Map();
const CUSTOM_FOLDERS_KEY = 'fieldguide_custom_folders_v1';

function loadSavedFolders() {
  try {
    const raw = localStorage.getItem(CUSTOM_FOLDERS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        state.customFolders = parsed.map((f) => String(f || '').trim()).filter(Boolean);
      }
    }
  } catch (_) {}
}

function saveCustomFolders() {
  try {
    localStorage.setItem(CUSTOM_FOLDERS_KEY, JSON.stringify(state.customFolders));
  } catch (_) {}
}

function getDeckFolder(deck) {
  return String(deck?.category || 'General').trim() || 'General';
}

function getFolderStatsList() {
  const countsMap = new Map();
  for (const deck of state.decks) {
    const folder = getDeckFolder(deck);
    countsMap.set(folder, (countsMap.get(folder) || 0) + 1);
  }
  for (const custom of state.customFolders) {
    const clean = String(custom || '').trim();
    if (clean && !countsMap.has(clean)) {
      countsMap.set(clean, 0);
    }
  }
  return Array.from(countsMap.entries()).map(([name, count]) => ({ name, count }));
}

function getFilteredHomeDecks() {
  const q = state.homeSearchQuery.trim().toLowerCase();
  return state.decks.filter((deck) => {
    const folder = getDeckFolder(deck);
    if (state.homeFolderFilter !== 'all' && folder !== state.homeFolderFilter) {
      return false;
    }
    if (!q) return true;
    if (
      (deck.title || '').toLowerCase().includes(q) ||
      folder.toLowerCase().includes(q) ||
      (deck.description || '').toLowerCase().includes(q)
    ) {
      return true;
    }
    return (deck.cards || []).some(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.subtitle || '').toLowerCase().includes(q) ||
        (c.badge || '').toLowerCase().includes(q)
    );
  });
}

async function assignDeckToFolder(deckId, folderName) {
  const cleanFolder = String(folderName || '').trim() || 'General';
  const deck = getDeckById(deckId);
  if (!deck) return;
  deck.category = cleanFolder;
  await saveDeck(deck);
  if (!state.customFolders.includes(cleanFolder)) {
    state.customFolders.push(cleanFolder);
    saveCustomFolders();
  }
  showToast(`Moved "${deck.title}" to 📁 ${cleanFolder}`);
  render();
}

async function createNewFolder(rawName, deckIdToMove = null) {
  const clean = String(rawName || '').trim();
  if (!clean) {
    showToast('Enter a folder name first.');
    return;
  }
  if (!state.customFolders.includes(clean)) {
    state.customFolders.push(clean);
    saveCustomFolders();
  }
  state.newFolderInput = '';
  if (deckIdToMove) {
    await assignDeckToFolder(deckIdToMove, clean);
  } else {
    showToast(`Created folder "📁 ${clean}"`);
    render();
  }
}

async function renameExistingFolder(oldName, newName) {
  const cleanNew = String(newName || '').trim();
  if (!cleanNew || cleanNew === oldName) {
    state.renamingFolder = null;
    render();
    return;
  }
  for (const deck of state.decks) {
    if (getDeckFolder(deck) === oldName) {
      deck.category = cleanNew;
      await saveDeck(deck);
    }
  }
  state.customFolders = state.customFolders.map((f) => (f === oldName ? cleanNew : f));
  if (!state.customFolders.includes(cleanNew)) state.customFolders.push(cleanNew);
  saveCustomFolders();
  if (state.homeFolderFilter === oldName) state.homeFolderFilter = cleanNew;
  state.renamingFolder = null;
  state.renameFolderInput = '';
  showToast(`Renamed folder to "📁 ${cleanNew}"`);
  render();
}

async function removeFolder(folderName) {
  for (const deck of state.decks) {
    if (getDeckFolder(deck) === folderName) {
      deck.category = 'General';
      await saveDeck(deck);
    }
  }
  state.customFolders = state.customFolders.filter((f) => f !== folderName);
  saveCustomFolders();
  if (state.homeFolderFilter === folderName) state.homeFolderFilter = 'all';
  showToast(`Removed folder "${folderName}"`);
  render();
}

function clearQuizAdvanceTimer() {
  if (quizAutoAdvanceTimer) {
    clearTimeout(quizAutoAdvanceTimer);
    quizAutoAdvanceTimer = null;
  }
}

function getLastAnsweredQuizIndex() {
  if (!state.quizQuestions.length) return -1;
  if (state.quizFinished) {
    const lastIdx = state.quizQuestions.length - 1;
    return state.quizQuestions[lastIdx]?.selectedOptionId ? lastIdx : -1;
  }
  if (state.quizIndex > 0) {
    const prevIdx = state.quizIndex - 1;
    return state.quizQuestions[prevIdx]?.selectedOptionId ? prevIdx : -1;
  }
  return -1;
}

function getMediaFrameClass(cardId, extraClass = '') {
  const orient = cardOrientationMap.get(cardId);
  const orientClass = orient === 'portrait' ? 'is-portrait' : orient === 'wide' ? 'is-wide' : '';
  return ['media-frame', extraClass, orientClass].filter(Boolean).join(' ');
}

// --- INITIALIZATION ---
async function initApp() {
  loadSavedFolders();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  await refreshData();
  render();
  window.addEventListener('keydown', handleGlobalKeydown);
}

async function refreshData() {
  state.decks = await initDecksIfEmpty();
  state.progressMap = await getAllProgress();
  for (const deck of state.decks) {
    await loadCachedDeckObjectUrls(deck.id);
    const cachedSet = await getDeckCachedImageIds(deck.id);
    state.cachedCountByDeck[deck.id] = cachedSet.size;
  }
}

function getCardStatus(cardId) {
  return state.progressMap[cardId]?.status || 'new';
}

function getActiveDeck() {
  return state.decks.find((d) => d.id === state.activeDeckId) || null;
}

function getDeckById(deckId) {
  return state.decks.find((d) => d.id === deckId) || null;
}

function getDeckCounts(deck) {
  const counts = { all: deck?.cards?.length || 0, new: 0, learning: 0, mastered: 0 };
  for (const c of deck?.cards || []) {
    const st = getCardStatus(c.id);
    counts[st] = (counts[st] || 0) + 1;
  }
  return counts;
}

// --- TOAST NOTIFICATIONS ---
function showToast(message) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

// --- KEYBOARD SHORTCUTS ---
function handleGlobalKeydown(e) {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;

  if (state.activeSheet || state.lightboxUrl) {
    if (e.key === 'Escape') {
      state.activeSheet = null;
      state.confirmAction = null;
      state.lightboxUrl = null;
      render();
    }
    return;
  }
  if (state.view !== 'study') return;

  if (state.studyMode === 'browse') {
    if (e.key === 'ArrowRight') changeBrowseCard(1);
    if (e.key === 'ArrowLeft') changeBrowseCard(-1);
  } else if (state.studyMode === 'recall' && !state.recallFinished) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      state.recallFlipped = !state.recallFlipped;
      render();
    } else if (state.recallFlipped && (e.key === '1' || e.key === 'ArrowLeft')) {
      gradeRecallCard('learning');
    } else if (state.recallFlipped && (e.key === '2' || e.key === 'ArrowRight')) {
      gradeRecallCard('mastered');
    }
  } else if (state.studyMode === 'quiz') {
    if (state.quizViewingLast) {
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight' || e.key === 'Escape') {
        e.preventDefault();
        state.quizViewingLast = false;
        render();
      }
      return;
    }
    if (e.key === 'ArrowLeft' && getLastAnsweredQuizIndex() >= 0) {
      e.preventDefault();
      clearQuizAdvanceTimer();
      state.quizViewingLast = true;
      render();
      return;
    }
    if (!state.quizFinished) {
      const currentQ = state.quizQuestions[state.quizIndex];
      if (!currentQ) return;
      if (state.quizSelectedOptionId === null) {
        const keyMap = { '1': 0, '2': 1, '3': 2, '4': 3, a: 0, b: 1, c: 2, d: 3 };
        const idx = keyMap[e.key.toLowerCase()];
        if (idx !== undefined && currentQ.options[idx]) {
          selectQuizOption(currentQ.options[idx].id);
        }
      }
    }
  }
}

// --- DECK & STUDY ACTIONS ---
async function openDeck(deckId, mode = 'browse') {
  state.activeDeckId = deckId;
  state.view = 'study';
  state.activeSheet = null;
  state.confirmAction = null;
  const deck = getActiveDeck();
  if (deck) {
    resolveDeckWikipediaImages(deck).then(() => {
      if (state.activeDeckId === deckId) render();
    });
  }
  switchStudyMode(mode);
}

function switchStudyMode(mode) {
  clearQuizAdvanceTimer();
  state.studyMode = mode;
  state.activeSheet = null;
  state.confirmAction = null;
  if (mode === 'browse') {
    state.browseIndex = 0;
  } else if (mode === 'recall') {
    setupRecallSession();
  } else if (mode === 'quiz') {
    setupQuizSession();
  }
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

async function downloadDeckOffline(deckId) {
  const deck = getDeckById(deckId);
  if (!deck || state.downloadingDeckId) return;

  state.downloadingDeckId = deckId;
  state.downloadProgressText = `0/${deck.cards.length}`;
  render();

  await cacheDeckImagesToIndexedDB(deck, (done, total) => {
    state.downloadProgressText = `${done}/${total}`;
    render();
  });

  const cachedSet = await getDeckCachedImageIds(deck.id);
  state.cachedCountByDeck[deck.id] = cachedSet.size;
  state.downloadingDeckId = null;
  state.downloadProgressText = '';
  showToast(`Saved ${cachedSet.size}/${deck.cards.length} photos for offline study!`);
  render();
}

// --- BROWSE (READ) MODE ---
function getFilteredBrowseCards() {
  const deck = getActiveDeck();
  if (!deck) return [];
  if (state.browseFilter === 'all') return deck.cards;
  return deck.cards.filter((c) => getCardStatus(c.id) === state.browseFilter);
}

function changeBrowseCard(delta) {
  const cards = getFilteredBrowseCards();
  if (!cards.length) return;
  state.browseIndex = (state.browseIndex + delta + cards.length) % cards.length;
  render();
}

async function cycleBrowseCardStatus(cardId) {
  const deck = getActiveDeck();
  if (!deck) return;
  const current = getCardStatus(cardId);
  const nextOrder = { new: 'learning', learning: 'mastered', mastered: 'new' };
  const nextStatus = nextOrder[current] || 'mastered';
  const updated = await updateCardProgress(cardId, deck.id, nextStatus);
  state.progressMap[cardId] = updated;
  const labels = { new: 'Marked as New', learning: 'Marked as Still Learning', mastered: 'Marked as Mastered ✓' };
  showToast(labels[nextStatus]);
  render();
}

// --- RECALL MODE ---
function setupRecallSession(shuffle = false) {
  const deck = getActiveDeck();
  if (!deck) return;
  let pool = [...deck.cards];
  if (state.recallFilter === 'unmastered') {
    pool = pool.filter((c) => getCardStatus(c.id) !== 'mastered');
    if (pool.length === 0) {
      pool = [...deck.cards];
      state.recallFilter = 'all';
      showToast('All cards mastered! Studying full deck.');
    }
  }
  if (shuffle) pool.sort(() => Math.random() - 0.5);

  state.recallQueue = pool;
  state.recallIndex = 0;
  state.recallFlipped = false;
  state.recallShowHint = false;
  state.recallStats = { gotIt: 0, learning: 0 };
  state.recallFinished = false;
}

async function gradeRecallCard(status) {
  const deck = getActiveDeck();
  const card = state.recallQueue[state.recallIndex];
  if (!deck || !card) return;

  const updated = await updateCardProgress(card.id, deck.id, status);
  state.progressMap[card.id] = updated;

  if (status === 'mastered') state.recallStats.gotIt++;
  else state.recallStats.learning++;

  if (state.recallIndex + 1 < state.recallQueue.length) {
    state.recallIndex++;
    state.recallFlipped = false;
    state.recallShowHint = false;
  } else {
    state.recallFinished = true;
  }
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// --- QUIZ MODE ---
function setupQuizSession(customPool = null) {
  clearQuizAdvanceTimer();
  const deck = getActiveDeck();
  if (!deck) return;
  const sourceCards = customPool && customPool.length > 0 ? [...customPool] : [...deck.cards];
  sourceCards.sort(() => Math.random() - 0.5);

  state.quizQuestions = sourceCards.map((targetCard) => {
    const others = deck.cards.filter((c) => c.id !== targetCard.id).sort(() => Math.random() - 0.5);
    const options = [targetCard, ...others.slice(0, 3)].sort(() => Math.random() - 0.5);

    let qType = state.quizQuestionType;
    if (qType === 'mixed') {
      const types = ['photo-to-name', 'photo-to-sub', 'clues-to-name'];
      qType = types[Math.floor(Math.random() * types.length)];
    }
    return { targetCard, options, qType, selectedOptionId: null, isCorrect: null };
  });

  state.quizIndex = 0;
  state.quizSelectedOptionId = null;
  state.quizScore = 0;
  state.quizStreak = 0;
  state.quizBestStreak = 0;
  state.quizMissedCards = [];
  state.quizFinished = false;
  state.quizViewingLast = false;
}

async function selectQuizOption(optionId) {
  if (state.quizViewingLast || state.quizSelectedOptionId !== null) return;
  const deck = getActiveDeck();
  const currentQ = state.quizQuestions[state.quizIndex];
  if (!deck || !currentQ) return;

  state.quizSelectedOptionId = optionId;
  const isCorrect = optionId === currentQ.targetCard.id;
  currentQ.selectedOptionId = optionId;
  currentQ.isCorrect = isCorrect;

  if (isCorrect) {
    state.quizScore++;
    state.quizStreak++;
    if (state.quizStreak > state.quizBestStreak) state.quizBestStreak = state.quizStreak;
    state.progressMap[currentQ.targetCard.id] = await updateCardProgress(currentQ.targetCard.id, deck.id, 'mastered');
  } else {
    state.quizStreak = 0;
    state.quizMissedCards.push(currentQ.targetCard);
    state.progressMap[currentQ.targetCard.id] = await updateCardProgress(currentQ.targetCard.id, deck.id, 'learning');
  }
  render();

  clearQuizAdvanceTimer();
  quizAutoAdvanceTimer = setTimeout(() => {
    nextQuizQuestion();
  }, isCorrect ? 650 : 950);
}

function nextQuizQuestion() {
  clearQuizAdvanceTimer();
  state.quizViewingLast = false;
  if (state.quizIndex + 1 < state.quizQuestions.length) {
    state.quizIndex++;
    state.quizSelectedOptionId = null;
  } else {
    state.quizFinished = true;
  }
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// --- SMART TEXT & JSON DECK PARSER ---
function parsePlainTextDeck(text) {
  const deckMeta = {
    title: 'Custom AI Deck',
    category: 'Custom Collection',
    icon: '📚',
    color: '#6366f1',
    description: ''
  };

  const cards = [];
  const deckId = `deck-custom-${Date.now()}`;

  const blocks = text
    .split(/\n\s*---+\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const fields = {};

    for (const line of lines) {
      const match = line.match(/^([A-Za-z_ ]+?)\s*:\s*(.+)$/);
      if (match) {
        const key = match[1].trim().toUpperCase();
        const val = match[2].trim();
        fields[key] = val;
      } else if (line.includes('|')) {
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length >= 2 && parts[0].toLowerCase() !== 'name') {
          const name = parts[0];
          cards.push({
            id: `${deckId}-card-${cards.length + 1}`,
            name,
            subtitle: parts[1] || '',
            badge: parts[2] || '',
            keyFeatures: parts[3] || '',
            description: parts[4] || '',
            sourceUrl:
              parts[5] ||
              `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}`,
            imageUrl: parts[6] || ''
          });
        }
      }
    }

    if (fields.TITLE || fields.DECK) deckMeta.title = fields.TITLE || fields.DECK;
    if (fields.CATEGORY || fields.FOLDER) deckMeta.category = fields.CATEGORY || fields.FOLDER;
    if (fields.ICON || fields.EMOJI) deckMeta.icon = fields.ICON || fields.EMOJI;
    if (fields.COLOR) deckMeta.color = fields.COLOR;
    if (fields.DESCRIPTION) deckMeta.description = fields.DESCRIPTION;

    const cardName = fields.NAME || fields.COMMON_NAME || fields.ITEM;
    if (cardName) {
      const rawImg = fields.IMAGE || fields.IMAGE_URL || fields.PHOTO || '';
      const cleanImg = rawImg.startsWith('http') ? rawImg : '';
      const rawLink = fields.LINK || fields.WIKIPEDIA || fields.URL || fields.SOURCE || '';
      const cleanLink = rawLink.startsWith('http')
        ? rawLink
        : `https://en.wikipedia.org/wiki/${encodeURIComponent(cardName.replace(/ /g, '_'))}`;

      cards.push({
        id: `${deckId}-card-${cards.length + 1}-${Math.random().toString(36).slice(2, 5)}`,
        name: cardName,
        subtitle: fields.SUBTITLE || fields.SCIENTIFIC_NAME || fields.LATIN_NAME || fields.MODEL || '',
        badge: fields.BADGE || fields.GROUP || fields.FAMILY || fields.TAG || '',
        keyFeatures: fields.FEATURES || fields.KEY_FEATURES || fields.TRAITS || fields.TIPS || '',
        description: fields.ABOUT || fields.DESCRIPTION || fields.NOTES || fields.INFO || '',
        sourceUrl: cleanLink,
        imageUrl: cleanImg
      });
    }
  }

  if (!deckMeta.description) {
    deckMeta.description = `Custom deck with ${cards.length} cards.`;
  }

  return [
    {
      id: deckId,
      ...deckMeta,
      createdAt: new Date().toISOString(),
      cards
    }
  ];
}

function normalizeJsonDecks(parsed) {
  const deckArray = Array.isArray(parsed)
    ? parsed[0] && parsed[0].cards
      ? parsed
      : [{ title: 'Imported Deck', cards: parsed }]
    : [parsed];

  return deckArray.map((d, dIdx) => {
    const deckId = d.id || `deck-custom-${Date.now()}-${dIdx}`;
    const cards = (d.cards || d.items || []).map((c, cIdx) => ({
      id: c.id || `${deckId}-card-${cIdx}-${Math.random().toString(36).slice(2, 6)}`,
      name: c.name || c.title || c.commonName || `Item ${cIdx + 1}`,
      subtitle: c.subtitle || c.scientificName || c.latinName || c.model || '',
      badge: c.badge || c.family || c.category || c.tag || '',
      imageUrl: c.imageUrl || c.image || c.photo || '',
      description: c.description || c.about || c.notes || c.info || '',
      keyFeatures: c.keyFeatures || c.features || c.tips || c.identification || '',
      sourceUrl:
        c.sourceUrl ||
        c.url ||
        c.link ||
        c.wikipedia ||
        `https://en.wikipedia.org/wiki/${encodeURIComponent((c.name || c.title || '').replace(/ /g, '_'))}`
    }));

    return {
      id: deckId,
      title: d.title || d.name || 'Custom Deck',
      category: d.category || d.folder || 'Custom Collection',
      icon: d.icon || '📚',
      color: d.color || '#6366f1',
      description: d.description || `${cards.length} cards`,
      createdAt: new Date().toISOString(),
      cards
    };
  });
}

function parseAnyDeckInput(rawInput) {
  let cleaned = rawInput.trim();
  const codeBlockMatch = cleaned.match(/```(?:json|text|markdown)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch && codeBlockMatch[1]) {
    cleaned = codeBlockMatch[1].trim();
  }

  if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
    try {
      const parsed = JSON.parse(cleaned);
      return normalizeJsonDecks(parsed);
    } catch (_) {}
  }

  return parsePlainTextDeck(cleaned);
}

async function handleImportDeckSubmit() {
  const raw = state.importRawText.trim();
  if (!raw) {
    showToast('Paste the AI output or JSON into the text box first.');
    return;
  }
  try {
    const decks = parseAnyDeckInput(raw);
    if (!decks.length || !decks[0].cards.length) {
      showToast('No cards found. Make sure each card has NAME: ...');
      return;
    }

    const customFolder = state.importFolderInput.trim();
    if (customFolder) {
      for (const deck of decks) {
        deck.category = customFolder;
      }
      if (!state.customFolders.includes(customFolder)) {
        state.customFolders.push(customFolder);
        saveCustomFolders();
      }
    }

    showToast('Fetching photos from Wikipedia...');
    for (const deck of decks) {
      await resolveDeckWikipediaImages(deck);
      await saveDeck(deck);
    }

    await refreshData();
    state.activeSheet = null;
    state.importRawText = '';
    state.importFolderInput = '';
    showToast(`Added "${decks[0].title}" (${decks[0].cards.length} cards)!`);
    render();

    if (state.importAutoDownload && decks[0]) {
      downloadDeckOffline(decks[0].id);
    }
  } catch (err) {
    showToast(`Error parsing text: ${err.message}`);
  }
}

function exportDeckToJson(deckId) {
  const deck = getDeckById(deckId);
  if (!deck) return;
  const blob = new Blob([JSON.stringify(deck, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${deck.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${deck.title}.json`);
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- RENDER ROOT ---
function render() {
  const activeEl = document.activeElement;
  const focusedId = activeEl?.id || null;
  const selStart = typeof activeEl?.selectionStart === 'number' ? activeEl.selectionStart : null;
  const selEnd = typeof activeEl?.selectionEnd === 'number' ? activeEl.selectionEnd : null;

  appRoot.innerHTML = `
    <div class="mobile-shell">
      ${renderTopBar()}
      <main class="screen-body ${state.view === 'study' ? 'study-layout' : ''}" id="swipe-area">
        ${state.view === 'home' ? renderHomeView() : renderStudyView()}
      </main>
      ${state.view === 'study' ? renderStudyDock() : ''}
      ${state.activeSheet ? renderBottomSheet() : ''}
      ${state.lightboxUrl ? renderLightbox() : ''}
    </div>
  `;
  attachEvents();

  if (focusedId) {
    const nextEl = document.getElementById(focusedId);
    if (nextEl) {
      nextEl.focus();
      if (selStart !== null && typeof nextEl.setSelectionRange === 'function') {
        try {
          nextEl.setSelectionRange(selStart, selEnd);
        } catch (_) {}
      }
    }
  }
}

// --- STICKY TOP BAR (HOME HEADER OR INTEGRATED FOCUSED STUDY HEADER) ---
function renderTopBar() {
  if (state.view === 'home') {
    return `
      <header class="topbar">
        <div class="topbar-main">
          <div class="brand-mark">
            <img src="./icons/icon.svg" alt="" class="brand-logo" />
            <div class="topbar-title-group">
              <span class="topbar-title">FieldGuide</span>
              <span class="topbar-subtitle">Visual Recall &amp; Quiz</span>
            </div>
          </div>
          <div class="topbar-right">
            <button class="header-pill-btn" data-action="open-add-deck" data-tab="paste">
              <span>＋</span>
              <span>New Deck</span>
            </button>
            <button class="icon-btn" data-action="open-sheet" data-sheet="home-menu" aria-label="Menu">⋯</button>
          </div>
        </div>
      </header>
    `;
  }

  const deck = getActiveDeck();
  let subInfo = '';
  let progressPct = 0;
  let hasActiveFilter = false;

  if (state.studyMode === 'browse') {
    const cards = getFilteredBrowseCards();
    const total = cards.length;
    const cur = total ? Math.min(state.browseIndex + 1, total) : 0;
    subInfo = total ? `Card ${cur} of ${total}` : 'No matching cards';
    progressPct = total ? Math.round((cur / total) * 100) : 0;
    hasActiveFilter = state.browseFilter !== 'all';
  } else if (state.studyMode === 'recall') {
    const total = state.recallQueue.length || 1;
    const cur = state.recallFinished ? total : state.recallIndex + 1;
    subInfo = state.recallFinished
      ? 'Session Complete'
      : `Card ${cur} of ${total} • ${state.recallPromptType === 'image-first' ? 'Photo → Name' : 'Name → Photo'}`;
    progressPct = state.recallFinished ? 100 : Math.round((cur / total) * 100);
    hasActiveFilter = state.recallFilter !== 'all' || state.recallPromptType !== 'image-first';
  } else if (state.studyMode === 'quiz') {
    const total = state.quizQuestions.length || 1;
    const cur = state.quizFinished ? total : state.quizIndex + 1;
    subInfo = state.quizFinished
      ? `Final Score: ${state.quizScore}/${total}`
      : `Question ${cur} of ${total}${state.quizStreak > 0 ? ` • 🔥 ${state.quizStreak}` : ''}`;
    progressPct = state.quizFinished ? 100 : Math.round((cur / total) * 100);
    hasActiveFilter = state.quizQuestionType !== 'mixed';
  }

  return `
    <header class="topbar">
      <div class="topbar-main">
        <div class="topbar-left">
          <button class="icon-btn" data-action="go-home" aria-label="Back to Decks">←</button>
          <div class="topbar-title-group">
            <div class="topbar-title">${esc(deck?.title || 'Study')}</div>
            <div class="topbar-subtitle">${esc(subInfo)}</div>
          </div>
        </div>
        <div class="topbar-right">
          <button
            class="icon-btn ${hasActiveFilter ? 'has-badge' : ''}"
            data-action="open-sheet"
            data-sheet="study-options"
            aria-label="Study Options"
            title="Study Options"
          >
            ⚙️
          </button>
        </div>
      </div>

      <div class="study-subbar">
        <div class="mode-segmented" role="tablist" aria-label="Study Mode">
          <button
            class="mode-seg-btn ${state.studyMode === 'browse' ? 'active' : ''}"
            data-action="switch-mode"
            data-mode="browse"
          >
            <span>📖</span>
            <span>Read</span>
          </button>
          <button
            class="mode-seg-btn ${state.studyMode === 'recall' ? 'active' : ''}"
            data-action="switch-mode"
            data-mode="recall"
          >
            <span>🔄</span>
            <span>Recall</span>
          </button>
          <button
            class="mode-seg-btn ${state.studyMode === 'quiz' ? 'active' : ''}"
            data-action="switch-mode"
            data-mode="quiz"
          >
            <span>🎯</span>
            <span>Quiz</span>
          </button>
        </div>
      </div>

      <div class="session-progress-track">
        <div class="session-progress-fill" style="width:${progressPct}%"></div>
      </div>
    </header>
  `;
}

// --- HOME VIEW ---
function renderDeckCard(deck) {
  const counts = getDeckCounts(deck);
  const total = counts.all || 1;
  const mPct = Math.round((counts.mastered / total) * 100);
  const lPct = Math.round((counts.learning / total) * 100);
  const cachedCount = state.cachedCountByDeck[deck.id] || 0;
  const isFullyCached = cachedCount >= deck.cards.length && deck.cards.length > 0;
  const folderName = getDeckFolder(deck);

  return `
    <article class="deck-card" style="--deck-color:${esc(deck.color)}">
      <div class="deck-card-main" data-action="open-deck" data-deck="${esc(deck.id)}" data-mode="browse">
        <div class="deck-avatar">${esc(deck.icon || '🃏')}</div>
        <div class="deck-info">
          <div class="deck-title-row">
            <div class="deck-name">${esc(deck.title)}</div>
            <button
              class="deck-more-btn"
              data-action="open-deck-context"
              data-deck="${esc(deck.id)}"
              aria-label="Deck Menu"
              title="Deck Options &amp; Folder"
            >
              ⋯
            </button>
          </div>
          <div class="deck-meta">
            <span
              class="deck-folder-pill"
              data-action="set-home-folder"
              data-folder="${esc(folderName)}"
              title="Filter by folder: ${esc(folderName)}"
            >
              📁 ${esc(folderName)}
            </span>
            <span>${deck.cards.length} cards</span>
            <span>•</span>
            <span style="color:${counts.mastered > 0 ? '#34d399' : 'var(--text-muted)'};">
              ${counts.mastered} mastered
            </span>
            ${isFullyCached ? `<span class="offline-pill">✓ Offline</span>` : ''}
          </div>
          <div class="mini-progress-track">
            <div class="mini-progress-fill" style="width:${mPct}%"></div>
            <div class="mini-progress-learning" style="width:${lPct}%"></div>
          </div>
        </div>
      </div>

      <div class="deck-quick-modes">
        <button class="deck-mode-btn" data-action="open-deck" data-deck="${esc(deck.id)}" data-mode="browse">
          <span>📖</span>
          <span>Read</span>
        </button>
        <button class="deck-mode-btn" data-action="open-deck" data-deck="${esc(deck.id)}" data-mode="recall">
          <span>🔄</span>
          <span>Recall</span>
        </button>
        <button class="deck-mode-btn" data-action="open-deck" data-deck="${esc(deck.id)}" data-mode="quiz">
          <span>🎯</span>
          <span>Quiz</span>
        </button>
      </div>
    </article>
  `;
}

function renderHomeView() {
  const folderStats = getFolderStatsList();
  const filteredDecks = getFilteredHomeDecks();
  const overviewSourceDecks =
    state.homeFolderFilter === 'all'
      ? state.decks
      : state.decks.filter((d) => getDeckFolder(d) === state.homeFolderFilter);

  let totalCards = 0;
  let masteredCount = 0;
  let learningCount = 0;

  for (const deck of overviewSourceDecks) {
    for (const c of deck.cards || []) {
      totalCards++;
      const st = getCardStatus(c.id);
      if (st === 'mastered') masteredCount++;
      else if (st === 'learning') learningCount++;
    }
  }
  const newCount = Math.max(0, totalCards - masteredCount - learningCount);
  const overallPct = totalCards ? Math.round((masteredCount / totalCards) * 100) : 0;

  // Build grouped or flat deck HTML
  let deckContentHtml = '';
  if (!filteredDecks.length) {
    deckContentHtml = `
      <div class="study-card" style="padding:32px 18px;text-align:center;gap:10px;">
        <div style="font-size:2rem;">📁</div>
        <h3 style="font-size:1rem;font-weight:750;">No matching sets found</h3>
        <p style="font-size:0.84rem;color:var(--text-muted);">
          ${
            state.homeSearchQuery
              ? `No decks or cards matched "${esc(state.homeSearchQuery)}".`
              : `Folder "${esc(state.homeFolderFilter)}" has no sets yet.`
          }
        </p>
        <div style="display:flex;justify-content:center;gap:8px;margin-top:4px;flex-wrap:wrap;">
          ${
            state.homeFolderFilter !== 'all' || state.homeSearchQuery
              ? `<button class="btn btn-secondary" data-action="reset-home-filters" style="padding:9px 14px;font-size:0.82rem;">
                  Show All Sets (${state.decks.length})
                </button>`
              : ''
          }
          <button class="btn btn-primary" data-action="open-add-deck" data-tab="paste" style="padding:9px 14px;font-size:0.82rem;">
            ＋ Add Deck Here
          </button>
        </div>
      </div>
    `;
  } else if (state.homeFolderFilter === 'all' && state.homeGroupByFolder) {
    const groupsMap = new Map();
    for (const deck of filteredDecks) {
      const folder = getDeckFolder(deck);
      if (!groupsMap.has(folder)) groupsMap.set(folder, []);
      groupsMap.get(folder).push(deck);
    }

    deckContentHtml = Array.from(groupsMap.entries())
      .map(([folderName, decksInFolder]) => {
        const isCollapsed = Boolean(state.collapsedFolders[folderName]) && !state.homeSearchQuery.trim();
        let fCards = 0;
        let fMastered = 0;
        for (const d of decksInFolder) {
          const c = getDeckCounts(d);
          fCards += c.all;
          fMastered += c.mastered;
        }

        return `
          <section class="folder-group ${isCollapsed ? 'collapsed' : ''}">
            <button
              class="folder-group-header"
              data-action="toggle-collapse-folder"
              data-folder="${esc(folderName)}"
              aria-expanded="${!isCollapsed}"
            >
              <div class="folder-group-left">
                <span>📁</span>
                <span class="folder-group-name">${esc(folderName)}</span>
              </div>
              <div class="folder-group-right">
                <span>${decksInFolder.length} ${decksInFolder.length === 1 ? 'set' : 'sets'} • ${fMastered}/${fCards} ✓</span>
                <span class="folder-chevron">▾</span>
              </div>
            </button>
            ${
              !isCollapsed
                ? `<div class="deck-list">${decksInFolder.map((d) => renderDeckCard(d)).join('')}</div>`
                : ''
            }
          </section>
        `;
      })
      .join('');
  } else {
    deckContentHtml = `
      <div class="deck-list">
        ${filteredDecks.map((d) => renderDeckCard(d)).join('')}
      </div>
    `;
  }

  return `
    <section class="hero-progress-card">
      <div class="hero-top-row">
        <div>
          <div class="hero-title">
            ${state.homeFolderFilter === 'all' ? 'Study Overview' : `📁 ${esc(state.homeFolderFilter)}`}
          </div>
          <div class="hero-headline">${masteredCount} of ${totalCards} Mastered</div>
        </div>
        <div class="hero-pct-badge">${overallPct}%</div>
      </div>
      <div class="mini-progress-track" style="height:6px;">
        <div class="mini-progress-fill" style="width:${totalCards ? (masteredCount / totalCards) * 100 : 0}%"></div>
        <div class="mini-progress-learning" style="width:${totalCards ? (learningCount / totalCards) * 100 : 0}%"></div>
      </div>
      <div class="hero-stats-grid">
        <div class="hero-stat-pill">
          <span class="hero-stat-val" style="color:#34d399;">${masteredCount}</span>
          <span class="hero-stat-lbl">Mastered</span>
        </div>
        <div class="hero-stat-pill">
          <span class="hero-stat-val" style="color:#fbbf24;">${learningCount}</span>
          <span class="hero-stat-lbl">Learning</span>
        </div>
        <div class="hero-stat-pill">
          <span class="hero-stat-val" style="color:#94a3b8;">${newCount}</span>
          <span class="hero-stat-lbl">Unseen</span>
        </div>
      </div>
    </section>

    <section class="home-organizer" aria-label="Organize and filter decks">
      <div class="home-search-row">
        <div class="home-search-wrap">
          <span class="home-search-icon">🔍</span>
          <input
            type="search"
            id="home-search-input"
            class="home-search-input"
            placeholder="Filter sets or cards..."
            value="${esc(state.homeSearchQuery)}"
          />
          ${
            state.homeSearchQuery
              ? `<button class="home-search-clear" data-action="clear-home-search" title="Clear search">✕</button>`
              : ''
          }
        </div>
        ${
          state.homeFolderFilter === 'all'
            ? `<button
                class="home-org-btn ${state.homeGroupByFolder ? 'active' : ''}"
                data-action="toggle-folder-grouping"
                title="Group sets by folder"
              >
                <span>${state.homeGroupByFolder ? '📁 Grouped' : '☰ List'}</span>
              </button>`
            : ''
        }
        <button
          class="home-org-btn"
          data-action="open-sheet"
          data-sheet="manage-folders"
          title="Create or manage folders"
        >
          <span>📁+</span>
        </button>
      </div>

      <div class="study-filter-strip" role="tablist" aria-label="Folders">
        <button
          class="filter-chip ${state.homeFolderFilter === 'all' ? 'active' : ''}"
          data-action="set-home-folder"
          data-folder="all"
        >
          <span>All Sets</span>
          <span class="filter-chip-count">${state.decks.length}</span>
        </button>
        ${folderStats
          .map(
            (f) => `
              <button
                class="filter-chip ${state.homeFolderFilter === f.name ? 'active' : ''}"
                data-action="set-home-folder"
                data-folder="${esc(f.name)}"
              >
                <span>📁 ${esc(f.name)}</span>
                <span class="filter-chip-count">${f.count}</span>
              </button>
            `
          )
          .join('')}
        <button
          class="filter-chip"
          data-action="open-sheet"
          data-sheet="manage-folders"
          style="border-style:dashed;"
        >
          <span>＋ Folder</span>
        </button>
      </div>
    </section>

    <div class="section-header-row">
      <span class="section-heading">
        ${
          state.homeFolderFilter === 'all'
            ? `Your Field Sets (${filteredDecks.length})`
            : `📁 ${esc(state.homeFolderFilter)} (${filteredDecks.length})`
        }
      </span>
      ${
        state.homeFolderFilter !== 'all' || state.homeSearchQuery
          ? `<button
              class="hint-pill-btn"
              data-action="reset-home-filters"
              style="font-size:0.7rem;padding:2px 9px;"
            >
              Show All (${state.decks.length})
            </button>`
          : ''
      }
    </div>

    ${deckContentHtml}
  `;
}

// --- STUDY VIEW ---
function renderStudyView() {
  const deck = getActiveDeck();
  if (!deck) return `<p>Deck not found.</p>`;

  if (state.studyMode === 'browse') return renderBrowseMode(deck);
  if (state.studyMode === 'recall') return renderRecallMode(deck);
  return renderQuizMode(deck);
}

// --- 1. FOCUSED READ / BROWSE MODE ---
function renderBrowseMode(deck) {
  const counts = getDeckCounts(deck);
  const cards = getFilteredBrowseCards();

  const filterStripHtml = `
    <div class="study-filter-strip" aria-label="Filter cards by status">
      ${[
        ['all', 'All', counts.all],
        ['new', 'Unseen', counts.new],
        ['learning', 'Learning', counts.learning],
        ['mastered', 'Mastered', counts.mastered]
      ]
        .map(
          ([key, label, count]) => `
            <button
              class="filter-chip ${state.browseFilter === key ? 'active' : ''}"
              data-action="set-browse-filter"
              data-filter="${key}"
            >
              <span>${label}</span>
              <span class="filter-chip-count">${count}</span>
            </button>
          `
        )
        .join('')}
    </div>
  `;

  if (!cards.length) {
    return `
      ${filterStripHtml}
      <div class="study-card" style="padding:38px 20px;text-align:center;gap:12px;">
        <div style="font-size:2.2rem;">🔍</div>
        <h3 style="font-size:1.05rem;font-weight:700;">No "${esc(state.browseFilter)}" cards right now</h3>
        <p style="color:var(--text-muted);font-size:0.85rem;">Switch back to All Cards to continue reading.</p>
        <div style="margin-top:4px;">
          <button class="btn btn-secondary" data-action="reset-browse-filter">Show All (${counts.all})</button>
        </div>
      </div>
    `;
  }

  if (state.browseIndex >= cards.length) state.browseIndex = 0;
  const card = cards[state.browseIndex];
  const imgSrc = getBestCardImageSrc(card, deck.color);
  const status = getCardStatus(card.id);
  const statusLabel =
    status === 'mastered' ? '✓ Mastered' : status === 'learning' ? '◐ Learning' : '○ Unseen';

  return `
    ${filterStripHtml}

    <article class="study-card">
      <div class="${getMediaFrameClass(card.id)}" style="--media-bg: url(&quot;${esc(imgSrc)}&quot;)">
        <img
          src="${esc(imgSrc)}"
          alt="${esc(card.name)}"
          data-card-id="${esc(card.id)}"
          class="media-img ${state.imageFitContain ? 'contain' : ''}"
          data-action="open-lightbox"
          data-caption="${esc(card.name)}"
        />
        <div class="media-overlay-top">
          ${card.badge ? `<span class="media-badge">${esc(card.badge)}</span>` : `<span></span>`}
          <button
            class="status-pill-btn ${status}"
            data-action="cycle-card-status"
            data-card="${esc(card.id)}"
            title="Tap to change mastery status"
          >
            ${statusLabel}
          </button>
        </div>
        <div class="media-overlay-bottom">
          <button
            class="media-ctrl-btn"
            data-action="open-lightbox"
            data-src="${esc(imgSrc)}"
            data-caption="${esc(card.name)}"
          >
            🔍 Zoom
          </button>
          <button class="media-ctrl-btn" data-action="toggle-fit">
            ${state.imageFitContain ? '⛶ Crop' : '◱ Fit'}
          </button>
        </div>
      </div>

      <div class="card-body">
        <div class="card-header-block">
          <div>
            <h2 class="card-title">${esc(card.name)}</h2>
            ${card.subtitle ? `<div class="card-subtitle">${esc(card.subtitle)}</div>` : ''}
          </div>
        </div>

        ${
          card.keyFeatures
            ? `<div class="info-block key-marks">
                <div class="info-block-label">✦ Key Identification Marks</div>
                <div style="color:var(--text-main);">${esc(card.keyFeatures)}</div>
              </div>`
            : ''
        }

        ${
          card.description
            ? `<div class="info-block">
                <div class="info-block-label">Field Notes &amp; Overview</div>
                <div>${esc(card.description)}</div>
              </div>`
            : ''
        }

        <div class="card-footer-row">
          ${
            card.sourceUrl
              ? `<a href="${esc(card.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="source-link">
                  <span>Wikipedia Reference</span>
                  <span>↗</span>
                </a>`
              : `<span></span>`
          }
          <span class="swipe-hint-lbl">Swipe ⇄ for next</span>
        </div>
      </div>
    </article>
  `;
}

// --- 2. FOCUSED RECALL MODE (2-STAGE ACTIVE RECALL WITHOUT SCROLL TRAP) ---
function renderRecallMode(deck) {
  if (state.recallFinished) {
    const total = state.recallStats.gotIt + state.recallStats.learning || 1;
    const pct = Math.round((state.recallStats.gotIt / total) * 100);
    return `
      <div class="study-card" style="padding:36px 20px;text-align:center;gap:14px;">
        <div style="font-size:3rem;">🎉</div>
        <h2 class="card-title">Recall Session Complete</h2>
        <p style="color:var(--text-sub);font-size:0.9rem;">
          Mastered: <strong style="color:var(--success);">${state.recallStats.gotIt}</strong> •
          Needs Review: <strong style="color:var(--warning);">${state.recallStats.learning}</strong> (${pct}%)
        </p>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:8px;">
          <button class="btn btn-primary" data-action="restart-recall" data-shuffle="true">
            🔀 Shuffle &amp; Practice Again
          </button>
          ${
            state.recallStats.learning > 0
              ? `<button class="btn btn-warning" data-action="practice-unmastered-recall">
                  🎯 Focus on ${state.recallStats.learning} Unmastered Card(s)
                </button>`
              : ''
          }
          <button class="btn btn-secondary" data-action="switch-mode" data-mode="quiz">
            🎯 Test Yourself in Quiz Mode
          </button>
        </div>
      </div>
    `;
  }

  const card = state.recallQueue[state.recallIndex];
  if (!card) return '';
  const imgSrc = getBestCardImageSrc(card, deck.color);

  // Quick context bar so user can flip prompt type or shuffle with 1 tap
  const contextStrip = `
    <div class="study-filter-strip">
      <button
        class="filter-chip ${state.recallPromptType === 'image-first' ? 'active' : ''}"
        data-action="set-recall-prompt"
        data-prompt="image-first"
      >
        🖼️ Photo First
      </button>
      <button
        class="filter-chip ${state.recallPromptType === 'name-first' ? 'active' : ''}"
        data-action="set-recall-prompt"
        data-prompt="name-first"
      >
        🔤 Name First
      </button>
      <button
        class="filter-chip ${state.recallFilter === 'unmastered' ? 'active' : ''}"
        data-action="toggle-recall-filter"
      >
        🎯 Unmastered Only
      </button>
      <button class="filter-chip" data-action="restart-recall" data-shuffle="true">
        🔀 Shuffle
      </button>
    </div>
  `;

  if (!state.recallFlipped) {
    const hintText =
      state.recallPromptType === 'image-first'
        ? card.keyFeatures || card.badge || 'Look closely at its silhouette and markings.'
        : card.badge
        ? `Group / Family: ${card.badge}${card.subtitle ? ` (${card.subtitle})` : ''}`
        : card.keyFeatures || 'Visualize its defining traits.';

    return `
      ${contextStrip}
      <div class="recall-card-shell">
        <article class="recall-prompt-card" data-action="flip-card">
          ${
            state.recallPromptType === 'image-first'
              ? `
                <div class="${getMediaFrameClass(card.id, 'tall')}" style="--media-bg: url(&quot;${esc(imgSrc)}&quot;)">
                  <img
                    src="${esc(imgSrc)}"
                    alt="Mystery subject"
                    data-card-id="${esc(card.id)}"
                    class="media-img ${state.imageFitContain ? 'contain' : ''}"
                  />
                  <div class="media-overlay-top">
                    ${card.badge ? `<span class="media-badge">${esc(card.badge)}</span>` : `<span></span>`}
                    <button class="media-ctrl-btn" data-action="toggle-fit">
                      ${state.imageFitContain ? '⛶ Crop' : '◱ Fit'}
                    </button>
                  </div>
                  <div class="media-overlay-bottom">
                    <button
                      class="media-ctrl-btn"
                      data-action="open-lightbox"
                      data-src="${esc(imgSrc)}"
                      data-caption="Mystery Subject"
                    >
                      🔍 Zoom
                    </button>
                    <span></span>
                  </div>
                </div>
                <div style="padding:16px 16px 12px;text-align:center;">
                  <div style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);margin-bottom:4px;">
                    Active Recall Prompt
                  </div>
                  <div style="font-size:1.08rem;font-weight:750;color:var(--text-main);">
                    Can you name this subject &amp; its key traits?
                  </div>
                </div>
              `
              : `
                <div style="min-height:260px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 20px;text-align:center;gap:10px;">
                  ${card.badge ? `<span class="source-link">${esc(card.badge)}</span>` : ''}
                  <h2 style="font-size:1.65rem;font-weight:800;line-height:1.2;">${esc(card.name)}</h2>
                  <p style="font-size:0.88rem;color:var(--text-muted);max-width:280px;">
                    Picture its visual appearance, scientific/model name, and key identification marks.
                  </p>
                </div>
              `
          }

          ${
            state.recallShowHint
              ? `<div class="recall-hint-box">
                  <strong>💡 Hint:</strong> ${esc(hintText)}
                </div>`
              : ''
          }

          <div class="recall-prompt-footer">
            <span class="recall-prompt-instruction">Tap card or button below to reveal ↻</span>
            ${
              !state.recallShowHint
                ? `<button class="hint-pill-btn" data-action="show-recall-hint">💡 Hint</button>`
                : ''
            }
          </div>
        </article>
      </div>
    `;
  }

  // Stage 2: Answer Revealed
  return `
    ${contextStrip}
    <div class="recall-card-shell">
      <article class="recall-answer-card">
        <div class="${getMediaFrameClass(card.id, 'compact')}" style="--media-bg: url(&quot;${esc(imgSrc)}&quot;)">
          <img
            src="${esc(imgSrc)}"
            alt="${esc(card.name)}"
            data-card-id="${esc(card.id)}"
            class="media-img ${state.imageFitContain ? 'contain' : ''}"
            data-action="open-lightbox"
            data-caption="${esc(card.name)}"
          />
          <div class="media-overlay-top">
            ${card.badge ? `<span class="media-badge">${esc(card.badge)}</span>` : `<span></span>`}
            <button class="media-ctrl-btn" data-action="flip-card">
              ↺ Flip to Prompt
            </button>
          </div>
          <div class="media-overlay-bottom">
            <button
              class="media-ctrl-btn"
              data-action="open-lightbox"
              data-src="${esc(imgSrc)}"
              data-caption="${esc(card.name)}"
            >
              🔍 Zoom
            </button>
            <button class="media-ctrl-btn" data-action="toggle-fit">
              ${state.imageFitContain ? '⛶ Crop' : '◱ Fit'}
            </button>
          </div>
        </div>

        <div class="card-body">
          <div>
            <h2 class="card-title">${esc(card.name)}</h2>
            ${card.subtitle ? `<div class="card-subtitle">${esc(card.subtitle)}</div>` : ''}
          </div>

          ${
            card.keyFeatures
              ? `<div class="info-block key-marks">
                  <div class="info-block-label">✦ Key Identification Marks</div>
                  <div style="color:var(--text-main);">${esc(card.keyFeatures)}</div>
                </div>`
              : ''
          }

          ${
            card.description
              ? `<div class="info-block">
                  <div class="info-block-label">About</div>
                  <div>${esc(card.description)}</div>
                </div>`
              : ''
          }

          ${
            card.sourceUrl
              ? `<div class="card-footer-row">
                  <a href="${esc(card.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="source-link">
                    <span>Wikipedia Reference</span>
                    <span>↗</span>
                  </a>
                </div>`
              : ''
          }
        </div>
      </article>
    </div>
  `;
}

// --- 3. FOCUSED QUIZ MODE ---
function renderQuizMode(deck) {
  const lastIdx = getLastAnsweredQuizIndex();
  const qPromptLabels = {
    'photo-to-name': 'Identify from Photo',
    'photo-to-sub': 'Identify Scientific / Model Name',
    'clues-to-name': 'Identify from Field Clues'
  };
  const optionLetters = ['A', 'B', 'C', 'D'];

  // Viewing the last answered question
  if (state.quizViewingLast && lastIdx >= 0) {
    const lastQ = state.quizQuestions[lastIdx];
    const { targetCard, options, qType, selectedOptionId, isCorrect } = lastQ;
    const imgSrc = getBestCardImageSrc(targetCard, deck.color);

    return `
      <article class="study-card">
        <div class="quiz-prompt-banner" style="background:${isCorrect ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)'};">
          <span>Last Question (${lastIdx + 1} of ${state.quizQuestions.length})</span>
          <span style="color:${isCorrect ? '#34d399' : '#f87171'};font-weight:800;">
            ${isCorrect ? '✓ Got It Right' : '✕ Got It Wrong'}
          </span>
        </div>

        <div class="${getMediaFrameClass(targetCard.id, 'quiz-frame')}" style="--media-bg: url(&quot;${esc(imgSrc)}&quot;)">
          <img
            src="${esc(imgSrc)}"
            alt="${esc(targetCard.name)}"
            data-card-id="${esc(targetCard.id)}"
            class="media-img ${state.imageFitContain ? 'contain' : ''}"
            data-action="open-lightbox"
            data-caption="${esc(targetCard.name)}"
          />
          <div class="media-overlay-bottom">
            <button
              class="media-ctrl-btn"
              data-action="open-lightbox"
              data-src="${esc(imgSrc)}"
              data-caption="${esc(targetCard.name)}"
            >
              🔍 Zoom
            </button>
            <button class="media-ctrl-btn" data-action="toggle-fit">
              ${state.imageFitContain ? '⛶ Crop' : '◱ Fit'}
            </button>
          </div>
        </div>

        <div class="quiz-options">
          ${options
            .map((opt, idx) => {
              let cls = 'quiz-opt';
              let keyBadge = optionLetters[idx] || String(idx + 1);
              if (opt.id === targetCard.id) {
                cls += ' correct';
                keyBadge = '✓';
              } else if (opt.id === selectedOptionId) {
                cls += ' wrong';
                keyBadge = '✕';
              }
              const mainText = qType === 'photo-to-sub' && opt.subtitle ? opt.subtitle : opt.name;
              const subText = qType === 'photo-to-sub' ? opt.name : opt.subtitle || '';

              return `
                <button class="${cls}" disabled>
                  <span class="quiz-opt-key">${keyBadge}</span>
                  <div class="quiz-opt-content">
                    <span class="quiz-opt-title">${esc(mainText)}</span>
                    ${subText ? `<span class="quiz-opt-sub">${esc(subText)}</span>` : ''}
                  </div>
                </button>
              `;
            })
            .join('')}
        </div>

        <div class="card-body" style="padding-top:0;">
          ${
            targetCard.keyFeatures || targetCard.description
              ? `<div class="info-block key-marks">
                  <div class="info-block-label">✦ ${esc(targetCard.name)} — Key Clues</div>
                  <div style="color:var(--text-main);">${esc(targetCard.keyFeatures || targetCard.description)}</div>
                </div>`
              : ''
          }
          ${
            targetCard.sourceUrl
              ? `<div class="card-footer-row">
                  <a href="${esc(targetCard.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="source-link">
                    <span>Wikipedia Reference</span>
                    <span>↗</span>
                  </a>
                </div>`
              : ''
          }
        </div>
      </article>
    `;
  }

  if (state.quizFinished) {
    const total = state.quizQuestions.length || 1;
    const pct = Math.round((state.quizScore / total) * 100);
    const lastQ = lastIdx >= 0 ? state.quizQuestions[lastIdx] : null;
    return `
      <div class="study-card" style="padding:36px 20px;text-align:center;gap:14px;">
        <div style="font-size:3.2rem;">${pct >= 80 ? '🏆' : '🎯'}</div>
        <h2 class="card-title">Quiz Score: ${state.quizScore} / ${total} (${pct}%)</h2>
        <p style="color:var(--text-sub);font-size:0.9rem;">Best Streak: 🔥 ${state.quizBestStreak}</p>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:8px;">
          ${
            lastQ
              ? `<button class="btn btn-secondary" data-action="view-last-question">
                  ← View Last Question (${lastQ.isCorrect ? '✓ Right' : '✕ Wrong'})
                </button>`
              : ''
          }
          ${
            state.quizMissedCards.length > 0
              ? `<button class="btn btn-warning" data-action="retry-missed">
                  🎯 Retry ${state.quizMissedCards.length} Missed Card(s)
                </button>`
              : ''
          }
          <button class="btn btn-primary" data-action="restart-quiz">🔄 Play Full Quiz Again</button>
          <button class="btn btn-secondary" data-action="switch-mode" data-mode="recall">
            🔄 Practice in Recall Mode
          </button>
        </div>
      </div>
    `;
  }

  const currentQ = state.quizQuestions[state.quizIndex];
  if (!currentQ) return '';
  const { targetCard, options, qType } = currentQ;
  const imgSrc = getBestCardImageSrc(targetCard, deck.color);
  const answered = state.quizSelectedOptionId !== null;
  const promptTitle = qPromptLabels[qType] || 'Identify Subject';

  return `
    <article class="study-card">
      <div class="quiz-prompt-banner">
        <span>${esc(promptTitle)}</span>
        <span>${state.quizStreak > 0 ? `🔥 ${state.quizStreak} Streak` : `Score: ${state.quizScore}`}</span>
      </div>

      ${
        qType !== 'clues-to-name' || answered
          ? `<div class="${getMediaFrameClass(targetCard.id, 'quiz-frame')}" style="--media-bg: url(&quot;${esc(imgSrc)}&quot;)">
              <img
                src="${esc(imgSrc)}"
                alt="Quiz question"
                data-card-id="${esc(targetCard.id)}"
                class="media-img ${state.imageFitContain ? 'contain' : ''}"
                data-action="open-lightbox"
                data-caption="${answered ? esc(targetCard.name) : 'Mystery Subject'}"
              />
              <div class="media-overlay-bottom">
                <button
                  class="media-ctrl-btn"
                  data-action="open-lightbox"
                  data-src="${esc(imgSrc)}"
                  data-caption="${answered ? esc(targetCard.name) : 'Mystery Subject'}"
                >
                  🔍 Zoom
                </button>
                <button class="media-ctrl-btn" data-action="toggle-fit">
                  ${state.imageFitContain ? '⛶ Crop' : '◱ Fit'}
                </button>
              </div>
            </div>`
          : `<div class="card-body" style="padding-bottom:2px;">
              <div class="info-block key-marks">
                <div class="info-block-label">🔎 Field Clues</div>
                <div style="color:var(--text-main);font-size:0.95rem;">
                  ${esc(targetCard.keyFeatures || targetCard.description)}
                </div>
              </div>
            </div>`
      }

      <div class="quiz-options">
        ${options
          .map((opt, idx) => {
            let cls = 'quiz-opt';
            let keyBadge = optionLetters[idx] || String(idx + 1);
            if (answered) {
              if (opt.id === targetCard.id) {
                cls += ' correct';
                keyBadge = '✓';
              } else if (opt.id === state.quizSelectedOptionId) {
                cls += ' wrong';
                keyBadge = '✕';
              }
            }
            const mainText = qType === 'photo-to-sub' && opt.subtitle ? opt.subtitle : opt.name;
            const subText = qType === 'photo-to-sub' ? (answered ? opt.name : '') : opt.subtitle || '';

            return `
              <button
                class="${cls}"
                data-action="quiz-answer"
                data-option="${esc(opt.id)}"
                ${answered ? 'disabled' : ''}
              >
                <span class="quiz-opt-key">${keyBadge}</span>
                <div class="quiz-opt-content">
                  <span class="quiz-opt-title">${esc(mainText)}</span>
                  ${subText ? `<span class="quiz-opt-sub">${esc(subText)}</span>` : ''}
                </div>
              </button>
            `;
          })
          .join('')}
      </div>
    </article>
  `;
}

// --- STICKY BOTTOM THUMB DOCK (SINGLE FOCUSED ACTION AREA) ---
function renderStudyDock() {
  const deck = getActiveDeck();
  if (!deck) return '';

  // 1. READ / BROWSE DOCK
  if (state.studyMode === 'browse') {
    const cards = getFilteredBrowseCards();
    if (!cards.length) return '';
    return `
      <footer class="study-dock">
        <div class="dock-row">
          <button class="dock-nav-btn" data-action="browse-prev">← Prev</button>
          <span class="dock-counter-pill">${state.browseIndex + 1} / ${cards.length}</span>
          <button class="dock-nav-btn primary" data-action="browse-next">Next →</button>
        </div>
      </footer>
    `;
  }

  // 2. RECALL DOCK (2-STAGE: REVEAL FIRST -> THEN GRADE)
  if (state.studyMode === 'recall') {
    if (state.recallFinished || !state.recallQueue.length) return '';
    if (!state.recallFlipped) {
      return `
        <footer class="study-dock">
          <div class="dock-row">
            <button class="dock-nav-btn primary" data-action="flip-card" style="height:50px;font-size:0.95rem;">
              <span>Reveal Answer</span>
              <span>↻</span>
            </button>
          </div>
        </footer>
      `;
    }
    return `
      <footer class="study-dock">
        <div class="dock-grade-grid">
          <button class="grade-btn learning" data-action="grade-recall" data-grade="learning">
            <span class="grade-btn-main">Still Learning</span>
            <span class="grade-btn-sub">Review again</span>
          </button>
          <button class="grade-btn mastered" data-action="grade-recall" data-grade="mastered">
            <span class="grade-btn-main">Got It ✓</span>
            <span class="grade-btn-sub">Mark mastered</span>
          </button>
        </div>
      </footer>
    `;
  }

  // 3. QUIZ DOCK (AUTO-ADVANCE + VIEW LAST QUESTION)
  if (state.studyMode === 'quiz') {
    if (!state.quizQuestions.length) return '';
    const lastIdx = getLastAnsweredQuizIndex();

    if (state.quizViewingLast && lastIdx >= 0) {
      const lastQ = state.quizQuestions[lastIdx];
      return `
        <footer class="study-dock">
          <div class="quiz-feedback-box">
            <div class="quiz-feedback-header">
              <span class="quiz-feedback-title ${lastQ.isCorrect ? 'correct' : 'wrong'}">
                ${
                  lastQ.isCorrect
                    ? `✓ Question ${lastIdx + 1}: Correct (${esc(lastQ.targetCard.name)})`
                    : `✕ Question ${lastIdx + 1}: Wrong — Answer: ${esc(lastQ.targetCard.name)}`
                }
              </span>
            </div>
            <button class="dock-nav-btn primary" data-action="close-last-question" style="height:46px;">
              ${state.quizFinished ? 'Back to Final Score →' : `Resume Question ${state.quizIndex + 1} →`}
            </button>
          </div>
        </footer>
      `;
    }

    if (state.quizFinished) return '';

    const currentQ = state.quizQuestions[state.quizIndex];
    if (!currentQ) return '';
    const answered = state.quizSelectedOptionId !== null;

    if (!answered) {
      if (lastIdx >= 0) {
        const lastQ = state.quizQuestions[lastIdx];
        return `
          <footer class="study-dock">
            <div class="dock-row">
              <button class="dock-nav-btn" data-action="view-last-question" style="height:44px;font-size:0.84rem;">
                <span>← View Last Question</span>
                <span style="color:${lastQ.isCorrect ? '#34d399' : '#f87171'};font-weight:800;margin-left:4px;">
                  (${lastQ.isCorrect ? '✓ Right' : '✕ Wrong'})
                </span>
              </button>
            </div>
          </footer>
        `;
      }

      return `
        <footer class="study-dock">
          <div style="text-align:center;font-size:0.78rem;color:var(--text-muted);padding:4px 0;">
            Tap an option above (or press A–D) — advances automatically
          </div>
        </footer>
      `;
    }

    const isCorrect = state.quizSelectedOptionId === currentQ.targetCard.id;

    return `
      <footer class="study-dock">
        <div class="quiz-feedback-box">
          <div class="quiz-feedback-header">
            <span class="quiz-feedback-title ${isCorrect ? 'correct' : 'wrong'}">
              ${isCorrect ? '✓ Spot on!' : `✕ Answer: ${esc(currentQ.targetCard.name)}`}
            </span>
            <span style="font-size:0.75rem;color:var(--text-muted);font-weight:600;">
              Moving to next…
            </span>
          </div>
        </div>
      </footer>
    `;
  }

  return '';
}

// --- CLEAN CONTEXTUAL BOTTOM SHEETS ---
function renderBottomSheet() {
  const folderStats = getFolderStatsList();

  // 1. HOME MENU SHEET
  if (state.activeSheet === 'home-menu') {
    return `
      <div class="sheet-backdrop" data-action="close-sheet">
        <div class="bottom-sheet" onclick="event.stopPropagation()">
          <div class="sheet-handle"></div>
          <div class="sheet-header">
            <span class="sheet-title">FieldGuide Menu</span>
            <button class="sheet-close-btn" data-action="close-sheet">✕</button>
          </div>

          <div class="sheet-section">
            <div class="sheet-section-label">Create &amp; Organize</div>
            <div class="sheet-menu-list">
              <button class="sheet-item" data-action="open-add-deck" data-tab="paste">
                <span>📝 Paste Text or Upload Deck File</span>
                <span>›</span>
              </button>
              <button class="sheet-item" data-action="open-add-deck" data-tab="prompt">
                <span>🤖 AI Deck Prompt Generator</span>
                <span>›</span>
              </button>
              <button class="sheet-item" data-action="open-sheet" data-sheet="manage-folders">
                <span>📁 Manage Folders (${folderStats.length})</span>
                <span>›</span>
              </button>
            </div>
          </div>

          <div class="sheet-section">
            <div class="sheet-section-label">Library Maintenance</div>
            ${
              state.confirmAction === 'restore-starters'
                ? `
                  <div class="inline-confirm-box">
                    <div style="font-size:0.84rem;font-weight:650;color:var(--text-main);">
                      Restore built-in starter decks to their default cards?
                    </div>
                    <div class="dock-row">
                      <button class="btn btn-secondary" data-action="cancel-confirm" style="flex:1;padding:9px;">Cancel</button>
                      <button class="btn btn-primary" data-action="restore-starters" style="flex:1;padding:9px;">Restore</button>
                    </div>
                  </div>
                `
                : `
                  <div class="sheet-menu-list">
                    <button class="sheet-item" data-action="ask-confirm" data-confirm="restore-starters">
                      <span>↻ Restore Built-in Starter Decks</span>
                      <span></span>
                    </button>
                  </div>
                `
            }
          </div>
        </div>
      </div>
    `;
  }

  // 2. MANAGE FOLDERS SHEET
  if (state.activeSheet === 'manage-folders') {
    return `
      <div class="sheet-backdrop" data-action="close-sheet">
        <div class="bottom-sheet" onclick="event.stopPropagation()">
          <div class="sheet-handle"></div>
          <div class="sheet-header">
            <span class="sheet-title">📁 Organize Folders</span>
            <button class="sheet-close-btn" data-action="close-sheet">✕</button>
          </div>

          <div class="sheet-section">
            <div class="sheet-section-label">Create New Folder</div>
            <div style="display:flex;gap:8px;">
              <input
                type="text"
                id="new-folder-input"
                class="form-input"
                placeholder="e.g. Reptiles, Semester 1, Trees..."
                value="${esc(state.newFolderInput)}"
              />
              <button class="btn btn-primary" data-action="create-folder" style="white-space:nowrap;">
                ＋ Create
              </button>
            </div>
          </div>

          <div class="sheet-section">
            <div class="sheet-section-label">Your Folders (${folderStats.length})</div>
            <div class="sheet-menu-list">
              ${folderStats
                .map((f) => {
                  if (state.renamingFolder === f.name) {
                    return `
                      <div class="inline-confirm-box" style="background:rgba(99,102,241,0.1);border-color:rgba(99,102,241,0.35);">
                        <div style="font-size:0.76rem;font-weight:700;color:#c7d2fe;">Rename "${esc(f.name)}"</div>
                        <div style="display:flex;gap:8px;">
                          <input
                            type="text"
                            id="rename-folder-input"
                            class="form-input"
                            value="${esc(state.renameFolderInput)}"
                          />
                          <button class="btn btn-primary" data-action="save-rename-folder" data-old="${esc(f.name)}" style="padding:8px 12px;">
                            Save
                          </button>
                          <button class="btn btn-secondary" data-action="cancel-rename-folder" style="padding:8px 12px;">
                            ✕
                          </button>
                        </div>
                      </div>
                    `;
                  }

                  return `
                    <div class="sheet-item" style="cursor:default;">
                      <div
                        style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer;"
                        data-action="select-folder-and-close"
                        data-folder="${esc(f.name)}"
                      >
                        <span>📁</span>
                        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.name)}</span>
                        <span style="font-size:0.75rem;color:var(--text-muted);">(${f.count} ${f.count === 1 ? 'set' : 'sets'})</span>
                      </div>
                      <div style="display:flex;align-items:center;gap:6px;">
                        <button
                          class="hint-pill-btn"
                          data-action="start-rename-folder"
                          data-folder="${esc(f.name)}"
                          title="Rename folder"
                        >
                          ✏️ Rename
                        </button>
                        <button
                          class="hint-pill-btn"
                          style="color:#f87171;border-color:rgba(239,68,68,0.28);"
                          data-action="delete-folder"
                          data-folder="${esc(f.name)}"
                          title="Remove folder"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          </div>

          <button class="btn btn-primary" data-action="close-sheet" style="width:100%;">
            Done
          </button>
        </div>
      </div>
    `;
  }

  // 3. UNIFIED 2-TAB "ADD / CREATE DECK" SHEET
  if (state.activeSheet === 'add-deck') {
    const promptPreview = AI_DECK_PROMPT_TEMPLATE(state.importTopicInput);

    return `
      <div class="sheet-backdrop" data-action="close-sheet">
        <div class="bottom-sheet" onclick="event.stopPropagation()">
          <div class="sheet-handle"></div>
          <div class="sheet-header">
            <span class="sheet-title">Add Custom Deck</span>
            <button class="sheet-close-btn" data-action="close-sheet">✕</button>
          </div>

          <div class="mode-segmented" role="tablist">
            <button
              class="mode-seg-btn ${state.addDeckTab === 'paste' ? 'active' : ''}"
              data-action="switch-add-tab"
              data-tab="paste"
            >
              📝 1. Paste / Upload
            </button>
            <button
              class="mode-seg-btn ${state.addDeckTab === 'prompt' ? 'active' : ''}"
              data-action="switch-add-tab"
              data-tab="prompt"
            >
              🤖 2. Get AI Prompt
            </button>
          </div>

          ${
            state.addDeckTab === 'paste'
              ? `
                <div class="sheet-section">
                  <div class="sheet-section-label">📁 Save to Folder (Optional)</div>
                  <input
                    type="text"
                    id="import-folder-input"
                    class="form-input"
                    placeholder="e.g. Nature & Wildlife, Aviation, Exams..."
                    value="${esc(state.importFolderInput)}"
                  />
                  ${
                    folderStats.length > 0
                      ? `<div class="study-filter-strip" style="padding-top:2px;">
                          ${folderStats
                            .map(
                              (f) => `
                                <button
                                  type="button"
                                  class="filter-chip ${state.importFolderInput === f.name ? 'active' : ''}"
                                  data-action="pick-import-folder"
                                  data-folder="${esc(f.name)}"
                                >
                                  <span>📁 ${esc(f.name)}</span>
                                </button>
                              `
                            )
                            .join('')}
                        </div>`
                      : ''
                  }
                </div>

                <div class="sheet-section">
                  <div style="display:flex;align-items:center;justify-content:space-between;">
                    <span class="sheet-section-label">Paste AI Reply or JSON</span>
                    <button class="hint-pill-btn" data-action="paste-clipboard">📋 Paste Clipboard</button>
                  </div>
                  <textarea
                    id="json-paste-area"
                    class="form-textarea"
                    style="min-height:155px;"
                    placeholder="TITLE: Australian Birds&#10;CATEGORY: Nature &amp; Wildlife&#10;ICON: 🦜&#10;&#10;---&#10;NAME: Laughing Kookaburra&#10;SUBTITLE: Dacelo novaeguineae&#10;BADGE: Kingfisher&#10;FEATURES: Heavy bill, dark eye-stripe&#10;ABOUT: Famous for its laughing call.&#10;LINK: https://en.wikipedia.org/wiki/Laughing_kookaburra"
                  >${esc(state.importRawText)}</textarea>
                </div>

                <div class="sheet-section">
                  <div class="sheet-section-label">Or Upload a .txt / .json File</div>
                  <input type="file" id="json-file-input" accept=".txt,.json,text/plain,application/json" class="form-input" />
                </div>

                <div class="dock-row" style="margin-top:2px;">
                  <button class="btn btn-secondary" data-action="switch-add-tab" data-tab="prompt" style="flex:1;">
                    🤖 Need Prompt?
                  </button>
                  <button class="btn btn-primary" data-action="submit-import-json" style="flex:1.3;">
                    Create Deck ✓
                  </button>
                </div>
              `
              : `
                <div class="info-block" style="font-size:0.8rem;">
                  <div class="info-block-label">3-Step AI Deck Builder</div>
                  1. Type any topic below &amp; tap <strong>Copy AI Prompt</strong>.<br/>
                  2. Paste into ChatGPT, Claude, or Gemini.<br/>
                  3. Copy the AI's reply and paste it in the <strong>Paste / Upload</strong> tab! (Wikipedia photos are resolved automatically.)
                </div>

                <div class="sheet-section">
                  <div class="sheet-section-label">Topic to Generate</div>
                  <div style="display:flex;gap:8px;">
                    <input
                      type="text"
                      id="ai-topic-input"
                      class="form-input"
                      placeholder="e.g. Australian Birds, Cloud Types, Trees"
                      value="${esc(state.importTopicInput)}"
                    />
                    <button class="btn btn-primary" data-action="copy-ai-prompt" style="white-space:nowrap;">
                      📋 Copy
                    </button>
                  </div>
                </div>

                <div class="sheet-section">
                  <div class="sheet-section-label">Prompt Preview</div>
                  <textarea
                    id="prompt-preview-box"
                    class="form-textarea"
                    readonly
                    style="min-height:140px;color:#cbd5e1;"
                  >${esc(promptPreview)}</textarea>
                </div>

                <div class="dock-row">
                  <button class="btn btn-primary" data-action="switch-add-tab" data-tab="paste" style="width:100%;">
                    Go to Paste Box →
                  </button>
                </div>
              `
          }
        </div>
      </div>
    `;
  }

  // 4. DECK QUICK-CONTEXT SHEET (FROM HOME SCREEN `⋯` BUTTON)
  if (state.activeSheet === 'deck-context') {
    const deck = getDeckById(state.contextDeckId);
    if (!deck) return '';
    return renderDeckManagementSheetContent(deck, false);
  }

  // 5. FOCUSED STUDY OPTIONS SHEET (FROM STUDY HEADER `⚙️` BUTTON)
  if (state.activeSheet === 'study-options') {
    const deck = getActiveDeck();
    if (!deck) return '';
    return renderDeckManagementSheetContent(deck, true);
  }

  return '';
}

function renderDeckManagementSheetContent(deck, includeModeSettings) {
  const counts = getDeckCounts(deck);
  const cachedCount = state.cachedCountByDeck[deck.id] || 0;
  const isDownloading = state.downloadingDeckId === deck.id;
  const currentFolder = getDeckFolder(deck);
  const folderStats = getFolderStatsList();

  return `
    <div class="sheet-backdrop" data-action="close-sheet">
      <div class="bottom-sheet" onclick="event.stopPropagation()">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <span class="sheet-title">${esc(deck.icon || '🃏')} ${esc(deck.title)}</span>
          <button class="sheet-close-btn" data-action="close-sheet">✕</button>
        </div>

        ${
          includeModeSettings
            ? renderModeSpecificSettingsSection(counts)
            : `
              <div class="sheet-section">
                <div class="sheet-section-label">Launch Study Mode</div>
                <div class="deck-quick-modes" style="border-top:none;padding-top:0;">
                  <button class="deck-mode-btn" data-action="open-deck" data-deck="${esc(deck.id)}" data-mode="browse">
                    📖 Read
                  </button>
                  <button class="deck-mode-btn" data-action="open-deck" data-deck="${esc(deck.id)}" data-mode="recall">
                    🔄 Recall
                  </button>
                  <button class="deck-mode-btn" data-action="open-deck" data-deck="${esc(deck.id)}" data-mode="quiz">
                    🎯 Quiz
                  </button>
                </div>
              </div>
            `
        }

        <div class="sheet-section">
          <div class="sheet-section-label">📁 Folder / Category</div>
          <div class="sheet-pill-grid">
            ${folderStats
              .map(
                (f) => `
                  <button
                    class="sheet-pill-opt ${currentFolder === f.name ? 'active' : ''}"
                    data-action="move-deck-folder"
                    data-deck="${esc(deck.id)}"
                    data-folder="${esc(f.name)}"
                  >
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📁 ${esc(f.name)}</span>
                    <span>${currentFolder === f.name ? '✓' : ''}</span>
                  </button>
                `
              )
              .join('')}
          </div>
          <div style="display:flex;gap:8px;margin-top:4px;">
            <input
              type="text"
              id="new-folder-input"
              class="form-input"
              style="padding:8px 11px;font-size:0.82rem;"
              placeholder="Move to new folder..."
              value="${esc(state.newFolderInput)}"
            />
            <button
              class="btn btn-secondary"
              data-action="create-and-move-folder"
              data-deck="${esc(deck.id)}"
              style="padding:8px 13px;font-size:0.82rem;white-space:nowrap;"
            >
              ＋ Move
            </button>
          </div>
        </div>

        <div class="sheet-section">
          <div class="sheet-section-label">Offline &amp; Deck Management</div>
          <div class="sheet-menu-list">
            <button class="sheet-item" data-action="cache-deck" data-deck="${esc(deck.id)}">
              <span>
                ${
                  isDownloading
                    ? `⏳ Saving Offline (${esc(state.downloadProgressText)})...`
                    : `📥 Save Photos Offline (${cachedCount}/${deck.cards.length} cached)`
                }
              </span>
              <span style="color:var(--accent-hover);font-size:0.78rem;">
                ${cachedCount >= deck.cards.length && deck.cards.length > 0 ? '✓ Saved' : 'Download'}
              </span>
            </button>

            <button class="sheet-item" data-action="export-deck" data-deck="${esc(deck.id)}">
              <span>⬇ Export Deck (.json)</span>
              <span></span>
            </button>

            ${
              state.confirmAction === 'reset-progress'
                ? `
                  <div class="inline-confirm-box">
                    <div style="font-size:0.84rem;font-weight:650;color:var(--text-main);">
                      Reset all mastery progress for "${esc(deck.title)}"?
                    </div>
                    <div class="dock-row">
                      <button class="btn btn-secondary" data-action="cancel-confirm" style="flex:1;padding:9px;">Cancel</button>
                      <button class="btn btn-warning" data-action="reset-progress" data-deck="${esc(deck.id)}" style="flex:1;padding:9px;">Reset</button>
                    </div>
                  </div>
                `
                : `
                  <button class="sheet-item" data-action="ask-confirm" data-confirm="reset-progress">
                    <span>↺ Reset Mastery Progress</span>
                    <span></span>
                  </button>
                `
            }

            ${
              state.confirmAction === 'delete-deck'
                ? `
                  <div class="inline-confirm-box">
                    <div style="font-size:0.84rem;font-weight:650;color:#fca5a5;">
                      Permanently delete "${esc(deck.title)}"?
                    </div>
                    <div class="dock-row">
                      <button class="btn btn-secondary" data-action="cancel-confirm" style="flex:1;padding:9px;">Cancel</button>
                      <button class="btn btn-danger" data-action="delete-deck" data-deck="${esc(deck.id)}" style="flex:1;padding:9px;">Delete</button>
                    </div>
                  </div>
                `
                : `
                  <button class="sheet-item danger" data-action="ask-confirm" data-confirm="delete-deck">
                    <span>🗑 Delete Deck</span>
                    <span></span>
                  </button>
                `
            }
          </div>
        </div>

        <button class="btn btn-primary" data-action="close-sheet" style="width:100%;">
          Done
        </button>
      </div>
    </div>
  `;
}

function renderModeSpecificSettingsSection(counts) {
  const photoDisplaySection = `
    <div class="sheet-section">
      <div class="sheet-section-label">Photo Display</div>
      <div class="sheet-pill-grid">
        <button
          class="sheet-pill-opt ${state.imageFitContain ? 'active' : ''}"
          data-action="set-image-fit"
          data-contain="true"
        >
          <span>◱ Fit Full Photo</span>
          <span>${state.imageFitContain ? '✓' : ''}</span>
        </button>
        <button
          class="sheet-pill-opt ${!state.imageFitContain ? 'active' : ''}"
          data-action="set-image-fit"
          data-contain="false"
        >
          <span>⛶ Crop to Fill</span>
          <span>${!state.imageFitContain ? '✓' : ''}</span>
        </button>
      </div>
    </div>
  `;

  if (state.studyMode === 'browse') {
    return `
      <div class="sheet-section">
        <div class="sheet-section-label">Read Mode Filter</div>
        <div class="sheet-pill-grid">
          ${[
            ['all', `All Cards (${counts.all})`],
            ['new', `Unseen (${counts.new})`],
            ['learning', `Learning (${counts.learning})`],
            ['mastered', `Mastered (${counts.mastered})`]
          ]
            .map(
              ([val, lbl]) => `
                <button
                  class="sheet-pill-opt ${state.browseFilter === val ? 'active' : ''}"
                  data-action="set-browse-filter"
                  data-filter="${val}"
                  data-keep-sheet="true"
                >
                  <span>${lbl}</span>
                  <span>${state.browseFilter === val ? '✓' : ''}</span>
                </button>
              `
            )
            .join('')}
        </div>
      </div>
      ${photoDisplaySection}
    `;
  }

  if (state.studyMode === 'recall') {
    return `
      <div class="sheet-section">
        <div class="sheet-section-label">Recall Prompt Direction</div>
        <div class="sheet-pill-grid">
          <button
            class="sheet-pill-opt ${state.recallPromptType === 'image-first' ? 'active' : ''}"
            data-action="set-recall-prompt"
            data-prompt="image-first"
            data-keep-sheet="true"
          >
            <span>🖼️ Photo First</span>
            <span>${state.recallPromptType === 'image-first' ? '✓' : ''}</span>
          </button>
          <button
            class="sheet-pill-opt ${state.recallPromptType === 'name-first' ? 'active' : ''}"
            data-action="set-recall-prompt"
            data-prompt="name-first"
            data-keep-sheet="true"
          >
            <span>🔤 Name First</span>
            <span>${state.recallPromptType === 'name-first' ? '✓' : ''}</span>
          </button>
        </div>
      </div>

      <div class="sheet-section">
        <div class="sheet-section-label">Session Cards</div>
        <div class="sheet-pill-grid">
          <button
            class="sheet-pill-opt ${state.recallFilter === 'all' ? 'active' : ''}"
            data-action="set-recall-filter"
            data-filter="all"
          >
            <span>All (${counts.all})</span>
            <span>${state.recallFilter === 'all' ? '✓' : ''}</span>
          </button>
          <button
            class="sheet-pill-opt ${state.recallFilter === 'unmastered' ? 'active' : ''}"
            data-action="set-recall-filter"
            data-filter="unmastered"
          >
            <span>Unmastered (${counts.all - counts.mastered})</span>
            <span>${state.recallFilter === 'unmastered' ? '✓' : ''}</span>
          </button>
        </div>
      </div>
      ${photoDisplaySection}
    `;
  }

  return `
    <div class="sheet-section">
      <div class="sheet-section-label">Quiz Question Style</div>
      <div class="sheet-menu-list">
        ${[
          ['mixed', '🎲 Mixed Questions (Recommended)'],
          ['photo-to-name', '🖼️ Photo → Common Name'],
          ['photo-to-sub', '🔬 Photo → Scientific / Model Name'],
          ['clues-to-name', '🔎 Field Clues → Common Name']
        ]
          .map(
            ([val, label]) => `
              <button
                class="sheet-item ${state.quizQuestionType === val ? 'active' : ''}"
                data-action="set-quiz-type"
                data-qtype="${val}"
              >
                <span>${label}</span>
                <span>${state.quizQuestionType === val ? '✓' : ''}</span>
              </button>
            `
          )
          .join('')}
      </div>
    </div>
    ${photoDisplaySection}
  `;
}

function renderLightbox() {
  return `
    <div class="sheet-backdrop" data-action="close-lightbox" style="align-items:center;padding:16px;flex-direction:column;gap:14px;">
      <img src="${esc(state.lightboxUrl)}" alt="${esc(state.lightboxCaption)}" class="lightbox-img" />
      <div style="display:flex;align-items:center;gap:12px;">
        <span style="font-weight:700;font-size:0.95rem;">${esc(state.lightboxCaption)}</span>
        <button class="hint-pill-btn" data-action="close-lightbox">Close ✕</button>
      </div>
    </div>
  `;
}

// --- EVENTS & IMAGE FALLBACK ---
function applyImageAspectAdaptation(imgEl) {
  if (!imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) return;
  const ratio = imgEl.naturalWidth / imgEl.naturalHeight;
  const cardId = imgEl.dataset.cardId;
  const frameEl = imgEl.closest('.media-frame');
  const orient = ratio < 0.95 ? 'portrait' : ratio > 1.72 ? 'wide' : 'normal';
  if (cardId) cardOrientationMap.set(cardId, orient);
  if (frameEl) {
    frameEl.classList.toggle('is-portrait', orient === 'portrait');
    frameEl.classList.toggle('is-wide', orient === 'wide');
    if (imgEl.src) {
      frameEl.style.setProperty('--media-bg', `url("${imgEl.src.replace(/"/g, '\\"')}")`);
    }
  }
}

function attachEvents() {
  const deck = getActiveDeck();
  appRoot.querySelectorAll('img[data-card-id]').forEach((imgEl) => {
    imgEl.onload = () => applyImageAspectAdaptation(imgEl);
    if (imgEl.complete && imgEl.naturalWidth > 0) {
      applyImageAspectAdaptation(imgEl);
    }

    imgEl.onerror = async () => {
      if (imgEl.dataset.fallbackTried) return;
      imgEl.dataset.fallbackTried = 'true';
      const cardId = imgEl.dataset.cardId;
      const card = deck?.cards?.find((c) => c.id === cardId);
      if (card) {
        const wikiUrl = await resolveSingleCardWikiImage(card, deck);
        if (wikiUrl && wikiUrl !== imgEl.src) {
          imgEl.src = wikiUrl;
          return;
        }
        imgEl.src = createFallbackSvgDataUrl(card, deck?.color);
      }
    };
  });

  // Home search input live filtering
  const homeSearchInput = document.getElementById('home-search-input');
  if (homeSearchInput) {
    homeSearchInput.oninput = (e) => {
      state.homeSearchQuery = e.target.value;
      render();
    };
  }

  // New folder input in Manage Folders / Deck sheet
  const newFolderInput = document.getElementById('new-folder-input');
  if (newFolderInput) {
    newFolderInput.oninput = (e) => {
      state.newFolderInput = e.target.value;
    };
  }

  // Rename folder input in Manage Folders sheet
  const renameFolderInput = document.getElementById('rename-folder-input');
  if (renameFolderInput) {
    renameFolderInput.oninput = (e) => {
      state.renameFolderInput = e.target.value;
    };
  }

  // Import folder input in Add Deck sheet
  const importFolderInput = document.getElementById('import-folder-input');
  if (importFolderInput) {
    importFolderInput.oninput = (e) => {
      state.importFolderInput = e.target.value;
    };
  }

  // Live update of prompt preview when typing topic
  const topicInput = document.getElementById('ai-topic-input');
  if (topicInput) {
    topicInput.oninput = (e) => {
      state.importTopicInput = e.target.value;
      const previewBox = document.getElementById('prompt-preview-box');
      if (previewBox) {
        previewBox.value = AI_DECK_PROMPT_TEMPLATE(state.importTopicInput);
      }
    };
  }

  // Save draft text when typing in paste box
  const pasteArea = document.getElementById('json-paste-area');
  if (pasteArea) {
    pasteArea.oninput = (e) => {
      state.importRawText = e.target.value;
    };
  }

  // Horizontal swipe navigation in Read mode (ignores vertical scroll)
  const swipeArea = document.getElementById('swipe-area');
  if (swipeArea && state.view === 'study' && state.studyMode === 'browse') {
    swipeArea.ontouchstart = (e) => {
      touchStartX = e.changedTouches[0].screenX;
      touchStartY = e.changedTouches[0].screenY;
    };
    swipeArea.ontouchend = (e) => {
      if (touchStartX === null || touchStartY === null) return;
      const diffX = e.changedTouches[0].screenX - touchStartX;
      const diffY = e.changedTouches[0].screenY - touchStartY;
      touchStartX = null;
      touchStartY = null;
      if (Math.abs(diffX) > 60 && Math.abs(diffX) > Math.abs(diffY) * 1.4) {
        changeBrowseCard(diffX < 0 ? 1 : -1);
      }
    };
  }

  appRoot.querySelectorAll('[data-action]').forEach((el) => {
    const action = el.dataset.action;
    el.onclick = async (e) => {
      e.stopPropagation();

      switch (action) {
        case 'go-home':
          clearQuizAdvanceTimer();
          state.view = 'home';
          state.activeSheet = null;
          state.confirmAction = null;
          render();
          window.scrollTo({ top: 0, behavior: 'instant' });
          break;

        case 'open-deck':
          openDeck(el.dataset.deck, el.dataset.mode || 'browse');
          break;

        case 'open-deck-context':
          state.contextDeckId = el.dataset.deck;
          state.confirmAction = null;
          state.newFolderInput = '';
          state.activeSheet = 'deck-context';
          render();
          break;

        case 'open-add-deck':
          state.addDeckTab = el.dataset.tab || 'paste';
          state.confirmAction = null;
          if (!state.importFolderInput && state.homeFolderFilter !== 'all') {
            state.importFolderInput = state.homeFolderFilter;
          }
          state.activeSheet = 'add-deck';
          render();
          break;

        case 'switch-add-tab':
          state.addDeckTab = el.dataset.tab || 'paste';
          render();
          break;

        // Home folder & search organization actions
        case 'set-home-folder':
          state.homeFolderFilter = el.dataset.folder || 'all';
          render();
          break;

        case 'reset-home-filters':
          state.homeFolderFilter = 'all';
          state.homeSearchQuery = '';
          render();
          break;

        case 'clear-home-search':
          state.homeSearchQuery = '';
          render();
          break;

        case 'toggle-folder-grouping':
          state.homeGroupByFolder = !state.homeGroupByFolder;
          render();
          break;

        case 'toggle-collapse-folder': {
          const folder = el.dataset.folder;
          if (folder) {
            state.collapsedFolders[folder] = !state.collapsedFolders[folder];
            render();
          }
          break;
        }

        case 'move-deck-folder':
          await assignDeckToFolder(el.dataset.deck, el.dataset.folder);
          break;

        case 'create-and-move-folder': {
          const inputEl = document.getElementById('new-folder-input');
          const rawName = inputEl ? inputEl.value : state.newFolderInput;
          await createNewFolder(rawName, el.dataset.deck);
          break;
        }

        case 'create-folder': {
          const inputEl = document.getElementById('new-folder-input');
          const rawName = inputEl ? inputEl.value : state.newFolderInput;
          await createNewFolder(rawName, null);
          break;
        }

        case 'select-folder-and-close':
          state.homeFolderFilter = el.dataset.folder || 'all';
          state.activeSheet = null;
          state.renamingFolder = null;
          render();
          break;

        case 'start-rename-folder':
          state.renamingFolder = el.dataset.folder;
          state.renameFolderInput = el.dataset.folder || '';
          render();
          break;

        case 'cancel-rename-folder':
          state.renamingFolder = null;
          state.renameFolderInput = '';
          render();
          break;

        case 'save-rename-folder': {
          const inputEl = document.getElementById('rename-folder-input');
          const newVal = inputEl ? inputEl.value : state.renameFolderInput;
          await renameExistingFolder(el.dataset.old, newVal);
          break;
        }

        case 'delete-folder':
          await removeFolder(el.dataset.folder);
          break;

        case 'pick-import-folder':
          state.importFolderInput =
            state.importFolderInput === el.dataset.folder ? '' : el.dataset.folder || '';
          render();
          break;

        case 'switch-mode':
          switchStudyMode(el.dataset.mode);
          break;

        case 'open-sheet':
          state.confirmAction = null;
          state.renamingFolder = null;
          state.activeSheet = el.dataset.sheet;
          render();
          break;

        case 'close-sheet':
          state.activeSheet = null;
          state.confirmAction = null;
          state.renamingFolder = null;
          render();
          break;

        case 'ask-confirm':
          state.confirmAction = el.dataset.confirm;
          render();
          break;

        case 'cancel-confirm':
          state.confirmAction = null;
          render();
          break;

        case 'toggle-fit':
          state.imageFitContain = !state.imageFitContain;
          render();
          break;

        case 'set-image-fit':
          state.imageFitContain = el.dataset.contain === 'true';
          render();
          break;

        case 'open-lightbox':
          state.lightboxUrl = el.dataset.src || el.src;
          state.lightboxCaption = el.dataset.caption || '';
          render();
          break;

        case 'close-lightbox':
          state.lightboxUrl = null;
          render();
          break;

        // Browse / Read
        case 'browse-prev':
          changeBrowseCard(-1);
          break;

        case 'browse-next':
          changeBrowseCard(1);
          break;

        case 'cycle-card-status':
          cycleBrowseCardStatus(el.dataset.card);
          break;

        case 'set-browse-filter':
          state.browseFilter = el.dataset.filter;
          state.browseIndex = 0;
          if (!el.dataset.keepSheet) state.activeSheet = null;
          render();
          break;

        case 'reset-browse-filter':
          state.browseFilter = 'all';
          state.browseIndex = 0;
          render();
          break;

        // Recall
        case 'flip-card':
          state.recallFlipped = !state.recallFlipped;
          render();
          break;

        case 'show-recall-hint':
          state.recallShowHint = true;
          render();
          break;

        case 'grade-recall':
          gradeRecallCard(el.dataset.grade);
          break;

        case 'set-recall-prompt':
          state.recallPromptType = el.dataset.prompt;
          state.recallFlipped = false;
          state.recallShowHint = false;
          if (!el.dataset.keepSheet) state.activeSheet = null;
          render();
          break;

        case 'toggle-recall-filter':
          state.recallFilter = state.recallFilter === 'all' ? 'unmastered' : 'all';
          setupRecallSession(false);
          render();
          break;

        case 'set-recall-filter':
          state.recallFilter = el.dataset.filter;
          setupRecallSession(false);
          render();
          break;

        case 'practice-unmastered-recall':
          state.recallFilter = 'unmastered';
          setupRecallSession(true);
          render();
          break;

        case 'restart-recall':
          setupRecallSession(el.dataset.shuffle === 'true');
          state.activeSheet = null;
          render();
          break;

        // Quiz
        case 'quiz-answer':
          selectQuizOption(el.dataset.option);
          break;

        case 'quiz-next':
          nextQuizQuestion();
          break;

        case 'view-last-question':
          clearQuizAdvanceTimer();
          state.quizViewingLast = true;
          render();
          window.scrollTo({ top: 0, behavior: 'instant' });
          break;

        case 'close-last-question':
          state.quizViewingLast = false;
          render();
          window.scrollTo({ top: 0, behavior: 'instant' });
          break;

        case 'set-quiz-type':
          state.quizQuestionType = el.dataset.qtype;
          setupQuizSession();
          render();
          break;

        case 'restart-quiz':
          setupQuizSession();
          render();
          break;

        case 'retry-missed':
          setupQuizSession(state.quizMissedCards);
          render();
          break;

        // Deck Tools
        case 'cache-deck':
          downloadDeckOffline(el.dataset.deck);
          break;

        case 'export-deck':
          exportDeckToJson(el.dataset.deck);
          state.activeSheet = null;
          render();
          break;

        case 'reset-progress':
          await resetDeckProgress(el.dataset.deck);
          state.progressMap = await getAllProgress();
          state.confirmAction = null;
          state.activeSheet = null;
          showToast('Mastery progress reset.');
          render();
          break;

        case 'delete-deck':
          await deleteDeck(el.dataset.deck);
          await refreshData();
          state.confirmAction = null;
          state.activeSheet = null;
          state.view = 'home';
          showToast('Deck deleted.');
          render();
          break;

        case 'restore-starters':
          await resetStarterDecks();
          await refreshData();
          state.confirmAction = null;
          state.activeSheet = null;
          showToast('Starter decks restored!');
          render();
          break;

        // AI Prompt & Text Paste
        case 'copy-ai-prompt': {
          const topicEl = document.getElementById('ai-topic-input');
          state.importTopicInput = topicEl ? topicEl.value.trim() : state.importTopicInput;
          const promptStr = AI_DECK_PROMPT_TEMPLATE(state.importTopicInput);
          navigator.clipboard.writeText(promptStr).then(() => {
            showToast('Copied AI Prompt! Paste it into your AI chat.');
          });
          break;
        }

        case 'paste-clipboard': {
          try {
            const clipText = await navigator.clipboard.readText();
            if (clipText) {
              state.importRawText = clipText;
              const pasteEl = document.getElementById('json-paste-area');
              if (pasteEl) pasteEl.value = clipText;
              showToast('Pasted from clipboard!');
            } else {
              showToast('Clipboard is empty.');
            }
          } catch (_) {
            showToast('Long-press inside the text box to paste.');
          }
          break;
        }

        case 'submit-import-json': {
          const pasteEl = document.getElementById('json-paste-area');
          if (pasteEl) state.importRawText = pasteEl.value;
          const folderEl = document.getElementById('import-folder-input');
          if (folderEl) state.importFolderInput = folderEl.value;
          handleImportDeckSubmit();
          break;
        }
      }
    };
  });

  const fileInput = document.getElementById('json-file-input');
  if (fileInput) {
    fileInput.onchange = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        state.importRawText = String(ev.target?.result || '');
        const pasteEl = document.getElementById('json-paste-area');
        if (pasteEl) pasteEl.value = state.importRawText;
        showToast(`Loaded "${file.name}"`);
      };
      reader.readAsText(file);
    };
  }
}

initApp();
