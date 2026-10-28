// --- BRING-YOUR-OWN-KEY AI CONNECTIONS (Gemini, OpenRouter, any OpenAI-compatible server) ---
// Keys live only in this browser's localStorage and are sent straight to the chosen provider.

const AI_SETTINGS_KEY = 'fieldguide_ai_v1';
const REQUEST_TIMEOUT_MS = 180000;

export const AI_PROVIDERS = {
  gemini: {
    label: 'Gemini',
    needsKey: true,
    defaultModel: 'gemini-2.5-flash',
    keyHint: 'Create a free key at aistudio.google.com/apikey'
  },
  openrouter: {
    label: 'OpenRouter',
    needsKey: true,
    defaultModel: 'openrouter/auto',
    keyHint: 'Create a key at openrouter.ai/keys'
  },
  custom: {
    label: 'OpenAI-compatible',
    needsKey: false,
    defaultModel: '',
    defaultBaseUrl: 'http://localhost:11434/v1',
    keyHint: 'Optional for local servers (Ollama, LM Studio, llama.cpp). Required for OpenAI, Groq, Mistral, etc.'
  }
};

export function defaultAiSettings() {
  return {
    provider: 'gemini',
    providers: {
      gemini: { apiKey: '', model: AI_PROVIDERS.gemini.defaultModel },
      openrouter: { apiKey: '', model: AI_PROVIDERS.openrouter.defaultModel },
      custom: { apiKey: '', model: '', baseUrl: AI_PROVIDERS.custom.defaultBaseUrl }
    }
  };
}

export function loadAiSettings() {
  const base = defaultAiSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      if (AI_PROVIDERS[saved.provider]) base.provider = saved.provider;
      for (const id of Object.keys(base.providers)) {
        base.providers[id] = { ...base.providers[id], ...(saved.providers?.[id] || {}) };
      }
    }
  } catch (_) {}
  return base;
}

export function saveAiSettings(settings) {
  try {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) {}
}

export function getActiveConnection(settings) {
  const id = settings.provider;
  return { id, ...AI_PROVIDERS[id], ...settings.providers[id] };
}

export function isAiConfigured(settings) {
  const conn = getActiveConnection(settings);
  if (!conn.model?.trim()) return false;
  if (conn.needsKey && !conn.apiKey?.trim()) return false;
  if (conn.id === 'custom' && !conn.baseUrl?.trim()) return false;
  return true;
}

function cleanBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The request timed out.');
    throw new Error(
      'Could not reach the server. Check the address, your connection, and (for local servers) that CORS is enabled.'
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {}
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || data?.message || text.slice(0, 200) || res.statusText;
    throw new Error(`${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return data;
}

function chatEndpoint(conn) {
  if (conn.id === 'openrouter') return 'https://openrouter.ai/api/v1';
  return cleanBaseUrl(conn.baseUrl);
}

function chatHeaders(conn) {
  const headers = { 'Content-Type': 'application/json' };
  if (conn.apiKey?.trim()) headers.Authorization = `Bearer ${conn.apiKey.trim()}`;
  if (conn.id === 'openrouter') {
    headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = 'FieldGuide';
  }
  return headers;
}

/** Sends one prompt to the active provider and returns the reply text. */
export async function completeText(settings, { system, prompt, json = false }) {
  const conn = getActiveConnection(settings);
  if (!isAiConfigured(settings)) throw new Error('Set up an AI connection first.');

  if (conn.id === 'gemini') {
    const model = conn.model.trim().replace(/^models\//, '');
    const data = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': conn.apiKey.trim() },
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, ...(json ? { responseMimeType: 'application/json' } : {}) }
        })
      }
    );
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts
      .filter((p) => !p.thought)
      .map((p) => p.text || '')
      .join('');
    if (!text) {
      const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
      throw new Error(reason ? `No reply (${reason}).` : 'The model returned an empty reply.');
    }
    return text;
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const data = await fetchJson(`${chatEndpoint(conn)}/chat/completions`, {
    method: 'POST',
    headers: chatHeaders(conn),
    body: JSON.stringify({ model: conn.model.trim(), messages, temperature: 0.7 })
  });
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('The model returned an empty reply.');
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** Lists model ids available for the active connection (for the model picker). */
export async function listModels(settings) {
  const conn = getActiveConnection(settings);
  if (conn.id === 'gemini') {
    if (!conn.apiKey?.trim()) throw new Error('Enter your API key first.');
    const data = await fetchJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
      headers: { 'x-goog-api-key': conn.apiKey.trim() }
    });
    return (data?.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter(Boolean);
  }
  if (conn.id === 'custom' && !conn.baseUrl?.trim()) throw new Error('Enter the server address first.');
  const data = await fetchJson(`${chatEndpoint(conn)}/models`, { headers: chatHeaders(conn) });
  return (data?.data || data?.models || [])
    .map((m) => (typeof m === 'string' ? m : m.id || m.name))
    .filter(Boolean)
    .sort();
}

/** Pulls the JSON payload out of a reply that may be wrapped in prose or code fences. */
export function extractJsonText(reply) {
  const text = String(reply || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  if (body.startsWith('{') || body.startsWith('[')) return body;
  const first = Math.min(...['{', '['].map((ch) => body.indexOf(ch)).filter((i) => i >= 0));
  const last = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (Number.isFinite(first) && last > first) return body.slice(first, last + 1);
  return body;
}

const DECK_SYSTEM_PROMPT = `You build visual identification flashcards for a study app. Reply with JSON only — no prose, no markdown.
Every card must be a real, distinct, recognisable thing that has its own English Wikipedia article with a photo, because the app downloads the lead image from that article.
Card fields:
- "name": common name
- "subtitle": scientific name, model designation or secondary title
- "badge": short group / family / category tag (1-3 words)
- "keyFeatures": the visual traits or clues that tell it apart from similar items (one sentence)
- "description": 2-3 sentences of interesting background
- "sourceUrl": the exact English Wikipedia URL, e.g. https://en.wikipedia.org/wiki/Peregrine_falcon`;

export function buildNewDeckPrompt(topic, count) {
  return `Create a deck of ${count} cards about: "${topic}".
Return one JSON object with this shape:
{"title": "...", "category": "short folder name", "icon": "one emoji", "color": "#hex accent colour", "description": "one sentence", "cards": [{"name": "...", "subtitle": "...", "badge": "...", "keyFeatures": "...", "description": "...", "sourceUrl": "..."}]}`;
}

export function buildMoreCardsPrompt(deck, count, guidance = '') {
  const existing = (deck.cards || []).map((c) => c.name).filter(Boolean);
  return `I already have a deck titled "${deck.title}"${deck.description ? ` (${deck.description})` : ''}.
Add ${count} NEW cards that fit this deck.${guidance ? ` Focus on: ${guidance}.` : ''}
Do NOT repeat any of these existing cards: ${existing.length ? existing.join('; ') : '(none yet)'}.
Return a JSON object: {"cards": [{"name": "...", "subtitle": "...", "badge": "...", "keyFeatures": "...", "description": "...", "sourceUrl": "..."}]}`;
}

export async function generateDeckJson(settings, topic, count) {
  const reply = await completeText(settings, {
    system: DECK_SYSTEM_PROMPT,
    prompt: buildNewDeckPrompt(topic, count),
    json: true
  });
  return extractJsonText(reply);
}

export async function generateMoreCardsJson(settings, deck, count, guidance) {
  const reply = await completeText(settings, {
    system: DECK_SYSTEM_PROMPT,
    prompt: buildMoreCardsPrompt(deck, count, guidance),
    json: true
  });
  return extractJsonText(reply);
}

export async function testConnection(settings) {
  const reply = await completeText(settings, { prompt: 'Reply with the single word: OK' });
  return reply.trim().slice(0, 60);
}
