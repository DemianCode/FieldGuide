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
  cacheDeckImagesToIndexedDB,
  setLocalCardImage,
  deleteCardData,
  getCachedImageRecord
} from './db.js';
import {
  AI_PROVIDERS,
  loadAiSettings,
  saveAiSettings,
  getActiveConnection,
  isAiConfigured,
  listModels,
  testConnection,
  generateDeckJson,
  generateMoreCardsJson
} from './ai.js';
import { AI_DECK_PROMPT_TEMPLATE, STARTER_DECKS } from '../data/starter-decks.js';

const state = {
  view: 'home', // 'home' | 'study'
  theme: 'system', // 'system' | 'light' | 'dark'
  activityDays: [],
  homeSearchOpen: false,
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
  activeSheet: null, // null | 'study-options' | 'deck-context' | 'add-deck' | 'home-menu' | 'manage-folders' | 'ai-settings' | 'deck-cards' | 'card-editor'
  contextDeckId: null,
  addDeckTab: 'paste', // 'generate' | 'write' | 'paste' | 'prompt'
  confirmAction: null, // null | 'reset-progress' | 'delete-deck' | 'restore-starters'
  importTopicInput: '',
  importRawText: '',
  importAutoDownload: true,
  lightboxUrl: null,
  lightboxCaption: '',

  // AI connection (bring your own key)
  aiSettings: loadAiSettings(),
  aiDraft: null, // editable copy while the connection sheet is open
  aiReturnSheet: null,
  aiModelOptions: [],
  aiLoadingModels: false,
  aiTesting: false,
  aiBusy: false, // a generation request is in flight
  aiGenerateCount: 10,
  aiMoreCount: 10,
  aiMoreGuidance: '',

  // Write-your-own deck & card editor
  manualDeckTitle: '',
  manualDeckIcon: '',
  cardsDeckId: null,
  editorDeckId: null,
  editorCardId: null, // null while adding a new card
  editorDraft: null,
  editorPhotoBlob: null,
  editorPhotoPreview: null,
  editorRemovePhoto: false,
  editorHasLocalPhoto: false
};

const appRoot = document.getElementById('app');
let touchStartX = null;
let touchStartY = null;
let quizAutoAdvanceTimer = null;
const cardOrientationMap = new Map();
const CUSTOM_FOLDERS_KEY = 'fieldguide_custom_folders_v1';
const THEME_KEY = 'fieldguide_theme_v1';
const ACTIVITY_KEY = 'fieldguide_activity_v1';

// --- THEME (system | light | dark) ---
function loadTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') state.theme = saved;
  } catch (_) {}
  applyTheme();
}

function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', state.theme);
  const bg = getComputedStyle(root).getPropertyValue('--bg-app').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && bg) meta.setAttribute('content', bg);
}

function setTheme(theme) {
  state.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (_) {}
  applyTheme();
  render();
}

// --- DAILY STREAK (days with at least one graded card or quiz answer) ---
function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function loadActivity() {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '[]');
    if (Array.isArray(raw)) state.activityDays = raw.filter((k) => typeof k === 'string');
  } catch (_) {}
}

function recordActivity() {
  const today = dayKey();
  if (state.activityDays.includes(today)) return;
  state.activityDays = [...state.activityDays, today].slice(-400);
  try {
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(state.activityDays));
  } catch (_) {}
}

function getStreak() {
  const days = new Set(state.activityDays);
  const cursor = new Date();
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(dayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// --- INLINE ICONS (consistent across devices, inherit text colour) ---
const ICON_PATHS = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  read: '<path d="M2 5h6a4 4 0 014 4v11a3 3 0 00-3-3H2z"/><path d="M22 5h-6a4 4 0 00-4 4v11a3 3 0 013-3h7z"/>',
  recall: '<rect x="3" y="7" width="14" height="13" rx="3"/><path d="M7 4h12a2 2 0 012 2v10"/>',
  quiz: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  flame: '<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 01-10 0c0-2 1-3 2-4 .5 1.5 1.5 2 2 2-.5-3 0-5 1-8z"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  prev: '<path d="M15 6l-6 6 6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 13A9 9 0 1111 3a7 7 0 0010 10z"/>',
  auto: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 00-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0012 3z"/>',
  flip: '<path d="M3 12a9 9 0 0115-6.7L21 8M21 3v5h-5M21 12a9 9 0 01-15 6.7L3 16M3 21v-5h5"/>',
  shuffle: '<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0zM17 5h3v2a3 3 0 01-3 3M7 5H4v2a3 3 0 003 3"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
  doc: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/>',
  pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1M9 11h6M9 15h6"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  reset: '<path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M21 16l-5-5-9 9"/>',
  type: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  crop: '<path d="M6 2v14a2 2 0 002 2h14M2 6h14a2 2 0 012 2v14"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="12" cy="12" r="1"/>'
};

function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}

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
  showToast(`Moved "${deck.title}" to ${cleanFolder}`);
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
    showToast(`Created folder "${clean}"`);
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
  showToast(`Renamed folder to "${cleanNew}"`);
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
  loadTheme();
  loadActivity();
  window
    .matchMedia?.('(prefers-color-scheme: dark)')
    ?.addEventListener?.('change', () => state.theme === 'system' && applyTheme());
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
  const labels = { new: 'Marked as New', learning: 'Marked as Still Learning', mastered: 'Marked as Mastered' };
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
  recordActivity();

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
  recordActivity();

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
  if (isCorrect) {
    quizAutoAdvanceTimer = setTimeout(() => {
      nextQuizQuestion();
    }, 750);
  }
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

function normalizeJsonCard(c, deckId, cIdx) {
  return {
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
  };
}

function normalizeJsonDecks(parsed) {
  const deckArray = Array.isArray(parsed)
    ? parsed[0] && parsed[0].cards
      ? parsed
      : [{ title: 'Imported Deck', cards: parsed }]
    : [parsed];

  return deckArray.map((d, dIdx) => {
    const deckId = d.id || `deck-custom-${Date.now()}-${dIdx}`;
    const cards = (d.cards || d.items || []).map((c, cIdx) => normalizeJsonCard(c, deckId, cIdx));

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

    await saveNewDecks(decks);
    state.importRawText = '';
  } catch (err) {
    showToast(`Error parsing text: ${err.message}`);
  }
}

// Shared by paste/upload import and AI generation: folder, Wikipedia photos, save, offline download.
async function saveNewDecks(decks) {
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
  state.importFolderInput = '';
  showToast(`Added "${decks[0].title}" (${decks[0].cards.length} cards)!`);
  render();

  if (state.importAutoDownload && decks[0]) {
    downloadDeckOffline(decks[0].id);
  }
}

// --- AI CONNECTION & IN-APP GENERATION ---
function openAiSettings(returnSheet = null) {
  state.aiDraft = JSON.parse(JSON.stringify(state.aiSettings));
  state.aiReturnSheet = returnSheet;
  state.aiModelOptions = [];
  state.confirmAction = null;
  state.activeSheet = 'ai-settings';
  render();
}

function readAiDraftInputs() {
  const conn = state.aiDraft.providers[state.aiDraft.provider];
  const keyEl = document.getElementById('ai-key-input');
  const modelEl = document.getElementById('ai-model-input');
  const baseEl = document.getElementById('ai-base-input');
  if (keyEl) conn.apiKey = keyEl.value.trim();
  if (modelEl) conn.model = modelEl.value.trim();
  if (baseEl) conn.baseUrl = baseEl.value.trim();
}

function saveAiDraft() {
  readAiDraftInputs();
  state.aiSettings = state.aiDraft;
  saveAiSettings(state.aiSettings);
  showToast(
    isAiConfigured(state.aiSettings)
      ? `Saved ${AI_PROVIDERS[state.aiSettings.provider].label} connection.`
      : 'Saved. Add the missing details to start generating.'
  );
  state.activeSheet = state.aiReturnSheet;
  state.aiReturnSheet = null;
  render();
}

async function loadAiModels() {
  readAiDraftInputs();
  state.aiLoadingModels = true;
  render();
  try {
    state.aiModelOptions = await listModels(state.aiDraft);
    showToast(state.aiModelOptions.length ? `Found ${state.aiModelOptions.length} models.` : 'No models found.');
  } catch (err) {
    showToast(`Couldn't load models: ${err.message}`);
  }
  state.aiLoadingModels = false;
  render();
}

async function runAiConnectionTest() {
  readAiDraftInputs();
  if (!isAiConfigured(state.aiDraft)) {
    showToast('Fill in the key, model and address first.');
    return;
  }
  state.aiTesting = true;
  render();
  try {
    const reply = await testConnection(state.aiDraft);
    showToast(`Connected! Model replied: "${reply}"`);
  } catch (err) {
    showToast(`Connection failed: ${err.message}`);
  }
  state.aiTesting = false;
  render();
}

async function generateDeckWithAi() {
  const topicEl = document.getElementById('ai-topic-input');
  if (topicEl) state.importTopicInput = topicEl.value.trim();
  const folderEl = document.getElementById('import-folder-input');
  if (folderEl) state.importFolderInput = folderEl.value;
  const topic = state.importTopicInput.trim();
  if (!topic) {
    showToast('Type a topic to generate a deck about.');
    return;
  }
  if (state.aiBusy) return;
  state.aiBusy = true;
  render();
  try {
    const raw = await generateDeckJson(state.aiSettings, topic, state.aiGenerateCount);
    const decks = parseAnyDeckInput(raw);
    if (!decks.length || !decks[0].cards.length) throw new Error('The reply had no cards in it. Try again.');
    decks.length = 1;
    const deck = decks[0];
    deck.id = `deck-ai-${Date.now()}`;
    for (const card of deck.cards) card.id = makeCardId(deck.id);
    if (deck.title === 'Custom Deck' || deck.title === 'Imported Deck') deck.title = topic;
    state.aiBusy = false;
    await saveNewDecks(decks);
    state.importTopicInput = '';
  } catch (err) {
    state.aiBusy = false;
    showToast(`Generation failed: ${err.message}`);
    render();
  }
}

async function generateMoreCardsWithAi(deckId) {
  const deck = getDeckById(deckId);
  if (!deck || state.aiBusy) return;
  const guidanceEl = document.getElementById('ai-more-guidance');
  if (guidanceEl) state.aiMoreGuidance = guidanceEl.value.trim();
  state.aiBusy = true;
  render();
  try {
    const raw = await generateMoreCardsJson(state.aiSettings, deck, state.aiMoreCount, state.aiMoreGuidance);
    const parsed = parseAnyDeckInput(raw);
    const existingNames = new Set(deck.cards.map((c) => (c.name || '').trim().toLowerCase()));
    const fresh = [];
    for (const card of parsed[0]?.cards || []) {
      const key = (card.name || '').trim().toLowerCase();
      if (!key || existingNames.has(key)) continue;
      existingNames.add(key);
      fresh.push({ ...card, id: makeCardId(deck.id), userAdded: true });
    }
    if (!fresh.length) throw new Error('No new cards came back (they may all be duplicates).');
    deck.cards.push(...fresh);
    await resolveDeckWikipediaImages(deck);
    await saveDeck(deck);
    state.aiMoreGuidance = '';
    resyncStudySession(deck.id);
    showToast(`Added ${fresh.length} new cards to "${deck.title}".`);
  } catch (err) {
    showToast(`Generation failed: ${err.message}`);
  }
  state.aiBusy = false;
  render();
}

// --- WRITE YOUR OWN DECKS & CARDS ---
function makeCardId(deckId) {
  return `${deckId}-card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

async function createManualDeck() {
  const titleEl = document.getElementById('manual-title-input');
  const iconEl = document.getElementById('manual-icon-input');
  const folderEl = document.getElementById('import-folder-input');
  if (titleEl) state.manualDeckTitle = titleEl.value;
  if (iconEl) state.manualDeckIcon = iconEl.value;
  if (folderEl) state.importFolderInput = folderEl.value;
  const title = state.manualDeckTitle.trim();
  if (!title) {
    showToast('Give your deck a name first.');
    return;
  }
  const folder = state.importFolderInput.trim() || 'Custom Collection';
  const deck = {
    id: `deck-custom-${Date.now()}`,
    title,
    category: folder,
    icon: state.manualDeckIcon.trim() || '📚',
    color: '#6366f1',
    description: 'Cards written by hand.',
    createdAt: new Date().toISOString(),
    cards: []
  };
  await saveDeck(deck);
  if (!state.customFolders.includes(folder)) {
    state.customFolders.push(folder);
    saveCustomFolders();
  }
  await refreshData();
  state.manualDeckTitle = '';
  state.manualDeckIcon = '';
  state.importFolderInput = '';
  state.cardsDeckId = deck.id;
  openCardEditor(deck.id, null);
}

function openDeckCards(deckId) {
  state.cardsDeckId = deckId;
  state.confirmAction = null;
  state.activeSheet = 'deck-cards';
  render();
}

async function openCardEditor(deckId, cardId) {
  const deck = getDeckById(deckId);
  if (!deck) return;
  const card = cardId ? deck.cards.find((c) => c.id === cardId) : null;
  state.editorHasLocalPhoto = card ? (await getCachedImageRecord(card.id))?.resolvedUrl === 'local' : false;
  state.editorDeckId = deckId;
  state.editorCardId = card ? card.id : null;
  state.editorDraft = {
    name: card?.name || '',
    subtitle: card?.subtitle || '',
    badge: card?.badge || '',
    keyFeatures: card?.keyFeatures || '',
    description: card?.description || '',
    sourceUrl: card?.sourceUrl || '',
    imageUrl: card?.imageUrl || '',
    autoImage: card ? !card.noAutoImage : true
  };
  clearEditorPhoto();
  state.editorRemovePhoto = false;
  state.confirmAction = null;
  state.activeSheet = 'card-editor';
  render();
  document.querySelector('.bottom-sheet')?.scrollTo({ top: 0 });
}

function clearEditorPhoto() {
  if (state.editorPhotoPreview) URL.revokeObjectURL(state.editorPhotoPreview);
  state.editorPhotoBlob = null;
  state.editorPhotoPreview = null;
}

function readEditorInputs() {
  const d = state.editorDraft;
  if (!d) return;
  for (const [field, id] of [
    ['name', 'card-name-input'],
    ['subtitle', 'card-subtitle-input'],
    ['badge', 'card-badge-input'],
    ['keyFeatures', 'card-features-input'],
    ['description', 'card-about-input'],
    ['sourceUrl', 'card-link-input'],
    ['imageUrl', 'card-image-url-input']
  ]) {
    const el = document.getElementById(id);
    if (el) d[field] = el.value;
  }
  const autoEl = document.getElementById('card-auto-image');
  if (autoEl) d.autoImage = autoEl.checked;
}

// Shrinks large phone photos so IndexedDB stays small; falls back to the original file.
async function downscalePhoto(file, maxSide = 1280) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 600 * 1024) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob || file;
  } catch (_) {
    return file;
  }
}

async function saveEditorCard(addAnother = false) {
  readEditorInputs();
  const deck = getDeckById(state.editorDeckId);
  const d = state.editorDraft;
  if (!deck || !d) return;
  const name = d.name.trim();
  if (!name) {
    showToast('Every card needs a name.');
    return;
  }
  const link = d.sourceUrl.trim();
  const imageUrl = d.imageUrl.trim();
  if (link && !isHttpUrl(link)) {
    showToast('The link must start with http:// or https://');
    return;
  }
  if (imageUrl && !isHttpUrl(imageUrl)) {
    showToast('The image address must start with http:// or https://');
    return;
  }

  const existing = state.editorCardId ? deck.cards.find((c) => c.id === state.editorCardId) : null;
  const card = existing || { id: makeCardId(deck.id) };
  const imageChanged = existing && (existing.imageUrl || '') !== imageUrl;
  Object.assign(card, {
    name,
    subtitle: d.subtitle.trim(),
    badge: d.badge.trim(),
    keyFeatures: d.keyFeatures.trim(),
    description: d.description.trim(),
    sourceUrl: link,
    imageUrl,
    noAutoImage: !d.autoImage,
    userAdded: true
  });
  if (!existing) deck.cards.push(card);

  if (state.editorPhotoBlob) {
    await setLocalCardImage(card.id, deck.id, state.editorPhotoBlob);
  } else if (state.editorRemovePhoto || imageChanged) {
    await deleteCardData(card.id, { keepProgress: true });
  }
  if (!card.imageUrl && d.autoImage && !state.editorPhotoBlob) {
    await resolveSingleCardWikiImage(card, null);
  }
  await saveDeck(deck);
  state.cachedCountByDeck[deck.id] = (await getDeckCachedImageIds(deck.id)).size;
  resyncStudySession(deck.id);
  showToast(existing ? `Saved "${name}".` : `Added "${name}" (${deck.cards.length} cards).`);

  if (addAnother) {
    openCardEditor(deck.id, null);
  } else {
    clearEditorPhoto();
    state.editorDraft = null;
    openDeckCards(deck.id);
  }
}

async function deleteCardFromDeck(deckId, cardId) {
  const deck = getDeckById(deckId);
  if (!deck) return;
  deck.cards = deck.cards.filter((c) => c.id !== cardId);
  if (STARTER_DECKS.some((d) => d.id === deck.id)) {
    deck.removedCardIds = [...new Set([...(deck.removedCardIds || []), cardId])];
  }
  await saveDeck(deck);
  await deleteCardData(cardId);
  delete state.progressMap[cardId];
  state.cachedCountByDeck[deck.id] = (await getDeckCachedImageIds(deck.id)).size;
  resyncStudySession(deck.id);
  state.confirmAction = null;
  showToast('Card deleted.');
  render();
}

// Rebuilds the open study session after its deck's cards change.
function resyncStudySession(deckId) {
  if (state.view !== 'study' || state.activeDeckId !== deckId) return;
  const deck = getActiveDeck();
  if (!deck?.cards.length) {
    state.view = 'home';
    return;
  }
  if (state.studyMode === 'browse') {
    state.browseIndex = Math.min(state.browseIndex, Math.max(0, getFilteredBrowseCards().length - 1));
  } else if (state.studyMode === 'recall') {
    setupRecallSession();
  } else {
    setupQuizSession();
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

  const studyDock = state.view === 'study' ? renderStudyDock() : '';
  const hasDock = Boolean(studyDock.trim());

  appRoot.innerHTML = `
    <div class="mobile-shell">
      ${renderTopBar()}
      <main class="screen-body ${state.view === 'study' ? 'study-layout' : ''} ${hasDock ? 'has-dock' : ''}" id="swipe-area">
        ${state.view === 'home' ? renderHomeView() : renderStudyView()}
      </main>
      ${state.view === 'home' ? renderFab() : studyDock}
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

function renderFab() {
  return `
    <div class="fab-wrap">
      <button class="fab" data-action="open-add-deck" data-tab="auto" aria-label="Add a new deck">
        ${icon('plus')}<span>New deck</span>
      </button>
    </div>
  `;
}

// --- TOP BAR (HOME TITLE OR COMPACT STUDY HEADER) ---
function renderTopBar() {
  if (state.view === 'home') {
    const streak = getStreak();
    return `
      <header class="topbar">
        <div class="topbar-main">
          <div class="topbar-title-group">
            <span class="topbar-title big">Today</span>
          </div>
          <div class="topbar-right">
            <span class="streak-pill ${streak ? '' : 'idle'}">
              ${icon('flame', 'sm')}
              <span>${streak ? `${streak}-day streak` : 'No streak yet'}</span>
            </span>
            <button class="icon-btn" data-action="open-sheet" data-sheet="home-menu" aria-label="Menu">
              ${icon('more')}
            </button>
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
    subInfo = total ? `Read · ${cur} of ${total}` : 'Read · no matching cards';
    progressPct = total ? Math.round((cur / total) * 100) : 0;
    hasActiveFilter = state.browseFilter !== 'all';
  } else if (state.studyMode === 'recall') {
    const total = state.recallQueue.length || 1;
    const cur = state.recallFinished ? total : state.recallIndex + 1;
    subInfo = state.recallFinished ? 'Recall · complete' : `Recall · ${cur} of ${total}`;
    progressPct = state.recallFinished ? 100 : Math.round(((cur - 1) / total) * 100);
    hasActiveFilter = state.recallFilter !== 'all' || state.recallPromptType !== 'image-first';
  } else if (state.studyMode === 'quiz') {
    const total = state.quizQuestions.length || 1;
    const cur = state.quizFinished ? total : state.quizIndex + 1;
    subInfo = state.quizFinished ? `Quiz · score ${state.quizScore}/${total}` : `Quiz · ${cur} of ${total}`;
    progressPct = state.quizFinished ? 100 : Math.round(((cur - 1) / total) * 100);
    hasActiveFilter = state.quizQuestionType !== 'mixed';
  }

  return `
    <header class="topbar">
      <div class="topbar-main">
        <div class="topbar-left">
          <button class="icon-btn" data-action="go-home" aria-label="Back to decks">${icon('back')}</button>
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
            aria-label="Mode and options"
          >
            ${icon('sliders')}
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

  return `
    <button
      class="deck-tile"
      style="--deck-color:${esc(deck.color || '#2457f5')}"
      data-action="open-deck-context"
      data-deck="${esc(deck.id)}"
      aria-label="${esc(deck.title)}, ${counts.all} cards, ${counts.mastered} mastered"
    >
      <span class="deck-tile-top">
        <span class="deck-avatar">${esc(deck.icon || '🃏')}</span>
        <span class="deck-ring" style="--p:${mPct}%"></span>
      </span>
      <span>
        <span class="deck-name">${esc(deck.title)}</span>
        <span class="deck-meta">${counts.all} cards · ${counts.mastered} mastered</span>
      </span>
    </button>
  `;
}

function getPracticePlan() {
  let total = 0;
  let mastered = 0;
  let bestDeck = null;
  let bestOpen = 0;
  for (const deck of state.decks) {
    const c = getDeckCounts(deck);
    total += c.all;
    mastered += c.mastered;
    const open = c.all - c.mastered;
    if (open > bestOpen) {
      bestOpen = open;
      bestDeck = deck;
    }
  }
  return { total, mastered, open: total - mastered, deck: bestDeck };
}

function renderHomeView() {
  const folderStats = getFolderStatsList().filter((f) => f.count > 0);
  const filteredDecks = getFilteredHomeDecks();
  const plan = getPracticePlan();
  const streak = getStreak();
  const masteredPct = plan.total ? (plan.mastered / plan.total) * 100 : 0;

  const eyebrow = plan.open > 0 ? `${plan.open} ${plan.open === 1 ? 'card' : 'cards'} to practice` : 'Everything mastered';
  const headline =
    plan.open === 0 ? 'Test yourself again' : streak > 0 ? 'Keep your streak going' : 'Start today’s practice';

  let deckContentHtml = '';
  if (!filteredDecks.length) {
    deckContentHtml = `
      <div class="study-card message finish-panel">
        <h3 style="font-size:1.1rem;font-weight:800;">No matching decks</h3>
        <p style="font-size:0.95rem;color:var(--text-muted);">
          ${
            state.homeSearchQuery
              ? `Nothing matched “${esc(state.homeSearchQuery)}”.`
              : `Folder “${esc(state.homeFolderFilter)}” has no decks yet.`
          }
        </p>
        <div class="finish-actions">
          ${
            state.homeFolderFilter !== 'all' || state.homeSearchQuery
              ? `<button class="btn btn-secondary" data-action="reset-home-filters">Show all decks (${state.decks.length})</button>`
              : ''
          }
          <button class="btn btn-primary" data-action="open-add-deck" data-tab="auto">Add a deck</button>
        </div>
      </div>
    `;
  } else {
    deckContentHtml = `<div class="deck-grid">${filteredDecks.map((d) => renderDeckCard(d)).join('')}</div>`;
  }

  return `
    <section class="today-card" aria-label="Today's practice">
      <div>
        <div class="today-eyebrow">${eyebrow}</div>
        <div class="today-headline">${headline}</div>
      </div>
      <div class="today-bar" aria-hidden="true"><span style="width:${masteredPct}%"></span></div>
      <div class="today-eyebrow" style="margin-top:-6px;">${plan.mastered} of ${plan.total} mastered</div>
      ${
        plan.deck
          ? `<button class="cta-btn" data-action="practice-now" data-deck="${esc(plan.deck.id)}">Practice now</button>`
          : state.decks[0]
          ? `<button class="cta-btn" data-action="open-deck" data-deck="${esc(state.decks[0].id)}" data-mode="quiz">Take a quiz</button>`
          : ''
      }
    </section>

    <div class="section-header-row">
      <span class="section-heading">Decks</span>
      <button class="icon-btn" data-action="toggle-home-search" aria-label="Search decks" aria-expanded="${state.homeSearchOpen || Boolean(state.homeSearchQuery)}">
        ${icon('search')}
      </button>
    </div>

    ${
      state.homeSearchOpen || state.homeSearchQuery
        ? `<div class="home-search-wrap">
            <span class="home-search-icon">${icon('search', 'sm')}</span>
            <input
              type="search"
              id="home-search-input"
              class="home-search-input"
              placeholder="Search decks or cards"
              value="${esc(state.homeSearchQuery)}"
            />
            ${
              state.homeSearchQuery
                ? `<button class="home-search-clear" data-action="clear-home-search" aria-label="Clear search">${icon('close', 'sm')}</button>`
                : ''
            }
          </div>`
        : ''
    }

    ${
      folderStats.length > 1
        ? `<div class="study-filter-strip" aria-label="Folders">
            <button class="filter-chip ${state.homeFolderFilter === 'all' ? 'active' : ''}" data-action="set-home-folder" data-folder="all">
              All <span class="filter-chip-count">${state.decks.length}</span>
            </button>
            ${folderStats
              .map(
                (f) => `
                  <button class="filter-chip ${state.homeFolderFilter === f.name ? 'active' : ''}" data-action="set-home-folder" data-folder="${esc(f.name)}">
                    ${esc(f.name)} <span class="filter-chip-count">${f.count}</span>
                  </button>`
              )
              .join('')}
          </div>`
        : ''
    }

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

// --- SHARED STUDY PIECES ---
function renderMediaFrame(card, deck, { cls = '', badge = false, status = false, alt = '', caption = '', zoom = true, mystery = false } = {}) {
  const imgSrc = getBestCardImageSrc(card, deck.color, { mystery });
  const st = getCardStatus(card.id);
  const statusLabel =
    st === 'mastered' ? `${icon('check', 'xs')} Mastered` : st === 'learning' ? 'Learning' : 'Unseen';
  const showTop = (badge && card.badge) || status;
  return `
    <div class="${getMediaFrameClass(card.id, cls)}" style="--media-bg: url(&quot;${esc(imgSrc)}&quot;)">
      <img
        src="${esc(imgSrc)}"
        alt="${esc(alt)}"
        data-card-id="${esc(card.id)}"
        ${mystery ? 'data-mystery="true"' : ''}
        class="media-img ${state.imageFitContain ? 'contain' : ''}"
        ${zoom ? `data-action="open-lightbox" data-caption="${esc(caption)}"` : 'style="cursor:pointer"'}
      />
      ${
        showTop
          ? `<div class="media-overlay-top">
              ${badge && card.badge ? `<span class="media-badge">${esc(card.badge)}</span>` : `<span></span>`}
              ${
                status
                  ? `<button class="status-pill-btn ${st}" data-action="cycle-card-status" data-card="${esc(card.id)}" aria-label="Change status, currently ${st}">${statusLabel}</button>`
                  : ''
              }
            </div>`
          : ''
      }
    </div>
  `;
}

function renderCardDetails(card, { aboutLabel = 'About', showLink = true } = {}) {
  return `
    ${
      card.keyFeatures
        ? `<div class="info-block key-marks">
            <div class="info-block-label">Look for</div>
            <div style="color:var(--text-main);">${esc(card.keyFeatures)}</div>
          </div>`
        : ''
    }
    ${
      card.description
        ? `<div class="info-block">
            <div class="info-block-label">${aboutLabel}</div>
            <div>${esc(card.description)}</div>
          </div>`
        : ''
    }
    ${
      showLink && isHttpUrl(card.sourceUrl)
        ? `<div class="card-footer-row">
            <a href="${esc(card.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="source-link">
              <span>${card.sourceUrl.includes('wikipedia.org') ? 'Wikipedia' : 'Source'}</span>${icon('external', 'xs')}
            </a>
          </div>`
        : ''
    }
  `;
}

// --- 1. READ MODE: PHOTO FIRST, NOTES IN A SHEET BELOW ---
function renderBrowseMode(deck) {
  const counts = getDeckCounts(deck);
  const cards = getFilteredBrowseCards();

  if (!cards.length) {
    return `
      <div class="study-card message finish-panel">
        <h3 style="font-size:1.1rem;font-weight:800;">No ${esc(state.browseFilter)} cards right now</h3>
        <p style="color:var(--text-muted);font-size:0.95rem;">Switch back to all cards to keep reading.</p>
        <div class="finish-actions">
          <button class="btn btn-primary" data-action="reset-browse-filter">Show all (${counts.all})</button>
        </div>
      </div>
    `;
  }

  if (state.browseIndex >= cards.length) state.browseIndex = 0;
  const card = cards[state.browseIndex];

  return `
    <article class="study-card flush" style="flex:1;">
      ${renderMediaFrame(card, deck, { badge: true, status: true, alt: card.name, caption: card.name })}
      <div class="card-body sheet-card" style="flex:1;">
        <div>
          <h2 class="card-title">${esc(card.name)}</h2>
          ${card.subtitle ? `<div class="card-subtitle">${esc(card.subtitle)}</div>` : ''}
        </div>
        ${renderCardDetails(card, { aboutLabel: 'Field notes' })}
      </div>
    </article>
  `;
}

// --- 2. RECALL MODE: REVEAL, THEN SWIPE TO GRADE ---
function renderRecallMode(deck) {
  if (state.recallFinished) {
    const total = state.recallStats.gotIt + state.recallStats.learning || 1;
    const pct = Math.round((state.recallStats.gotIt / total) * 100);
    return `
      <div class="study-card message finish-panel">
        <div class="finish-score">${pct}%</div>
        <h2 class="card-title" style="font-size:1.3rem;">Session complete</h2>
        <p style="color:var(--text-sub);font-size:1rem;">
          <strong style="color:var(--success-text);">${state.recallStats.gotIt}</strong> got it ·
          <strong style="color:var(--warning-text);">${state.recallStats.learning}</strong> to review
        </p>
        <div class="finish-actions">
          ${
            state.recallStats.learning > 0
              ? `<button class="btn btn-primary" data-action="practice-unmastered-recall">Review ${state.recallStats.learning} missed</button>`
              : ''
          }
          <button class="btn btn-secondary" data-action="restart-recall" data-shuffle="true">Shuffle and go again</button>
          <button class="btn btn-secondary" data-action="switch-mode" data-mode="quiz">Test yourself in a quiz</button>
        </div>
      </div>
    `;
  }

  const card = state.recallQueue[state.recallIndex];
  if (!card) return '';

  if (!state.recallFlipped) {
    const hintText =
      state.recallPromptType === 'image-first'
        ? card.keyFeatures || card.badge || 'Look closely at its silhouette and markings.'
        : card.badge
        ? `Group: ${card.badge}${card.subtitle ? ` (${card.subtitle})` : ''}`
        : card.keyFeatures || 'Picture its defining traits.';

    return `
      <div class="stage">
        <div class="recall-card-shell">
          <article class="recall-prompt-card" data-action="flip-card">
            ${
              state.recallPromptType === 'image-first'
                ? `${renderMediaFrame(card, deck, { cls: 'tall', badge: true, alt: 'Mystery subject', zoom: false, mystery: true })}
                   <div class="recall-prompt-title">What is this?</div>`
                : `<div style="min-height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 20px;text-align:center;gap:12px;">
                    ${card.badge ? `<span class="source-link">${esc(card.badge)}</span>` : ''}
                    <h2 style="font-size:2rem;font-weight:850;line-height:1.15;letter-spacing:-0.02em;">${esc(card.name)}</h2>
                    <p style="font-size:0.98rem;color:var(--text-muted);max-width:290px;">
                      Picture how it looks and what sets it apart.
                    </p>
                  </div>`
            }
            ${state.recallShowHint ? `<div class="recall-hint-box"><strong>Hint:</strong> ${esc(hintText)}</div>` : ''}
            <div class="recall-prompt-footer">
              <span class="recall-prompt-instruction">Tap the card to reveal</span>
              ${
                !state.recallShowHint
                  ? `<button class="hint-pill-btn" data-action="show-recall-hint">${icon('bulb', 'xs')} Hint</button>`
                  : ''
              }
            </div>
          </article>
        </div>
      </div>
    `;
  }

  return `
    <div class="stage">
      <div class="recall-card-shell" id="recall-swipe">
        <span class="swipe-stamp again" id="stamp-again">Still learning</span>
        <span class="swipe-stamp got" id="stamp-got">Got it</span>
        <article class="recall-answer-card" id="recall-answer">
          ${renderMediaFrame(card, deck, { cls: 'compact', badge: true, alt: card.name, caption: card.name })}
          <div class="card-body" style="padding-bottom:18px;">
            <div>
              <h2 class="card-title">${esc(card.name)}</h2>
              ${card.subtitle ? `<div class="card-subtitle">${esc(card.subtitle)}</div>` : ''}
            </div>
            ${renderCardDetails(card)}
          </div>
        </article>
      </div>
    </div>
  `;
}

// --- 3. QUIZ MODE: PHOTO OR CLUES ON TOP, ANSWERS BELOW ---
function renderQuizMode(deck) {
  const lastIdx = getLastAnsweredQuizIndex();
  const qPromptLabels = {
    'photo-to-name': 'From the photo',
    'photo-to-sub': 'Scientific / model name',
    'clues-to-name': 'From the clues'
  };
  const qQuestions = {
    'photo-to-name': 'Which one is this?',
    'photo-to-sub': 'What is its scientific or model name?',
    'clues-to-name': 'Which one fits these clues?'
  };

  const renderOptions = (q, answered, revealSelected) => {
    const { targetCard, options, qType } = q;
    return `
      <div class="quiz-options">
        ${options
          .map((opt) => {
            let cls = 'quiz-opt';
            let keyBadge = '';
            if (answered) {
              if (opt.id === targetCard.id) {
                cls += ' correct';
                keyBadge = icon('check', 'xs');
              } else if (opt.id === revealSelected) {
                cls += ' wrong';
                keyBadge = icon('x', 'xs');
              }
            }
            const mainText = qType === 'photo-to-sub' && opt.subtitle ? opt.subtitle : opt.name;
            const subText = qType === 'photo-to-sub' ? (answered ? opt.name : '') : opt.subtitle || '';
            return `
              <button
                class="${cls}"
                ${answered ? 'disabled' : `data-action="quiz-answer" data-option="${esc(opt.id)}"`}
              >
                <div class="quiz-opt-content">
                  <span class="quiz-opt-title">${esc(mainText)}</span>
                  ${subText ? `<span class="quiz-opt-sub">${esc(subText)}</span>` : ''}
                </div>
                <span class="quiz-opt-key">${keyBadge}</span>
              </button>
            `;
          })
          .join('')}
      </div>
    `;
  };

  // Reviewing the previous question
  if (state.quizViewingLast && lastIdx >= 0) {
    const lastQ = state.quizQuestions[lastIdx];
    const { targetCard, selectedOptionId, qType } = lastQ;
    return `
      <div class="stage">
        <div class="quiz-meta"><span>Question ${lastIdx + 1} of ${state.quizQuestions.length}</span><span></span></div>
        ${renderMediaFrame(targetCard, deck, { cls: 'quiz-frame', alt: targetCard.name, caption: targetCard.name })}
        <div class="quiz-question">${esc(qQuestions[qType] || 'Which one is this?')}</div>
        ${renderOptions(lastQ, true, selectedOptionId)}
        ${renderCardDetails(targetCard)}
      </div>
    `;
  }

  if (state.quizFinished) {
    const total = state.quizQuestions.length || 1;
    const pct = Math.round((state.quizScore / total) * 100);
    const lastQ = lastIdx >= 0 ? state.quizQuestions[lastIdx] : null;
    return `
      <div class="study-card message finish-panel">
        <div class="finish-score">${state.quizScore}/${total}</div>
        <h2 class="card-title" style="font-size:1.3rem;">${pct >= 80 ? 'Great round' : pct >= 50 ? 'Getting there' : 'Keep practising'} · ${pct}%</h2>
        <p style="color:var(--text-sub);font-size:1rem;">Best streak: ${state.quizBestStreak}</p>
        <div class="finish-actions">
          ${
            state.quizMissedCards.length > 0
              ? `<button class="btn btn-primary" data-action="retry-missed">Retry ${state.quizMissedCards.length} missed</button>`
              : ''
          }
          <button class="btn btn-secondary" data-action="restart-quiz">Play again</button>
          ${
            lastQ
              ? `<button class="btn btn-secondary" data-action="view-last-question">Review last question</button>`
              : ''
          }
          <button class="btn btn-secondary" data-action="switch-mode" data-mode="recall">Practise in Recall</button>
        </div>
      </div>
    `;
  }

  const currentQ = state.quizQuestions[state.quizIndex];
  if (!currentQ) return '';
  const { targetCard, qType } = currentQ;
  const answered = state.quizSelectedOptionId !== null;
  const showClues = qType === 'clues-to-name' && !answered;

  return `
    <div class="stage">
      <div class="quiz-meta">
        <span>${esc(qPromptLabels[qType] || 'Identify')}</span>
        ${
          state.quizStreak > 1
            ? `<span class="streak">${icon('flame', 'xs')} ${state.quizStreak} in a row</span>`
            : `<span>Score ${state.quizScore}</span>`
        }
      </div>
      ${
        showClues
          ? `<div class="info-block key-marks" style="font-size:1.12rem;line-height:1.5;padding:18px;">
              <div class="info-block-label">Field clues</div>
              <div style="color:var(--text-main);">${esc(targetCard.keyFeatures || targetCard.description)}</div>
            </div>`
          : renderMediaFrame(targetCard, deck, {
              cls: 'quiz-frame',
              alt: answered ? targetCard.name : 'Quiz question',
              caption: answered ? targetCard.name : 'Mystery subject',
              mystery: !answered
            })
      }
      <div class="quiz-question">${esc(qQuestions[qType] || 'Which one is this?')}</div>
      ${renderOptions(currentQ, answered, state.quizSelectedOptionId)}
    </div>
  `;
}

// --- BOTTOM DOCK (ONLY WHEN THERE IS AN ACTION TO TAKE) ---
function renderStudyDock() {
  const deck = getActiveDeck();
  if (!deck) return '';

  if (state.studyMode === 'browse') {
    const cards = getFilteredBrowseCards();
    if (!cards.length) return '';
    return `
      <footer class="study-dock">
        <div class="dock-row">
          <button class="dock-nav-btn" data-action="browse-prev">${icon('prev')} Prev</button>
          <span class="dock-counter-pill">${state.browseIndex + 1} / ${cards.length}</span>
          <button class="dock-nav-btn primary" data-action="browse-next">Next ${icon('next')}</button>
        </div>
      </footer>
    `;
  }

  if (state.studyMode === 'recall') {
    if (state.recallFinished || !state.recallQueue.length) return '';
    if (!state.recallFlipped) {
      return `
        <footer class="study-dock">
          <div class="dock-row">
            <button class="dock-nav-btn primary" data-action="flip-card">Reveal answer</button>
          </div>
        </footer>
      `;
    }
    return `
      <footer class="study-dock">
        <div class="dock-grade-grid">
          <button class="grade-btn learning" data-action="grade-recall" data-grade="learning">
            <span class="grade-btn-main">Still learning</span>
            <span class="grade-btn-sub">Swipe left</span>
          </button>
          <button class="grade-btn mastered" data-action="grade-recall" data-grade="mastered">
            <span class="grade-btn-main">Got it</span>
            <span class="grade-btn-sub">Swipe right</span>
          </button>
        </div>
      </footer>
    `;
  }

  if (state.studyMode === 'quiz') {
    if (!state.quizQuestions.length) return '';
    const lastIdx = getLastAnsweredQuizIndex();

    if (state.quizViewingLast && lastIdx >= 0) {
      const lastQ = state.quizQuestions[lastIdx];
      return `
        <footer class="study-dock">
          <div class="quiz-feedback-box">
            <div class="quiz-feedback-header ${lastQ.isCorrect ? 'correct' : 'wrong'}">
              <span class="quiz-feedback-title ${lastQ.isCorrect ? 'correct' : 'wrong'}">
                ${lastQ.isCorrect ? 'You got this one right' : `Answer: ${esc(lastQ.targetCard.name)}`}
              </span>
            </div>
            <button class="dock-nav-btn primary" data-action="close-last-question">
              ${state.quizFinished ? 'Back to score' : `Resume question ${state.quizIndex + 1}`}
            </button>
          </div>
        </footer>
      `;
    }

    if (state.quizFinished) return '';

    const currentQ = state.quizQuestions[state.quizIndex];
    if (!currentQ) return '';

    if (state.quizSelectedOptionId === null) {
      if (lastIdx < 0) return '';
      return `
        <footer class="study-dock">
          <button class="dock-nav-btn ghost" data-action="view-last-question">
            ${icon('prev', 'sm')} Previous question
          </button>
        </footer>
      `;
    }

    const isCorrect = state.quizSelectedOptionId === currentQ.targetCard.id;
    return `
      <footer class="study-dock">
        <div class="quiz-feedback-box">
          <div class="quiz-feedback-header ${isCorrect ? 'correct' : 'wrong'}">
            <span class="quiz-feedback-title ${isCorrect ? 'correct' : 'wrong'}">
              ${isCorrect ? 'Correct' : `Answer: ${esc(currentQ.targetCard.name)}`}
            </span>
            <button class="hint-pill-btn" data-action="quiz-next">Next ${icon('next', 'xs')}</button>
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
            <button class="sheet-close-btn" data-action="close-sheet" aria-label="Close">${icon('close', 'sm')}</button>
          </div>

          <div class="sheet-section">
            <div class="sheet-section-label">Appearance</div>
            ${renderThemeSwitch()}
          </div>

          <div class="sheet-section">
            <div class="sheet-section-label">Create &amp; Organize</div>
            <div class="sheet-menu-list">
              <button class="sheet-item" data-action="open-add-deck" data-tab="generate">
                <span class="sheet-item-label">${icon('sparkle', 'sm')} Generate a deck with AI</span>
                <span>${icon('next', 'sm')}</span>
              </button>
              <button class="sheet-item" data-action="open-add-deck" data-tab="write">
                <span class="sheet-item-label">${icon('pencil', 'sm')} Write your own deck</span>
                <span>${icon('next', 'sm')}</span>
              </button>
              <button class="sheet-item" data-action="open-add-deck" data-tab="paste">
                <span class="sheet-item-label">${icon('doc', 'sm')} Paste text or upload a deck file</span>
                <span>${icon('next', 'sm')}</span>
              </button>
              <button class="sheet-item" data-action="open-add-deck" data-tab="prompt">
                <span class="sheet-item-label">${icon('clipboard', 'sm')} Copy a prompt for another AI chat</span>
                <span>${icon('next', 'sm')}</span>
              </button>
              <button class="sheet-item" data-action="open-sheet" data-sheet="manage-folders">
                <span class="sheet-item-label">${icon('folder', 'sm')} Manage folders (${folderStats.length})</span>
                <span>${icon('next', 'sm')}</span>
              </button>
            </div>
          </div>

          <div class="sheet-section">
            <div class="sheet-section-label">AI connection</div>
            <div class="sheet-menu-list">
              <button class="sheet-item" data-action="open-ai-settings">
                <span class="sheet-item-label">${icon('key', 'sm')} ${esc(renderAiStatusText())}</span>
                <span>${icon('next', 'sm')}</span>
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
                      Restore built-in starter decks to their default cards? Cards you added are kept.
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
                      <span class="sheet-item-label">${icon('reset', 'sm')} Restore built-in starter decks</span>
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
            <span class="sheet-title">Organize folders</span>
            <button class="sheet-close-btn" data-action="close-sheet" aria-label="Close">${icon('close', 'sm')}</button>
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
                      <div class="inline-confirm-box" style="background:var(--accent-soft);">
                        <div style="font-size:0.76rem;font-weight:700;color:var(--accent-text);">Rename "${esc(f.name)}"</div>
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
                          <button class="btn btn-secondary" data-action="cancel-rename-folder" style="padding:8px 12px;" aria-label="Cancel">
                            ${icon('close', 'sm')}
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
                        ${icon('folder', 'sm')}
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
                          ${icon('pencil', 'xs')} Rename
                        </button>
                        <button
                          class="hint-pill-btn"
                          style="color:var(--danger-text);"
                          data-action="delete-folder"
                          data-folder="${esc(f.name)}"
                          title="Remove folder"
                          aria-label="Remove folder"
                        >
                          ${icon('trash', 'xs')}
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

  // 3. "ADD / CREATE DECK" SHEET: AI generate, write your own, paste/upload, copy a prompt
  if (state.activeSheet === 'add-deck') {
    const promptPreview = AI_DECK_PROMPT_TEMPLATE(state.importTopicInput);

    return `
      <div class="sheet-backdrop" data-action="close-sheet">
        <div class="bottom-sheet" onclick="event.stopPropagation()">
          <div class="sheet-handle"></div>
          <div class="sheet-header">
            <span class="sheet-title">Add Custom Deck</span>
            <button class="sheet-close-btn" data-action="close-sheet" aria-label="Close">${icon('close', 'sm')}</button>
          </div>

          <div class="mode-segmented" role="tablist" style="--cols:4;">
            ${[
              ['generate', 'sparkle', 'AI'],
              ['write', 'pencil', 'Write'],
              ['paste', 'doc', 'Paste'],
              ['prompt', 'clipboard', 'Prompt']
            ]
              .map(
                ([tab, ic, label]) => `
                  <button class="mode-seg-btn ${state.addDeckTab === tab ? 'active' : ''}" data-action="switch-add-tab" data-tab="${tab}">
                    ${icon(ic, 'sm')}<span>${label}</span>
                  </button>`
              )
              .join('')}
          </div>

          ${renderAddDeckTabBody(folderStats, promptPreview)}
        </div>
      </div>
    `;
  }

  if (state.activeSheet === 'ai-settings') return renderAiSettingsSheet();
  if (state.activeSheet === 'deck-cards') return renderDeckCardsSheet();
  if (state.activeSheet === 'card-editor') return renderCardEditorSheet();

  // 4. DECK QUICK-CONTEXT SHEET (FROM HOME SCREEN `⋯` BUTTON)
  if (state.activeSheet === 'deck-context') {
    const deck = getDeckById(state.contextDeckId);
    if (!deck) return '';
    return renderDeckManagementSheetContent(deck, false);
  }

  // 5. FOCUSED STUDY OPTIONS SHEET (FROM STUDY HEADER OPTIONS BUTTON)
  if (state.activeSheet === 'study-options') {
    const deck = getActiveDeck();
    if (!deck) return '';
    return renderDeckManagementSheetContent(deck, true);
  }

  return '';
}

function renderFolderPicker(folderStats, label = 'Save to folder (optional)') {
  return `
    <div class="sheet-section">
      <div class="sheet-section-label">${label}</div>
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
                      <span>${esc(f.name)}</span>
                    </button>
                  `
                )
                .join('')}
            </div>`
          : ''
      }
    </div>
  `;
}

function renderAiStatusText() {
  if (!isAiConfigured(state.aiSettings)) return 'Connect Gemini, OpenRouter or a local model';
  const conn = getActiveConnection(state.aiSettings);
  return `${conn.label} · ${conn.model}`;
}

function renderAiSetupPrompt(returnSheet) {
  return `
    <div class="info-block" style="font-size:0.86rem;">
      <div class="info-block-label">Connect an AI model</div>
      Add your own API key for <strong>Gemini</strong> or <strong>OpenRouter</strong>, or point FieldGuide at any
      <strong>OpenAI-compatible</strong> server (Ollama, LM Studio, OpenAI, Groq…). Your key stays on this device.
    </div>
    <button class="btn btn-primary" data-action="open-ai-settings" data-return="${returnSheet}" style="width:100%;">
      ${icon('key', 'sm')} Set up AI connection
    </button>
  `;
}

function renderCountChips(action, current, values) {
  return `
    <div class="study-filter-strip">
      ${values
        .map(
          (n) => `
            <button type="button" class="filter-chip ${current === n ? 'active' : ''}" data-action="${action}" data-count="${n}">
              <span>${n} cards</span>
            </button>`
        )
        .join('')}
    </div>
  `;
}

function renderAddDeckTabBody(folderStats, promptPreview) {
  if (state.addDeckTab === 'generate') {
    if (!isAiConfigured(state.aiSettings)) return renderAiSetupPrompt('add-deck');
    return `
      <div class="sheet-section">
        <div class="sheet-section-label">Topic</div>
        <input
          type="text"
          id="ai-topic-input"
          class="form-input"
          placeholder="e.g. Australian Birds, Cloud Types, WWII Aircraft"
          value="${esc(state.importTopicInput)}"
          ${state.aiBusy ? 'disabled' : ''}
        />
      </div>

      <div class="sheet-section">
        <div class="sheet-section-label">How many cards</div>
        ${renderCountChips('set-ai-count', state.aiGenerateCount, [10, 20, 30])}
      </div>

      ${renderFolderPicker(folderStats)}

      <div class="ai-conn-line">
        <span>${icon('sparkle', 'xs')} ${esc(renderAiStatusText())}</span>
        <button class="hint-pill-btn" data-action="open-ai-settings" data-return="add-deck">Change</button>
      </div>

      <button class="btn btn-primary" data-action="generate-ai-deck" style="width:100%;" ${state.aiBusy ? 'disabled' : ''}>
        ${state.aiBusy ? 'Generating… this can take a minute' : `${icon('sparkle', 'sm')} Generate deck`}
      </button>
    `;
  }

  if (state.addDeckTab === 'write') {
    return `
      <div class="info-block" style="font-size:0.86rem;">
        <div class="info-block-label">Write your own</div>
        Name your deck, then type in each card. Add a photo from your device, an image link, or let FieldGuide find one on Wikipedia.
      </div>

      <div class="sheet-section">
        <div class="sheet-section-label">Deck name</div>
        <div style="display:flex;gap:8px;">
          <input
            type="text"
            id="manual-icon-input"
            class="form-input"
            style="width:64px;flex-shrink:0;text-align:center;"
            placeholder="📚"
            maxlength="4"
            aria-label="Deck emoji"
            value="${esc(state.manualDeckIcon)}"
          />
          <input
            type="text"
            id="manual-title-input"
            class="form-input"
            placeholder="e.g. Garden Weeds, Engine Parts, Spanish Verbs"
            value="${esc(state.manualDeckTitle)}"
          />
        </div>
      </div>

      ${renderFolderPicker(folderStats)}

      <button class="btn btn-primary" data-action="create-manual-deck" style="width:100%;">
        ${icon('plus', 'sm')} Create deck &amp; add first card
      </button>
    `;
  }

  if (state.addDeckTab === 'prompt') {
    return `<div class="info-block" style="font-size:0.8rem;">
        <div class="info-block-label">3-Step AI Deck Builder</div>
        1. Type any topic below &amp; tap <strong>Copy AI Prompt</strong>.<br/>
        2. Paste into ChatGPT, Claude, or Gemini.<br/>
        3. Copy the AI's reply and paste it in the <strong>Paste</strong> tab! (Wikipedia photos are resolved automatically.)
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
            ${icon('clipboard', 'sm')} Copy
          </button>
        </div>
      </div>

      <div class="sheet-section">
        <div class="sheet-section-label">Prompt Preview</div>
        <textarea
          id="prompt-preview-box"
          class="form-textarea"
          readonly
          style="min-height:140px;color:var(--text-sub);"
        >${esc(promptPreview)}</textarea>
      </div>

      <div class="dock-row">
        <button class="btn btn-primary" data-action="switch-add-tab" data-tab="paste" style="width:100%;">
          Go to paste box ${icon('next', 'sm')}
        </button>
      </div>`;
  }

  return `${renderFolderPicker(folderStats)}

      <div class="sheet-section">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span class="sheet-section-label">Paste AI Reply or JSON</span>
          <button class="hint-pill-btn" data-action="paste-clipboard">${icon('clipboard', 'xs')} Paste clipboard</button>
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
          Get AI prompt
        </button>
        <button class="btn btn-primary" data-action="submit-import-json" style="flex:1.3;">
          Create deck
        </button>
      </div>`;
}

function renderSheetFrame(title, body, { backAction = '' } = {}) {
  return `
    <div class="sheet-backdrop" data-action="close-sheet">
      <div class="bottom-sheet" onclick="event.stopPropagation()">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <span class="sheet-title" style="display:flex;align-items:center;gap:6px;min-width:0;">
            ${backAction ? `<button class="sheet-close-btn" ${backAction} aria-label="Back">${icon('back', 'sm')}</button>` : ''}
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${title}</span>
          </span>
          <button class="sheet-close-btn" data-action="close-sheet" aria-label="Close">${icon('close', 'sm')}</button>
        </div>
        ${body}
      </div>
    </div>
  `;
}

// --- AI CONNECTION SHEET ---
function renderAiSettingsSheet() {
  const draft = state.aiDraft || state.aiSettings;
  const providerId = draft.provider;
  const meta = AI_PROVIDERS[providerId];
  const conn = draft.providers[providerId];
  const busy = state.aiLoadingModels || state.aiTesting;

  const body = `
    <div class="sheet-section">
      <div class="sheet-section-label">Provider</div>
      <div class="mode-segmented" role="tablist">
        ${Object.entries(AI_PROVIDERS)
          .map(
            ([id, p]) => `
              <button class="mode-seg-btn ${providerId === id ? 'active' : ''}" data-action="set-ai-provider" data-provider="${id}">
                <span>${id === 'custom' ? 'Custom / local' : p.label}</span>
              </button>`
          )
          .join('')}
      </div>
    </div>

    ${
      providerId === 'custom'
        ? `<div class="sheet-section">
            <label class="sheet-section-label" for="ai-base-input">Server address (base URL)</label>
            <input
              type="url"
              id="ai-base-input"
              class="form-input"
              placeholder="http://localhost:11434/v1"
              value="${esc(conn.baseUrl)}"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
            />
            <div class="form-hint">
              Any server with an OpenAI-style <code>/chat/completions</code> endpoint. Examples:
              Ollama <code>http://localhost:11434/v1</code>, LM Studio <code>http://localhost:1234/v1</code>,
              OpenAI <code>https://api.openai.com/v1</code>. Local servers must allow this site via CORS
              (e.g. <code>OLLAMA_ORIGINS=*</code>).
            </div>
          </div>`
        : ''
    }

    <div class="sheet-section">
      <label class="sheet-section-label" for="ai-key-input">API key${meta.needsKey ? '' : ' (optional)'}</label>
      <input
        type="password"
        id="ai-key-input"
        class="form-input"
        placeholder="${meta.needsKey ? 'Paste your API key' : 'Leave blank if your server has no key'}"
        value="${esc(conn.apiKey)}"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
      <div class="form-hint">${esc(meta.keyHint)}. Stored only on this device and sent directly to ${esc(meta.label)}.</div>
    </div>

    <div class="sheet-section">
      <label class="sheet-section-label" for="ai-model-input">Model</label>
      <div style="display:flex;gap:8px;">
        <input
          type="text"
          id="ai-model-input"
          class="form-input"
          list="ai-model-list"
          placeholder="${esc(meta.defaultModel || 'e.g. llama3.1, qwen2.5, gpt-4o-mini')}"
          value="${esc(conn.model)}"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
        />
        <button class="btn btn-secondary" data-action="load-ai-models" style="white-space:nowrap;" ${busy ? 'disabled' : ''}>
          ${state.aiLoadingModels ? 'Loading…' : 'List models'}
        </button>
      </div>
      <datalist id="ai-model-list">
        ${state.aiModelOptions.map((m) => `<option value="${esc(m)}"></option>`).join('')}
      </datalist>
      ${
        state.aiModelOptions.length
          ? `<div class="form-hint">${state.aiModelOptions.length} models available — tap the box to pick one.</div>`
          : ''
      }
    </div>

    <div class="dock-row">
      <button class="btn btn-secondary" data-action="test-ai-connection" style="flex:1;" ${busy ? 'disabled' : ''}>
        ${state.aiTesting ? 'Testing…' : 'Test'}
      </button>
      <button class="btn btn-primary" data-action="save-ai-settings" style="flex:1.3;" ${busy ? 'disabled' : ''}>
        Save
      </button>
    </div>
  `;
  return renderSheetFrame(
    'AI connection',
    body,
    state.aiReturnSheet ? { backAction: `data-action="ai-settings-back"` } : {}
  );
}

// --- CARDS IN A DECK (ADD / EDIT / DELETE / GENERATE MORE) ---
function renderDeckCardsSheet() {
  const deck = getDeckById(state.cardsDeckId);
  if (!deck) return '';
  const pendingDelete = state.confirmAction?.startsWith('delete-card:') ? state.confirmAction.slice(12) : null;

  const aiSection = isAiConfigured(state.aiSettings)
    ? `
      <div class="sheet-section">
        <div class="sheet-section-label">Generate more with AI</div>
        ${renderCountChips('set-ai-more-count', state.aiMoreCount, [5, 10, 20])}
        <div style="display:flex;gap:8px;">
          <input
            type="text"
            id="ai-more-guidance"
            class="form-input"
            placeholder="Optional focus, e.g. 'only owls'"
            value="${esc(state.aiMoreGuidance)}"
            ${state.aiBusy ? 'disabled' : ''}
          />
          <button class="btn btn-primary" data-action="generate-more-cards" data-deck="${esc(deck.id)}" style="white-space:nowrap;" ${state.aiBusy ? 'disabled' : ''}>
            ${state.aiBusy ? 'Working…' : `${icon('sparkle', 'sm')} Add`}
          </button>
        </div>
      </div>`
    : `
      <div class="sheet-menu-list">
        <button class="sheet-item" data-action="open-ai-settings" data-return="deck-cards">
          <span class="sheet-item-label">${icon('sparkle', 'sm')} Connect an AI model to generate cards</span>
          <span>${icon('next', 'sm')}</span>
        </button>
      </div>`;

  const list = deck.cards.length
    ? deck.cards
        .map((card) => {
          if (pendingDelete === card.id) {
            return `
              <div class="inline-confirm-box">
                <div style="font-size:0.84rem;font-weight:650;color:var(--danger-text);">Delete "${esc(card.name)}"?</div>
                <div class="dock-row">
                  <button class="btn btn-secondary" data-action="cancel-confirm" style="flex:1;padding:9px;">Cancel</button>
                  <button class="btn btn-danger" data-action="delete-card" data-deck="${esc(deck.id)}" data-card="${esc(card.id)}" style="flex:1;padding:9px;">Delete</button>
                </div>
              </div>`;
          }
          return `
            <div class="card-row">
              <img class="card-row-thumb" src="${esc(getBestCardImageSrc(card, deck.color))}" alt="" loading="lazy" />
              <button class="card-row-text" data-action="edit-card" data-deck="${esc(deck.id)}" data-card="${esc(card.id)}">
                <b>${esc(card.name)}</b>
                <span>${esc(card.subtitle || card.badge || 'Tap to edit')}</span>
              </button>
              <button class="hint-pill-btn" data-action="edit-card" data-deck="${esc(deck.id)}" data-card="${esc(card.id)}" aria-label="Edit ${esc(card.name)}">
                ${icon('pencil', 'xs')}
              </button>
              <button class="hint-pill-btn" style="color:var(--danger-text);" data-action="ask-confirm" data-confirm="delete-card:${esc(card.id)}" aria-label="Delete ${esc(card.name)}">
                ${icon('trash', 'xs')}
              </button>
            </div>`;
        })
        .join('')
    : `<div class="info-block" style="font-size:0.86rem;">No cards yet. Add your first one above.</div>`;

  const body = `
    <button class="btn btn-primary" data-action="new-card" data-deck="${esc(deck.id)}" style="width:100%;">
      ${icon('plus', 'sm')} Write a new card
    </button>

    ${aiSection}

    <div class="sheet-section">
      <div class="sheet-section-label">Cards (${deck.cards.length})</div>
      <div class="sheet-menu-list">${list}</div>
    </div>

    <button class="btn btn-secondary" data-action="close-sheet" style="width:100%;">Done</button>
  `;
  return renderSheetFrame(`${esc(deck.icon || '🃏')} ${esc(deck.title)}`, body);
}

// --- CARD EDITOR ---
function renderCardEditorSheet() {
  const deck = getDeckById(state.editorDeckId);
  const d = state.editorDraft;
  if (!deck || !d) return '';
  const existing = state.editorCardId ? deck.cards.find((c) => c.id === state.editorCardId) : null;
  const previewSrc =
    state.editorPhotoPreview ||
    (existing && !state.editorRemovePhoto ? getBestCardImageSrc(existing, deck.color) : null) ||
    (isHttpUrl(d.imageUrl) ? d.imageUrl : null);

  const field = (id, label, value, placeholder, { textarea = false, type = 'text' } = {}) => `
    <div class="sheet-section">
      <label class="sheet-section-label" for="${id}">${label}</label>
      ${
        textarea
          ? `<textarea id="${id}" class="form-textarea form-textarea-plain" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
          : `<input type="${type}" id="${id}" class="form-input" placeholder="${esc(placeholder)}" value="${esc(value)}" />`
      }
    </div>`;

  const body = `
    <div class="sheet-section">
      <div class="sheet-section-label">Photo</div>
      <div class="card-photo-row">
        ${
          previewSrc
            ? `<img class="card-photo-preview" src="${esc(previewSrc)}" alt="Card photo preview" />`
            : `<div class="card-photo-preview empty">${icon('image')}</div>`
        }
        <div style="display:flex;flex-direction:column;gap:8px;flex:1;min-width:0;">
          <label class="btn btn-secondary card-photo-pick">
            ${icon('image', 'sm')} ${previewSrc ? 'Change photo' : 'Choose photo'}
            <input type="file" id="card-photo-input" accept="image/*" hidden />
          </label>
          ${
            state.editorPhotoBlob || (state.editorHasLocalPhoto && !state.editorRemovePhoto)
              ? `<button class="hint-pill-btn" data-action="remove-card-photo" style="align-self:flex-start;">${icon('trash', 'xs')} Remove photo</button>`
              : ''
          }
        </div>
      </div>
      <input
        type="url"
        id="card-image-url-input"
        class="form-input"
        placeholder="…or paste an image link (https://…)"
        value="${esc(d.imageUrl)}"
      />
      <label class="form-check">
        <input type="checkbox" id="card-auto-image" ${d.autoImage ? 'checked' : ''} />
        <span>If there's no photo, find one on Wikipedia</span>
      </label>
    </div>

    ${field('card-name-input', 'Name *', d.name, 'e.g. Laughing Kookaburra')}
    ${field('card-subtitle-input', 'Subtitle', d.subtitle, 'Scientific name, model, translation…')}
    ${field('card-badge-input', 'Group tag', d.badge, 'e.g. Kingfisher, Fighter, Verb')}
    ${field('card-features-input', 'Look for (key features)', d.keyFeatures, 'The clues that identify it', { textarea: true })}
    ${field('card-about-input', 'About', d.description, 'Background notes', { textarea: true })}
    ${field('card-link-input', 'Link', d.sourceUrl, 'https://en.wikipedia.org/wiki/…', { type: 'url' })}

    <div class="dock-row">
      ${
        existing
          ? `<button class="btn btn-secondary" data-action="open-deck-cards" data-deck="${esc(deck.id)}" style="flex:1;">Cancel</button>`
          : `<button class="btn btn-secondary" data-action="save-card" data-another="true" style="flex:1;">Save &amp; add another</button>`
      }
      <button class="btn btn-primary" data-action="save-card" style="flex:1.2;">${existing ? 'Save changes' : 'Save card'}</button>
    </div>
  `;
  return renderSheetFrame(existing ? 'Edit card' : `New card · ${esc(deck.title)}`, body, {
    backAction: `data-action="open-deck-cards" data-deck="${esc(deck.id)}"`
  });
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
          <button class="sheet-close-btn" data-action="close-sheet" aria-label="Close">${icon('close', 'sm')}</button>
        </div>

        ${
          includeModeSettings
            ? `<div class="sheet-section">
                <div class="sheet-section-label">Study mode</div>
                <div class="mode-segmented" role="tablist">
                  ${[
                    ['browse', 'Read'],
                    ['recall', 'Recall'],
                    ['quiz', 'Quiz']
                  ]
                    .map(
                      ([m, l]) => `<button class="mode-seg-btn ${state.studyMode === m ? 'active' : ''}" data-action="switch-mode" data-mode="${m}">${l}</button>`
                    )
                    .join('')}
                </div>
              </div>
              ${renderModeSpecificSettingsSection(counts)}`
            : !deck.cards.length
            ? `
              <div class="info-block" style="font-size:0.88rem;">
                <div class="info-block-label">No cards yet</div>
                Add a few cards to start studying this deck.
              </div>
              <button class="btn btn-primary" data-action="new-card" data-deck="${esc(deck.id)}" style="width:100%;">
                ${icon('plus', 'sm')} Write the first card
              </button>
            `
            : `
              <div class="mode-launch">
                ${[
                  ['browse', 'read', 'Read', 'Browse the photos and field notes'],
                  ['recall', 'recall', 'Recall', 'Reveal each card, then swipe to grade'],
                  ['quiz', 'quiz', 'Quiz', 'Multiple choice from photos and clues']
                ]
                  .map(
                    ([mode, ic, label, sub]) => `
                      <button class="mode-launch-btn" data-action="open-deck" data-deck="${esc(deck.id)}" data-mode="${mode}">
                        <span class="mode-launch-icon">${icon(ic)}</span>
                        <span class="mode-launch-text"><b>${label}</b><span>${sub}</span></span>
                      </button>`
                  )
                  .join('')}
              </div>
            `
        }

        <div class="sheet-section">
          <div class="sheet-section-label">Cards</div>
          <div class="sheet-menu-list">
            <button class="sheet-item" data-action="open-deck-cards" data-deck="${esc(deck.id)}">
              <span class="sheet-item-label">${icon('pencil', 'sm')} Add, edit or generate cards (${deck.cards.length})</span>
              <span>${icon('next', 'sm')}</span>
            </button>
          </div>
        </div>

        <div class="sheet-section">
          <div class="sheet-section-label">Folder</div>
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
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.name)}</span>
                    <span>${currentFolder === f.name ? icon('check', 'sm') : ''}</span>
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
                    ? `Saving offline (${esc(state.downloadProgressText)})…`
                    : `${icon('download', 'sm')} Save photos offline (${cachedCount}/${deck.cards.length})`
                }
              </span>
              <span style="color:var(--accent-text);font-size:0.85rem;">
                ${cachedCount >= deck.cards.length && deck.cards.length > 0 ? 'Saved' : 'Download'}
              </span>
            </button>

            <button class="sheet-item" data-action="export-deck" data-deck="${esc(deck.id)}">
              <span class="sheet-item-label">${icon('download', 'sm')} Export deck (.json)</span>
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
                    <span class="sheet-item-label">${icon('reset', 'sm')} Reset mastery progress</span>
                    <span></span>
                  </button>
                `
            }

            ${
              state.confirmAction === 'delete-deck'
                ? `
                  <div class="inline-confirm-box">
                    <div style="font-size:0.84rem;font-weight:650;color:var(--danger-text);">
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
                    <span class="sheet-item-label">${icon('trash', 'sm')} Delete deck</span>
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

function renderThemeSwitch() {
  return `
    <div class="mode-segmented" role="group" aria-label="Appearance">
      ${[
        ['system', 'auto', 'Auto'],
        ['light', 'sun', 'Light'],
        ['dark', 'moon', 'Dark']
      ]
        .map(
          ([val, ic, label]) => `
            <button class="mode-seg-btn ${state.theme === val ? 'active' : ''}" data-action="set-theme" data-theme-value="${val}" aria-pressed="${state.theme === val}">
              ${icon(ic, 'sm')}<span>${label}</span>
            </button>`
        )
        .join('')}
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
          <span class="sheet-item-label">${icon('fit', 'sm')} Fit full photo</span>
          <span>${state.imageFitContain ? icon('check', 'sm') : ''}</span>
        </button>
        <button
          class="sheet-pill-opt ${!state.imageFitContain ? 'active' : ''}"
          data-action="set-image-fit"
          data-contain="false"
        >
          <span class="sheet-item-label">${icon('crop', 'sm')} Crop to fill</span>
          <span>${!state.imageFitContain ? icon('check', 'sm') : ''}</span>
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
                  <span>${state.browseFilter === val ? icon('check', 'sm') : ''}</span>
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
            <span class="sheet-item-label">${icon('image', 'sm')} Photo first</span>
            <span>${state.recallPromptType === 'image-first' ? icon('check', 'sm') : ''}</span>
          </button>
          <button
            class="sheet-pill-opt ${state.recallPromptType === 'name-first' ? 'active' : ''}"
            data-action="set-recall-prompt"
            data-prompt="name-first"
            data-keep-sheet="true"
          >
            <span class="sheet-item-label">${icon('type', 'sm')} Name first</span>
            <span>${state.recallPromptType === 'name-first' ? icon('check', 'sm') : ''}</span>
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
            <span>${state.recallFilter === 'all' ? icon('check', 'sm') : ''}</span>
          </button>
          <button
            class="sheet-pill-opt ${state.recallFilter === 'unmastered' ? 'active' : ''}"
            data-action="set-recall-filter"
            data-filter="unmastered"
          >
            <span>Unmastered (${counts.all - counts.mastered})</span>
            <span>${state.recallFilter === 'unmastered' ? icon('check', 'sm') : ''}</span>
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
          ['mixed', 'dice', 'Mixed questions (recommended)'],
          ['photo-to-name', 'image', 'Photo to common name'],
          ['photo-to-sub', 'tag', 'Photo to scientific / model name'],
          ['clues-to-name', 'search', 'Field clues to common name']
        ]
          .map(
            ([val, ic, label]) => `
              <button
                class="sheet-item ${state.quizQuestionType === val ? 'active' : ''}"
                data-action="set-quiz-type"
                data-qtype="${val}"
              >
                <span class="sheet-item-label">${icon(ic, 'sm')} ${label}</span>
                <span>${state.quizQuestionType === val ? icon('check', 'sm') : ''}</span>
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
        <span class="lightbox-text" style="font-weight:700;font-size:1rem;">${esc(state.lightboxCaption)}</span>
        <button class="hint-pill-btn" data-action="close-lightbox" style="background:#fff;color:#0f1b2d;">Close</button>
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

// --- RECALL: DRAG THE REVEALED CARD RIGHT (GOT IT) OR LEFT (STILL LEARNING) ---
function attachRecallSwipe() {
  const card = document.getElementById('recall-answer');
  const shell = document.getElementById('recall-swipe');
  if (!card || !shell || state.studyMode !== 'recall') return;
  const stampAgain = document.getElementById('stamp-again');
  const stampGot = document.getElementById('stamp-got');
  const THRESHOLD = 90;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dragging = false;
  let locked = false;

  const paint = () => {
    card.style.transform = `translateX(${dx}px) rotate(${dx / 22}deg)`;
    const strength = Math.min(Math.abs(dx) / THRESHOLD, 1);
    stampGot.style.opacity = dx > 0 ? strength : 0;
    stampAgain.style.opacity = dx < 0 ? strength : 0;
  };

  shell.ontouchstart = (e) => {
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    dx = 0;
    dragging = true;
    locked = false;
    card.classList.remove('settling');
  };

  shell.ontouchmove = (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    const mx = t.clientX - startX;
    const my = t.clientY - startY;
    if (!locked) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      if (Math.abs(my) > Math.abs(mx)) {
        dragging = false;
        return;
      }
      locked = true;
    }
    dx = mx;
    paint();
  };

  const finish = () => {
    if (!dragging || !locked) {
      dragging = false;
      return;
    }
    dragging = false;
    if (Math.abs(dx) >= THRESHOLD) {
      const dir = dx > 0 ? 1 : -1;
      card.classList.add('flying');
      card.style.transform = `translateX(${dir * 420}px) rotate(${dir * 18}deg)`;
      setTimeout(() => gradeRecallCard(dir > 0 ? 'mastered' : 'learning'), 200);
    } else {
      card.classList.add('settling');
      dx = 0;
      paint();
    }
  };
  shell.ontouchend = finish;
  shell.ontouchcancel = finish;
}

// --- BOTTOM SHEETS: DRAG THE HANDLE DOWN TO DISMISS ---
function attachSheetDrag() {
  const sheet = appRoot.querySelector('.bottom-sheet');
  const grab = sheet?.querySelector('.sheet-handle');
  if (!sheet || !grab) return;
  let startY = 0;
  let dy = 0;
  grab.ontouchstart = (e) => {
    startY = e.touches[0].clientY;
    dy = 0;
    sheet.style.animation = 'none';
  };
  grab.ontouchmove = (e) => {
    dy = Math.max(0, e.touches[0].clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  };
  grab.ontouchend = () => {
    if (dy > 90) {
      state.activeSheet = null;
      state.confirmAction = null;
      render();
    } else {
      sheet.style.transition = 'transform 0.2s ease';
      sheet.style.transform = '';
    }
  };
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
        imgEl.src = createFallbackSvgDataUrl(card, deck?.color, { mystery: imgEl.dataset.mystery === 'true' });
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

  const manualTitleInput = document.getElementById('manual-title-input');
  if (manualTitleInput) {
    manualTitleInput.oninput = (e) => {
      state.manualDeckTitle = e.target.value;
    };
  }
  const manualIconInput = document.getElementById('manual-icon-input');
  if (manualIconInput) {
    manualIconInput.oninput = (e) => {
      state.manualDeckIcon = e.target.value;
    };
  }
  const moreGuidanceInput = document.getElementById('ai-more-guidance');
  if (moreGuidanceInput) {
    moreGuidanceInput.oninput = (e) => {
      state.aiMoreGuidance = e.target.value;
    };
  }

  // Card editor & AI connection fields write straight into their drafts so re-renders keep them
  if (state.activeSheet === 'card-editor') {
    for (const id of [
      'card-name-input',
      'card-subtitle-input',
      'card-badge-input',
      'card-features-input',
      'card-about-input',
      'card-link-input',
      'card-image-url-input',
      'card-auto-image'
    ]) {
      const el = document.getElementById(id);
      if (el) el.oninput = el.onchange = () => readEditorInputs();
    }
  }
  if (state.activeSheet === 'ai-settings' && state.aiDraft) {
    for (const id of ['ai-key-input', 'ai-model-input', 'ai-base-input']) {
      const el = document.getElementById(id);
      if (el) el.oninput = () => readAiDraftInputs();
    }
  }

  // Photo picked from the device in the card editor
  const cardPhotoInput = document.getElementById('card-photo-input');
  if (cardPhotoInput) {
    cardPhotoInput.onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        showToast('Pick an image file.');
        return;
      }
      readEditorInputs();
      const blob = await downscalePhoto(file);
      clearEditorPhoto();
      state.editorPhotoBlob = blob;
      state.editorPhotoPreview = URL.createObjectURL(blob);
      state.editorRemovePhoto = false;
      render();
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

  attachRecallSwipe();
  attachSheetDrag();

  appRoot.querySelectorAll('[data-action]').forEach((el) => {
    const action = el.dataset.action;
    el.onclick = async (e) => {
      e.stopPropagation();

      switch (action) {
        case 'set-theme':
          setTheme(el.dataset.themeValue || 'system');
          break;

        case 'practice-now':
          state.recallFilter = 'unmastered';
          openDeck(el.dataset.deck, 'recall');
          break;

        case 'toggle-home-search':
          state.homeSearchOpen = !state.homeSearchOpen;
          if (!state.homeSearchOpen) state.homeSearchQuery = '';
          render();
          if (state.homeSearchOpen) document.getElementById('home-search-input')?.focus();
          break;

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
          state.addDeckTab =
            el.dataset.tab === 'auto' ? (isAiConfigured(state.aiSettings) ? 'generate' : 'paste') : el.dataset.tab || 'paste';
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
          state.homeSearchOpen = false;
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

        // AI connection & generation
        case 'open-ai-settings':
          openAiSettings(el.dataset.return || null);
          break;

        case 'ai-settings-back':
          state.activeSheet = state.aiReturnSheet;
          state.aiReturnSheet = null;
          render();
          break;

        case 'set-ai-provider':
          readAiDraftInputs();
          state.aiDraft.provider = el.dataset.provider;
          state.aiModelOptions = [];
          render();
          break;

        case 'load-ai-models':
          loadAiModels();
          break;

        case 'test-ai-connection':
          runAiConnectionTest();
          break;

        case 'save-ai-settings':
          saveAiDraft();
          break;

        case 'set-ai-count':
          state.aiGenerateCount = Number(el.dataset.count) || 10;
          render();
          break;

        case 'set-ai-more-count':
          state.aiMoreCount = Number(el.dataset.count) || 10;
          render();
          break;

        case 'generate-ai-deck':
          generateDeckWithAi();
          break;

        case 'generate-more-cards':
          generateMoreCardsWithAi(el.dataset.deck);
          break;

        // Write your own decks & cards
        case 'create-manual-deck':
          createManualDeck();
          break;

        case 'open-deck-cards':
          clearEditorPhoto();
          state.editorDraft = null;
          openDeckCards(el.dataset.deck);
          break;

        case 'new-card':
          state.cardsDeckId = el.dataset.deck;
          openCardEditor(el.dataset.deck, null);
          break;

        case 'edit-card':
          state.cardsDeckId = el.dataset.deck;
          openCardEditor(el.dataset.deck, el.dataset.card);
          break;

        case 'save-card':
          saveEditorCard(el.dataset.another === 'true');
          break;

        case 'remove-card-photo':
          readEditorInputs();
          clearEditorPhoto();
          state.editorRemovePhoto = true;
          render();
          break;

        case 'delete-card':
          await deleteCardFromDeck(el.dataset.deck, el.dataset.card);
          break;

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
