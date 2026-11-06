'use strict';

// ---------- Basis ----------

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat', 'fiber'];
const NUTRIENT_LABELS = { kcal: 'kcal', protein: 'eiwit', carbs: 'koolh.', fat: 'vet', fiber: 'vezels' };
const MEALS = ['Ontbijt', 'Lunch', 'Diner', 'Tussendoor'];
const GEMINI_FALLBACKS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];

const DEFAULT_SETTINGS = {
  provider: 'gemini',
  geminiKey: '',
  geminiModel: 'gemini-3.6-flash',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'gemma3:4b',
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    toast('Opslaan in de browser lukt niet');
  }
}

// Gedeeld door alle profielen: welke AI-dienst en API-key.
let settings = { ...DEFAULT_SETTINGS, ...load('eetmeter.settings', {}) };

// Ieder profiel heeft eigen antwoorden, doelen, daglog en advies.
let profiles; // { active, list: [ { id, name, answers, goalKcal, goalProtein } ] }
let log = {}; // { 'YYYY-MM-DD': [ { id, meal, time, items: [...], advice } ] }
let dayAdvice = {}; // { 'YYYY-MM-DD': advies }

const profile = () => profiles.list.find((p) => p.id === profiles.active);
const logKey = () => `eetmeter.log.${profiles.active}`;
const adviceKey = () => `eetmeter.dayAdvice.${profiles.active}`;

function initProfiles() {
  profiles = load('eetmeter.profiles', null);
  if (!profiles?.list?.length) {
    // Eerste keer met profielen: gegevens van vóór de profielen naar een eerste profiel verhuizen.
    // De oude sleutels blijven staan als reservekopie.
    const id = uid();
    const oldLog = load('eetmeter.log', null);
    profiles = {
      active: id,
      list: [{ id, name: oldLog ? 'Mijn profiel' : '', answers: null, goalKcal: settings.goalKcal || 2000, goalProtein: settings.goalProtein || 0 }],
    };
    if (oldLog) {
      save(`eetmeter.log.${id}`, oldLog);
      save(`eetmeter.dayAdvice.${id}`, load('eetmeter.dayAdvice', {}));
    }
    save('eetmeter.profiles', profiles);
  }
  if (!profile()) profiles.active = profiles.list[0].id;
  loadProfileData();
}
function loadProfileData() {
  log = load(logKey(), {});
  dayAdvice = load(adviceKey(), {});
}
function switchProfile(id) {
  profiles.active = id;
  save('eetmeter.profiles', profiles);
  state.draft = null;
  loadProfileData();
}

const state = {
  date: todayKey(),
  view: 'today',
  // Maaltijd die nog wordt samengesteld/gecontroleerd voordat hij wordt opgeslagen.
  draft: null, // { items, entryId, note }
  photo: null, // { data, mime }
  scanner: null,
};

function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function shiftDate(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return todayKey(new Date(y, m - 1, d + days));
}
function dateLabel(key) {
  if (key === todayKey()) return 'Vandaag';
  if (key === shiftDate(todayKey(), -1)) return 'Gisteren';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
}
function defaultMeal() {
  const h = new Date().getHours();
  if (h < 10) return 'Ontbijt';
  if (h < 14) return 'Lunch';
  if (h >= 17 && h < 21) return 'Diner';
  return 'Tussendoor';
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const round = (n) => Math.round(Number(n) || 0);
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function makeItem({ name, grams, per100, nutriscore }) {
  const p = {};
  for (const k of NUTRIENTS) p[k] = num(per100?.[k]);
  const item = { name: String(name || 'Onbekend'), grams: num(grams) || 100, per100: p };
  if (/^[a-e]$/.test(nutriscore || '')) item.nutriscore = nutriscore;
  return item;
}
// Nutri-Score-label (A t/m E) van Open Food Facts, alleen bij producten met barcode.
const nutriBadge = (it) => it.nutriscore
  ? `<span class="ns ns-${it.nutriscore}" title="Nutri-Score ${it.nutriscore.toUpperCase()}">${it.nutriscore.toUpperCase()}</span>`
  : '';
function itemTotals(item) {
  const t = {};
  for (const k of NUTRIENTS) t[k] = (item.per100[k] * item.grams) / 100;
  return t;
}
function sumItems(items) {
  const t = Object.fromEntries(NUTRIENTS.map((k) => [k, 0]));
  for (const it of items) {
    const it_t = itemTotals(it);
    for (const k of NUTRIENTS) t[k] += it_t[k];
  }
  return t;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}
function setStatus(id, msg, kind = '') {
  const el = $(id);
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

// ---------- Navigatie ----------

function show(view) {
  if (state.view === 'barcode' && view !== 'barcode') stopScanner();
  state.view = view;
  $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + view));
  const tab = ['add', 'photo', 'describe', 'barcode', 'search', 'review'].includes(view) ? 'add'
    : view === 'profile' ? 'settings' : view;
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.go === tab));

  const titles = {
    add: 'Toevoegen', photo: 'Foto', describe: 'Beschrijven', barcode: 'Barcode',
    search: 'Zoeken', review: 'Controleren', settings: 'Instellingen', profile: 'Profiel',
  };
  const isDayView = view === 'today';
  $('#day-label').textContent = isDayView ? dateLabel(state.date) : titles[view];
  $('#day-prev').style.visibility = isDayView ? 'visible' : 'hidden';
  $('#day-next').style.visibility = isDayView ? 'visible' : 'hidden';

  if (view === 'today') renderToday();
  if (view === 'add') renderAdd();
  if (view === 'review') renderReview();
  if (view === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) show(go.dataset.go);
});
$('#day-prev').onclick = () => { state.date = shiftDate(state.date, -1); show('today'); };
$('#day-next').onclick = () => { state.date = shiftDate(state.date, 1); show('today'); };

// ---------- Vandaag ----------

function renderToday() {
  const entries = log[state.date] || [];
  const all = entries.flatMap((e) => e.items);
  const t = sumItems(all);

  $('#tot-kcal').textContent = round(t.kcal);
  $('#goal-kcal').textContent = profile().goalKcal;
  for (const k of ['protein', 'carbs', 'fat', 'fiber']) $('#tot-' + k).textContent = round(t[k]);
  if (profile().goalProtein) $('#tot-protein').textContent = `${round(t.protein)}/${profile().goalProtein}`;
  const pct = profile().goalKcal ? (t.kcal / profile().goalKcal) * 100 : 0;
  $('#kcal-bar').style.width = Math.min(pct, 100) + '%';
  $('#kcal-bar').classList.toggle('over', pct > 100);
  $('#day-next').disabled = state.date >= todayKey();
  renderProfileSwitch();

  const sorted = [...entries].sort((a, b) => MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal) || a.time.localeCompare(b.time));
  $('#meals').innerHTML = sorted.map((e) => {
    const et = sumItems(e.items);
    const advice = e.advice && e.advice.sig === itemsSig(e.items) ? e.advice : null;
    return `<div class="card meal">
      <div class="meal-head" data-entry="${e.id}">
        <b>${esc(e.meal)} <span class="muted small">${esc(e.time)}</span></b>
        <span class="muted">${advice ? `<span class="rating-pill ${ratingClass(advice.rating)}">${RATINGS[advice.rating]}</span>` : ''}${round(et.kcal)} kcal ›</span>
      </div>
      ${e.items.map((it) => `<div class="meal-item">
        <span>${nutriBadge(it)}${esc(it.name)}</span>
        <span class="num">${round(it.grams)} g · ${round(itemTotals(it).kcal)} kcal</span>
      </div>`).join('')}
    </div>`;
  }).join('');
  $('#today-empty').hidden = entries.length > 0;
  renderDayAdvice();
}

$('#meals').addEventListener('click', (e) => {
  const head = e.target.closest('[data-entry]');
  if (!head) return;
  const entry = (log[state.date] || []).find((x) => x.id === head.dataset.entry);
  if (!entry) return;
  state.draft = {
    items: entry.items.map((it) => makeItem(it)), entryId: entry.id, meal: entry.meal, note: '', advice: entry.advice || null,
  };
  show('review');
});

// ---------- Toevoegen ----------

function recentItems() {
  const seen = new Map();
  const days = Object.keys(log).sort().reverse().slice(0, 30);
  for (const d of days) {
    for (const e of log[d]) {
      for (const it of e.items) {
        const key = it.name.toLowerCase();
        if (!seen.has(key)) seen.set(key, it);
      }
    }
  }
  return [...seen.values()].slice(0, 15);
}

function renderAdd() {
  $('#draft-banner').hidden = !state.draft;
  if (state.draft) $('#draft-count').textContent = state.draft.items.length;
  const recent = recentItems();
  $('#recent-title').hidden = recent.length === 0;
  $('#recent').innerHTML = recent.map((it, i) =>
    `<button class="chip" data-recent="${i}">${esc(it.name)} · ${round(it.grams)} g</button>`).join('');
  $('#recent').onclick = (e) => {
    const b = e.target.closest('[data-recent]');
    if (b) addToDraft([makeItem(recent[Number(b.dataset.recent)])]);
  };
}

function addToDraft(items, note = '') {
  if (!state.draft) state.draft = { items: [], entryId: null, meal: defaultMeal(), note: '', advice: null };
  state.draft.items.push(...items);
  if (note) state.draft.note = note;
  show('review');
}

$('#add-manual').onclick = () => addToDraft([makeItem({ name: '', grams: 100, per100: {} })]);

// ---------- Controleren ----------

function renderReview() {
  const d = state.draft;
  if (!d) return show('add');
  setStatus('#review-advice-status', '');
  $('#review-note').textContent = d.note || '';
  $('#review-meal').value = d.meal;
  $('#review-delete').hidden = !d.entryId;
  $('#review-items').innerHTML = d.items.map((it, i) => `
    <div class="card item" data-i="${i}">
      <div class="item-top">
        <input class="name" data-f="name" value="${esc(it.name)}" placeholder="Naam" aria-label="Naam">
        <input class="grams" data-f="grams" type="text" inputmode="decimal" value="${round(it.grams)}" aria-label="Gram">
        <span class="unit">g</span>
        <button class="del" data-del="${i}" aria-label="Verwijderen">×</button>
      </div>
      <div class="item-sum"><span>${nutriBadge(it)}<span class="item-kcal"></span></span>
        <button class="link small" data-toggle="${i}">per 100 g aanpassen</button></div>
      <div class="per100" hidden>
        ${NUTRIENTS.map((k) => `<label>${NUTRIENT_LABELS[k]}
          <input data-f="${k}" type="text" inputmode="decimal" value="${+it.per100[k].toFixed(1)}"></label>`).join('')}
      </div>
    </div>`).join('');
  // Handmatig toegevoegde items direct openklappen
  $$('#review-items .item').forEach((el, i) => {
    if (!d.items[i].name) el.querySelector('.per100').hidden = false;
  });
  updateReviewTotals();
}

function updateReviewTotals() {
  const d = state.draft;
  $$('#review-items .item').forEach((el, i) => {
    const t = itemTotals(d.items[i]);
    el.querySelector('.item-kcal').textContent =
      `${round(t.kcal)} kcal · E ${round(t.protein)} · K ${round(t.carbs)} · V ${round(t.fat)}`;
  });
  const t = sumItems(d.items);
  $('#review-kcal').textContent = round(t.kcal);
  $('#review-macros').textContent =
    `eiwit ${round(t.protein)} g · koolhydraten ${round(t.carbs)} g · vet ${round(t.fat)} g · vezels ${round(t.fiber)} g`;
  $('#review-save').disabled = d.items.length === 0;
  renderReviewAdvice();
}

$('#review-items').addEventListener('input', (e) => {
  const f = e.target.dataset.f;
  const card = e.target.closest('[data-i]');
  if (!f || !card) return;
  const it = state.draft.items[Number(card.dataset.i)];
  if (f === 'name') it.name = e.target.value;
  else if (f === 'grams') it.grams = num(e.target.value);
  else it.per100[f] = num(e.target.value);
  updateReviewTotals();
});
$('#review-items').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    state.draft.items.splice(Number(del.dataset.del), 1);
    renderReview();
    return;
  }
  const tg = e.target.closest('[data-toggle]');
  if (tg) {
    const p = tg.closest('.item').querySelector('.per100');
    p.hidden = !p.hidden;
  }
});
$('#review-meal').onchange = (e) => (state.draft.meal = e.target.value);

$('#review-cancel').onclick = () => {
  state.draft = null;
  show('today');
};
$('#review-save').onclick = () => {
  const d = state.draft;
  const items = d.items.map((it) => ({ ...it, name: it.name.trim() || 'Onbekend' }));
  const advice = d.advice && d.advice.sig === itemsSig(items) ? d.advice : null;
  const day = (log[state.date] ||= []);
  if (d.entryId) {
    const entry = day.find((x) => x.id === d.entryId);
    if (entry) Object.assign(entry, { meal: d.meal, items, advice });
  } else {
    const time = new Date().toTimeString().slice(0, 5);
    day.push({ id: uid(), meal: d.meal, time, items, advice });
  }
  save(logKey(), log);
  state.draft = null;
  toast('Opgeslagen');
  show('today');
};
$('#review-delete').onclick = () => {
  if (!confirm('Deze maaltijd verwijderen?')) return;
  log[state.date] = (log[state.date] || []).filter((x) => x.id !== state.draft.entryId);
  if (!log[state.date].length) delete log[state.date];
  save(logKey(), log);
  state.draft = null;
  show('today');
};

// ---------- AI: foto / beschrijving ----------

const AI_PROMPT = `Je bent een voedingsdeskundige. Bepaal wat de gebruiker eet en schat per onderdeel:
- een korte Nederlandse naam (bijv. "witte rijst, gekookt", "kipfilet, gebakken")
- het gewicht in gram van wat er daadwerkelijk gegeten wordt
- de voedingswaarde per 100 gram: kcal, eiwit, koolhydraten, vet en vezels (gram)
Splits een gerecht op in losse onderdelen. Denk aan verborgen calorieën zoals bakolie, boter en sauzen
en neem die als apart onderdeel op als ze waarschijnlijk aanwezig zijn. Gebruik voedingswaardes zoals in de
Nederlandse NEVO-tabel. Schat porties op basis van bordgrootte, bestek en verpakkingen in beeld.
Geef in "note" in één korte zin aan waar je onzeker over bent. Is er geen eten te zien, geef dan een lege lijst.`;

const AI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          grams: { type: 'NUMBER' },
          kcal_per_100g: { type: 'NUMBER' },
          protein_per_100g: { type: 'NUMBER' },
          carbs_per_100g: { type: 'NUMBER' },
          fat_per_100g: { type: 'NUMBER' },
          fiber_per_100g: { type: 'NUMBER' },
        },
        required: ['name', 'grams', 'kcal_per_100g', 'protein_per_100g', 'carbs_per_100g', 'fat_per_100g', 'fiber_per_100g'],
      },
    },
    note: { type: 'STRING' },
  },
  required: ['items'],
};

function aiResultToItems(result) {
  return (result.items || []).map((x) => makeItem({
    name: x.name,
    grams: x.grams,
    per100: {
      kcal: x.kcal_per_100g, protein: x.protein_per_100g, carbs: x.carbs_per_100g,
      fat: x.fat_per_100g, fiber: x.fiber_per_100g,
    },
  }));
}

async function analyze({ image, text }) {
  const prompt = AI_PROMPT + (text ? `\n\nInformatie van de gebruiker: ${text}` : '');
  return askAI(prompt, AI_SCHEMA, image);
}

function askAI(prompt, schema, image = null) {
  return settings.provider === 'ollama' ? callOllama(prompt, schema, image) : callGemini(prompt, schema, image);
}

async function callGemini(prompt, schema, image) {
  if (!settings.geminiKey) throw new Error('Vul eerst je Gemini API-key in bij Instellingen.');
  const parts = [{ text: prompt }];
  if (image) parts.push({ inline_data: { mime_type: image.mime, data: image.data } });
  const body = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 },
  });

  // Gekozen model eerst; bij een limiet of onbekend model de volgende proberen.
  const models = [settings.geminiModel, ...GEMINI_FALLBACKS.filter((m) => m !== settings.geminiModel)];
  let lastError;
  for (const model of models) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.geminiKey },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const out = (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
      if (!out) throw new Error('Gemini gaf geen antwoord terug. Probeer het nog eens.');
      return JSON.parse(out);
    }
    const msg = data.error?.message || res.statusText;
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error(/api key/i.test(msg) ? 'De API-key klopt niet. Controleer hem bij Instellingen.' : 'Gemini: ' + msg);
    }
    lastError = res.status === 429
      ? 'De gratis limiet van Gemini is even bereikt. Probeer het over een minuut opnieuw.'
      : 'Gemini: ' + msg;
    if (![404, 429, 500, 503].includes(res.status)) break;
  }
  throw new Error(lastError);
}

async function callOllama(prompt, schema, image) {
  const res = await fetch(settings.ollamaUrl.replace(/\/$/, '') + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.ollamaModel,
      stream: false,
      // Ollama verwacht standaard JSON-schema (kleine letters voor de types).
      format: JSON.parse(JSON.stringify(schema).toLowerCase()),
      options: { temperature: 0.2 },
      messages: [{ role: 'user', content: prompt, ...(image ? { images: [image.data] } : {}) }],
    }),
  }).catch(() => {
    throw new Error('Ollama is niet bereikbaar. Staat het aan, en is OLLAMA_ORIGINS ingesteld?');
  });
  if (!res.ok) throw new Error('Ollama: ' + (await res.text()));
  const data = await res.json();
  return JSON.parse(data.message?.content || '{}');
}

// ---------- Advies ----------

const ADVICE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    rating: { type: 'STRING' },
    summary: { type: 'STRING' },
    positives: { type: 'ARRAY', items: { type: 'STRING' } },
    tips: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { instead_of: { type: 'STRING' }, try: { type: 'STRING' }, why: { type: 'STRING' } },
        required: ['instead_of', 'try', 'why'],
      },
    },
  },
  required: ['rating', 'summary', 'tips'],
};
const RATINGS = { goed: 'Goed', redelijk: 'Redelijk', 'kan beter': 'Kan beter' };

function advicePrompt(subject, items, extra = '') {
  const t = sumItems(items);
  const lines = items.map((it) => {
    const it_t = itemTotals(it);
    return `- ${it.name}, ${round(it.grams)} g: ${round(it_t.kcal)} kcal, eiwit ${round(it_t.protein)} g, `
      + `koolhydraten ${round(it_t.carbs)} g, vet ${round(it_t.fat)} g, vezels ${round(it_t.fiber)} g`
      + (it.nutriscore ? `, Nutri-Score ${it.nutriscore.toUpperCase()}` : '');
  }).join('\n');
  const goals = `Dagdoel: ${profile().goalKcal} kcal` + (profile().goalProtein ? `, ${profile().goalProtein} g eiwit` : '') + '.'
    + (profile().answers ? ` ${goalDescription(profile().answers)}` : '');
  return `Je bent een vriendelijke, praktische voedingscoach die werkt volgens de Schijf van Vijf van het Voedingscentrum.
Beoordeel ${subject}. ${goals} ${extra}

Gegeten:
${lines}
Totaal: ${round(t.kcal)} kcal, eiwit ${round(t.protein)} g, koolhydraten ${round(t.carbs)} g, vet ${round(t.fat)} g, vezels ${round(t.fiber)} g.

Geef:
- rating: precies één van "goed", "redelijk" of "kan beter"
- summary: één of twee korte zinnen met je oordeel
- positives: maximaal 2 korte punten die goed zijn
- tips: 1 tot 3 concrete verbeteringen. "instead_of" is wat er nu gegeten wordt, "try" is een concreet alternatief
  met hoeveelheid dat in een Nederlandse supermarkt te koop is (bijv. "2 sneetjes volkorenbrood"),
  "why" zegt in een paar woorden wat het oplevert (bijv. meer vezels, minder verzadigd vet, minder suiker, langer verzadigd).
Regels: wees positief en motiverend, nooit veroordelend. Raad nooit maaltijden overslaan, crashdiëten of extreem
weinig eten aan. Is het al goed, geef dan hooguit één kleine tip. Geef geen medisch advies. Schrijf in het Nederlands.`;
}

async function getAdvice(subject, items, extra) {
  const a = await askAI(advicePrompt(subject, items, extra), ADVICE_SCHEMA);
  const rating = String(a.rating || '').toLowerCase().trim();
  return {
    rating: RATINGS[rating] ? rating : 'redelijk',
    summary: String(a.summary || ''),
    positives: (a.positives || []).slice(0, 2).map(String),
    tips: (a.tips || []).filter((t) => t && t.try).slice(0, 3),
    sig: itemsSig(items),
  };
}

// Handtekening van de items, zodat we zien of opgeslagen advies nog bij de maaltijd past.
const itemsSig = (items) => items.map((it) => `${it.name.trim()}|${round(it.grams)}`).join(';');
const ratingClass = (r) => 'rating-' + r.replace(' ', '-');

function adviceHTML(a) {
  return `<div class="card advice ${ratingClass(a.rating)}">
    <div class="advice-head"><span class="rating">${RATINGS[a.rating]}</span><span>${esc(a.summary)}</span></div>
    ${a.positives.length ? `<ul class="positives">${a.positives.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    ${a.tips.map((t) => `<div class="tip">
      <div><span class="muted">In plaats van</span> ${esc(t.instead_of)}</div>
      <div class="tip-try">→ ${esc(t.try)}</div>
      <div class="muted small">${esc(t.why)}</div>
    </div>`).join('')}
    <p class="muted small">Algemeen advies op basis van de Schijf van Vijf, geen vervanging van een diëtist.</p>
  </div>`;
}

async function runAdvice(btn, statusId, fetchAdvice) {
  btn.disabled = true;
  setStatus(statusId, 'Advies ophalen…', 'busy');
  try {
    await fetchAdvice();
    setStatus(statusId, '');
  } catch (err) {
    setStatus(statusId, err.message === 'Failed to fetch' ? 'Geen verbinding.' : err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function renderReviewAdvice() {
  const d = state.draft;
  const fresh = d.advice && d.advice.sig === itemsSig(d.items);
  $('#review-advice').innerHTML = fresh ? adviceHTML(d.advice) : '';
  $('#review-advise').textContent = fresh ? 'Advies vernieuwen' : 'Advies over deze maaltijd';
  $('#review-advise').disabled = d.items.length === 0;
}

$('#review-advise').onclick = () => runAdvice($('#review-advise'), '#review-advice-status', async () => {
  const d = state.draft;
  d.advice = await getAdvice(`deze maaltijd (${d.meal.toLowerCase()})`, d.items);
  renderReviewAdvice();
});


function dayItems(date) {
  // Maaltijd in de naam, zodat het advies weet wat bij ontbijt, lunch enz. hoort.
  return (log[date] || []).flatMap((e) => e.items.map((it) => ({ ...it, name: `${e.meal}: ${it.name}` })));
}

function renderDayAdvice() {
  const items = dayItems(state.date);
  const a = dayAdvice[state.date];
  const fresh = a && a.sig === itemsSig(items);
  $('#day-advice').innerHTML = fresh ? adviceHTML(a) : '';
  $('#day-advise').hidden = items.length === 0;
  $('#day-advise').textContent = fresh ? 'Advies vernieuwen' : 'Advies over deze dag';
}

$('#day-advise').onclick = () => runAdvice($('#day-advise'), '#day-advice-status', async () => {
  const isToday = state.date === todayKey();
  const extra = isToday
    ? `Het is nu ${new Date().toTimeString().slice(0, 5)}, er kunnen vandaag nog maaltijden volgen. `
      + 'Geef als dat past ook een tip voor de volgende maaltijd, rekening houdend met wat er nog over is van het dagdoel.'
    : 'Dit is een afgelopen dag; geef tips voor een volgende keer.';
  dayAdvice[state.date] = await getAdvice(isToday ? 'wat er vandaag tot nu toe gegeten is' : 'wat er deze dag gegeten is', dayItems(state.date), extra);
  save(adviceKey(), dayAdvice);
  renderDayAdvice();
});

// Foto verkleinen zodat hij snel verstuurd wordt (en minder van je gratis limiet kost).
function resizeImage(file, max = 1024) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const dataUrl = c.toDataURL('image/jpeg', 0.82);
      resolve({ data: dataUrl.split(',')[1], mime: 'image/jpeg', dataUrl });
    };
    img.onerror = () => reject(new Error('Kon de foto niet lezen.'));
    img.src = url;
  });
}

async function onPhotoChosen(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    state.photo = await resizeImage(file);
    $('#photo-preview').src = state.photo.dataUrl;
    $('#photo-preview').hidden = false;
    $('#photo-analyze').disabled = false;
    setStatus('#photo-status', '');
  } catch (err) {
    setStatus('#photo-status', err.message, 'error');
  }
}
$('#photo-camera').onchange = onPhotoChosen;
$('#photo-gallery').onchange = onPhotoChosen;

$('#photo-analyze').onclick = async () => {
  const btn = $('#photo-analyze');
  btn.disabled = true;
  setStatus('#photo-status', 'Foto wordt geanalyseerd…', 'busy');
  try {
    const result = await analyze({ image: state.photo, text: $('#photo-note').value.trim() });
    const items = aiResultToItems(result);
    if (!items.length) throw new Error('Geen eten herkend op de foto. Probeer een andere foto of beschrijf het.');
    setStatus('#photo-status', '');
    state.photo = null;
    $('#photo-preview').hidden = true;
    $('#photo-note').value = '';
    addToDraft(items, result.note ? 'AI: ' + result.note : '');
  } catch (err) {
    setStatus('#photo-status', err.message, 'error');
    btn.disabled = false;
  }
};

$('#describe-analyze').onclick = async () => {
  const text = $('#describe-text').value.trim();
  if (!text) return setStatus('#describe-status', 'Beschrijf eerst wat je gegeten hebt.', 'error');
  const btn = $('#describe-analyze');
  btn.disabled = true;
  setStatus('#describe-status', 'Bezig met berekenen…', 'busy');
  try {
    const result = await analyze({ text });
    const items = aiResultToItems(result);
    if (!items.length) throw new Error('Kon hier geen eten uit halen. Probeer het iets specifieker.');
    setStatus('#describe-status', '');
    $('#describe-text').value = '';
    addToDraft(items, result.note ? 'AI: ' + result.note : '');
  } catch (err) {
    setStatus('#describe-status', err.message, 'error');
  } finally {
    btn.disabled = false;
  }
};

// ---------- Open Food Facts: barcode en zoeken ----------

const OFF_FIELDS = 'code,product_name,product_name_nl,brands,nutriments,serving_quantity,nutriscore_grade';

function offToItem(p) {
  const n = p.nutriments || {};
  let kcal = n['energy-kcal_100g'];
  if (kcal == null && n.energy_100g != null) kcal = n.energy_100g / 4.184; // kJ -> kcal
  const brand = (p.brands || '').split(',')[0].trim();
  const name = p.product_name_nl || p.product_name || 'Onbekend product';
  return makeItem({
    name: brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${name} (${brand})` : name,
    grams: num(p.serving_quantity) || 100,
    per100: { kcal, protein: n.proteins_100g, carbs: n.carbohydrates_100g, fat: n.fat_100g, fiber: n.fiber_100g },
    nutriscore: p.nutriscore_grade,
  });
}
const hasNutrition = (p) => p.nutriments && (p.nutriments['energy-kcal_100g'] != null || p.nutriments.energy_100g != null);

async function lookupBarcode(code) {
  code = String(code).replace(/\D/g, '');
  if (!code) return;
  setStatus('#barcode-status', `Product ${code} opzoeken…`, 'busy');
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`);
    const data = await res.json().catch(() => ({}));
    if (data.status !== 1 || !data.product) {
      throw new Error(`Barcode ${code} staat niet in Open Food Facts. Zoek het product op naam of voer het handmatig in.`);
    }
    if (!hasNutrition(data.product)) {
      throw new Error('Product gevonden, maar zonder voedingswaardes. Voer het handmatig in.');
    }
    setStatus('#barcode-status', '');
    $('#barcode-input').value = '';
    addToDraft([offToItem(data.product)]);
  } catch (err) {
    setStatus('#barcode-status', err.message === 'Failed to fetch' ? 'Geen internetverbinding.' : err.message, 'error');
  }
}

const BARCODE_FORMATS = () => {
  const F = window.Html5QrcodeSupportedFormats;
  return F ? [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E] : undefined;
};

$('#scan-start').onclick = async () => {
  if (!window.Html5Qrcode) return setStatus('#barcode-status', 'Scanner kon niet laden (geen internet?).', 'error');
  if (state.scanner) return stopScanner();
  const scanner = new Html5Qrcode('reader', { formatsToSupport: BARCODE_FORMATS(), verbose: false });
  state.scanner = scanner;
  $('#scan-start').textContent = 'Camera stoppen';
  setStatus('#barcode-status', 'Richt de camera op de barcode.');
  try {
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: (w, h) => ({ width: Math.min(w * 0.85, 320), height: Math.min(h * 0.45, 160) }) },
      async (code) => {
        await stopScanner();
        lookupBarcode(code);
      },
    );
  } catch (err) {
    await stopScanner();
    setStatus('#barcode-status', 'Camera niet beschikbaar. Gebruik "Foto van barcode" of typ de code.', 'error');
  }
};

async function stopScanner() {
  const s = state.scanner;
  state.scanner = null;
  $('#scan-start').textContent = 'Camera starten';
  if (!s) return;
  try { if (s.isScanning) await s.stop(); s.clear(); } catch { /* al gestopt */ }
}

$('#scan-file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!window.Html5Qrcode) return setStatus('#barcode-status', 'Scanner kon niet laden (geen internet?).', 'error');
  setStatus('#barcode-status', 'Barcode lezen…', 'busy');
  const scanner = new Html5Qrcode('reader', { formatsToSupport: BARCODE_FORMATS(), verbose: false });
  try {
    const code = await scanner.scanFile(file, false);
    lookupBarcode(code);
  } catch {
    setStatus('#barcode-status', 'Geen barcode gevonden op de foto. Probeer dichterbij en scherper.', 'error');
  } finally {
    try { scanner.clear(); } catch { /* niets */ }
  }
};

$('#barcode-form').onsubmit = (e) => {
  e.preventDefault();
  lookupBarcode($('#barcode-input').value);
};

let searchResults = [];
$('#search-form').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  if (!q) return;
  setStatus('#search-status', 'Zoeken…', 'busy');
  $('#search-results').innerHTML = '';
  const url = (host) => `https://${host}.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}`
    + `&search_simple=1&action=process&json=1&page_size=25&fields=${OFF_FIELDS}`;
  try {
    // Eerst Nederlandse producten, anders wereldwijd.
    let products = [];
    for (const host of ['nl', 'world']) {
      const res = await fetch(url(host));
      if (!res.ok) throw new Error(res.status === 429 || res.status === 503
        ? 'Open Food Facts is even druk. Probeer het over een minuut opnieuw.'
        : 'Zoeken mislukt.');
      products = ((await res.json()).products || []).filter(hasNutrition);
      if (products.length) break;
    }
    searchResults = products.map(offToItem);
    setStatus('#search-status', searchResults.length ? '' : 'Niets gevonden. Probeer een andere zoekterm of "Beschrijven".');
    $('#search-results').innerHTML = searchResults.map((it, i) => `
      <div class="card result" data-r="${i}">
        <span>${nutriBadge(it)}${esc(it.name)}</span>
        <span class="num">${round(it.per100.kcal)} kcal/100 g</span>
      </div>`).join('');
  } catch (err) {
    setStatus('#search-status', err.message === 'Failed to fetch' ? 'Geen internetverbinding.' : err.message, 'error');
  }
};
$('#search-results').onclick = (e) => {
  const r = e.target.closest('[data-r]');
  if (r) addToDraft([makeItem(searchResults[Number(r.dataset.r)])]);
};

// ---------- Profielen en vragenlijst ----------

const ACTIVITY = [
  [1.2, 'Weinig actief', 'zittend werk, (bijna) niet sporten'],
  [1.375, 'Licht actief', '1–3× per week sporten of veel wandelen'],
  [1.55, 'Gemiddeld actief', '3–5× per week sporten'],
  [1.725, 'Erg actief', '6–7× per week sporten of lichamelijk zwaar werk'],
  [1.9, 'Zeer actief', 'zwaar lichamelijk werk én veel sporten'],
];
const GOALS = { af: 'Afvallen', gelijk: 'Op gewicht blijven', aan: 'Aankomen' };
const KCAL_PER_KG = 7700; // ongeveer, voor 1 kg lichaamsgewicht
const MIN_KCAL = { v: 1200, m: 1500, x: 1350 }; // ondergrens bij afvallen zonder begeleiding
const displayName = (p) => p.name || 'Mijn profiel';
const kg = (n) => (Math.round(n * 10) / 10).toLocaleString('nl-NL');

// Schatting van het dagelijks verbruik (Mifflin-St Jeor) en het advies dat daaruit volgt.
function calculate(a) {
  const h = a.height / 100;
  const bmr = 10 * a.weight + 6.25 * a.height - 5 * a.age + { m: 5, v: -161, x: -78 }[a.sex];
  const tdee = bmr * ACTIVITY[a.activity][0];
  const bmi = a.weight / (h * h);
  const target = a.goal === 'gelijk' ? a.weight : a.target;
  const targetBmi = target / (h * h);
  const blocks = []; // maakt opslaan onmogelijk
  const warnings = [];

  if (a.goal === 'af' && target >= a.weight) blocks.push('Je streefgewicht moet lager zijn dan je huidige gewicht.');
  if (a.goal === 'aan' && target <= a.weight) blocks.push('Je streefgewicht moet hoger zijn dan je huidige gewicht.');
  if (a.goal === 'af' && bmi < 18.5) {
    blocks.push('Je gewicht is al aan de lage kant (BMI onder 18,5). Afvallen raden we niet aan; overleg met je huisarts of een diëtist.');
  } else if (a.goal === 'af' && targetBmi < 18.5) {
    blocks.push(`Dit streefgewicht ligt onder een gezond gewicht. Bij jouw lengte is dat minimaal ${kg(18.5 * h * h)} kg.`);
  }
  if (a.goal === 'aan' && targetBmi > 25) warnings.push('Je streefgewicht ligt boven een gezond gewicht (BMI boven 25).');
  if (a.age < 18) warnings.push('Deze berekening is bedoeld voor volwassenen. Ben je jonger dan 18, overleg dan met je huisarts of een diëtist.');

  const perDay = (a.pace * KCAL_PER_KG) / 7;
  let kcal = tdee;
  if (a.goal === 'af') {
    kcal = tdee - Math.min(perDay, tdee * 0.25); // nooit meer dan 25% onder je verbruik
    if (kcal < MIN_KCAL[a.sex]) {
      kcal = MIN_KCAL[a.sex];
      warnings.push(`We adviseren niet minder dan ${MIN_KCAL[a.sex]} kcal per dag te eten. Het afvallen gaat daardoor wat langzamer.`);
    }
  } else if (a.goal === 'aan') {
    kcal = tdee + perDay;
  }
  const diff = Math.abs(kcal - tdee);
  const weeks = a.goal !== 'gelijk' && diff > 0 ? (Math.abs(target - a.weight) * KCAL_PER_KG) / (diff * 7) : 0;
  // Eiwit per kg "gezond" gewicht (hooguit BMI 25), iets meer bij afvallen of aankomen.
  const protein = Math.min(a.weight, 25 * h * h) * { af: 1.2, gelijk: 0.9, aan: 1.4 }[a.goal];

  return {
    bmr, tdee, bmi, targetBmi, weeks, blocks, warnings, diff,
    kcal: Math.round(kcal / 10) * 10,
    protein: Math.round(protein / 5) * 5,
  };
}

function goalDescription(a) {
  const activity = ACTIVITY[a.activity][1].toLowerCase();
  if (a.goal === 'gelijk') return `Doel: op gewicht blijven (${kg(a.weight)} kg), ${activity}.`;
  return `Doel: ${a.goal === 'af' ? 'afvallen' : 'aankomen'} van ${kg(a.weight)} naar ${kg(a.target)} kg, ${activity}.`;
}

function renderProfileSwitch() {
  $('#profile-switch').innerHTML = profiles.list
    .map((p) => `<option value="${p.id}" ${p.id === profiles.active ? 'selected' : ''}>${esc(displayName(p))}</option>`)
    .join('') + '<option value="__new">＋ Nieuw profiel</option>';
}
$('#profile-switch').onchange = (e) => {
  if (e.target.value === '__new') return openProfileForm(null);
  switchProfile(e.target.value);
  show('today');
};

function openProfileForm(id) {
  state.profileEdit = { id };
  const p = id ? profiles.list.find((x) => x.id === id) : null;
  const a = p?.answers || {};
  const f = $('#profile-form');
  f.reset();
  $('#pf-name').value = p?.name || '';
  f.sex.value = a.sex || '';
  $('#pf-age').value = a.age || '';
  $('#pf-height').value = a.height || '';
  $('#pf-weight').value = a.weight ? kg(a.weight) : '';
  f.goal.value = a.goal || '';
  $('#pf-target').value = a.target ? kg(a.target) : '';
  f.pace.value = String(a.pace || 0.5);
  $('#pf-activity').value = a.activity ?? '';
  $('#pf-delete').hidden = !id || profiles.list.length < 2;
  const first = profiles.list.length === 1 && id && !p.answers && !p.skipped;
  $('#profile-intro').innerHTML = first
    ? '<b>Welkom!</b> Beantwoord een paar vragen, dan berekenen we hoeveel je ongeveer per dag kunt eten.'
    : 'Beantwoord de vragen, dan berekenen we hoeveel je ongeveer per dag kunt eten.';
  $('#pf-cancel').textContent = first ? 'Later invullen' : 'Annuleren';
  show('profile');
  updateProfileForm();
}

function readProfileForm() {
  const f = $('#profile-form');
  const a = {
    sex: f.sex.value,
    age: round(num($('#pf-age').value)),
    height: round(num($('#pf-height').value)),
    weight: num($('#pf-weight').value),
    goal: f.goal.value,
    target: num($('#pf-target').value),
    pace: Number(f.pace.value) || 0.5,
    activity: $('#pf-activity').value === '' ? null : Number($('#pf-activity').value),
  };
  const complete = a.sex && a.age >= 12 && a.age <= 110 && a.height >= 100 && a.height <= 250
    && a.weight >= 30 && a.weight <= 350 && a.goal && a.activity !== null
    && (a.goal === 'gelijk' || (a.target >= 30 && a.target <= 350));
  return { a, complete };
}

function updateProfileForm() {
  const { a, complete } = readProfileForm();
  $('#pf-target-wrap').hidden = !a.goal || a.goal === 'gelijk';
  const out = $('#pf-result');
  if (!complete) {
    out.innerHTML = '<p class="muted small">Vul alles in om je advies te zien.</p>';
    $('#pf-save').disabled = true;
    return;
  }
  const c = calculate(a);
  const when = new Date(Date.now() + c.weeks * 7 * 864e5).toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' });
  const bmi = (n) => n.toLocaleString('nl-NL', { maximumFractionDigits: 1 });
  const lines = [
    `In rust verbruik je ongeveer <b>${round(c.bmr)} kcal</b> per dag.`,
    `Met je activiteit kom je op ongeveer <b>${round(c.tdee)} kcal</b> per dag.`,
  ];
  if (a.goal !== 'gelijk') {
    lines.push(`Om ${a.goal === 'af' ? 'af te vallen' : 'aan te komen'} eet je zo'n <b>${round(c.diff)} kcal ${a.goal === 'af' ? 'minder' : 'meer'}</b> per dag.`);
    lines.push(`BMI nu ${bmi(c.bmi)}, bij je streefgewicht ${bmi(c.targetBmi)}.`);
    if (!c.blocks.length) lines.push(`Je streefgewicht bereik je in ongeveer <b>${Math.ceil(c.weeks)} weken</b> (rond ${when}).`);
  } else {
    lines.push(`BMI nu ${bmi(c.bmi)}.`);
  }
  out.innerHTML = `<div class="card calc">
    ${c.blocks.length ? '' : `<div class="muted small">Advies per dag</div>
      <div><span class="kcal-big">${c.kcal.toLocaleString('nl-NL')}</span> kcal</div>
      <div>en ongeveer <b>${c.protein} g eiwit</b></div>`}
    <ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
    ${[...c.blocks, ...c.warnings].map((w) => `<p class="warn">${esc(w)}</p>`).join('')}
    <p class="muted small">Een schatting met de Mifflin-St Jeor-formule; je echte verbruik kan zo'n 10% afwijken.
      Kijk na een paar weken hoe je gewicht verandert en vul de vragen dan opnieuw in.
      Ben je zwanger, geef je borstvoeding of heb je een medische aandoening? Overleg dan met je huisarts of een diëtist.</p>
  </div>`;
  $('#pf-save').disabled = c.blocks.length > 0;
}

$('#profile-form').addEventListener('input', updateProfileForm);
$('#profile-form').addEventListener('change', updateProfileForm);

$('#profile-form').onsubmit = (e) => {
  e.preventDefault();
  const { a, complete } = readProfileForm();
  if (!complete) return;
  const c = calculate(a);
  if (c.blocks.length) return;
  if (a.goal === 'gelijk') a.target = a.weight;
  const name = $('#pf-name').value.trim();
  let p = state.profileEdit.id && profiles.list.find((x) => x.id === state.profileEdit.id);
  if (!p) {
    p = { id: uid() };
    profiles.list.push(p);
  }
  Object.assign(p, { name, answers: a, goalKcal: c.kcal, goalProtein: c.protein, skipped: false });
  save('eetmeter.profiles', profiles);
  if (p.id !== profiles.active) switchProfile(p.id);
  state.profileEdit = null;
  toast(`Dagdoel: ${c.kcal} kcal`);
  show(settings.geminiKey || settings.provider === 'ollama' ? 'today' : 'settings');
};

$('#pf-cancel').onclick = () => {
  const p = state.profileEdit?.id && profiles.list.find((x) => x.id === state.profileEdit.id);
  if (p && !p.answers) {
    p.skipped = true; // niet bij elke start opnieuw vragen
    save('eetmeter.profiles', profiles);
  }
  state.profileEdit = null;
  show('today');
};

$('#pf-delete').onclick = () => {
  const id = state.profileEdit.id;
  const p = profiles.list.find((x) => x.id === id);
  if (!p || profiles.list.length < 2) return;
  if (!confirm(`Profiel "${displayName(p)}" met alle maaltijden verwijderen? Dit kan niet ongedaan worden.`)) return;
  profiles.list = profiles.list.filter((x) => x.id !== id);
  try {
    localStorage.removeItem(`eetmeter.log.${id}`);
    localStorage.removeItem(`eetmeter.dayAdvice.${id}`);
  } catch { /* niets */ }
  switchProfile(profiles.list[0].id);
  state.profileEdit = null;
  show('today');
};

$('#edit-profile').onclick = () => openProfileForm(profiles.active);
$('#new-profile').onclick = () => openProfileForm(null);

// ---------- Instellingen ----------

function renderSettings() {
  const p = profile();
  $('#profile-summary').innerHTML = `<b>${esc(displayName(p))}</b><div class="muted small">${
    p.answers ? esc(goalDescription(p.answers)) : 'Vragenlijst nog niet ingevuld.'}</div>`;
  $('#edit-profile').textContent = p.answers ? 'Vragenlijst aanpassen' : 'Vragenlijst invullen';
  $('#set-goal-kcal').value = p.goalKcal;
  $('#set-goal-protein').value = p.goalProtein || '';
  $('#set-provider').value = settings.provider;
  $('#set-gemini-key').value = settings.geminiKey;
  $('#set-gemini-model').value = settings.geminiModel;
  $('#set-ollama-url').value = settings.ollamaUrl;
  $('#set-ollama-model').value = settings.ollamaModel;
  $('#gemini-settings').hidden = settings.provider !== 'gemini';
  $('#ollama-settings').hidden = settings.provider !== 'ollama';
  setStatus('#settings-status', '');
}

$('#view-settings').addEventListener('change', (e) => {
  // Doelen horen bij het profiel; zelf aanpassen overschrijft de berekening.
  const goals = {
    'set-goal-kcal': ['goalKcal', (v) => round(num(v)) || 2000],
    'set-goal-protein': ['goalProtein', (v) => round(num(v))],
  };
  if (goals[e.target.id]) {
    const [key, parse] = goals[e.target.id];
    profile()[key] = parse(e.target.value);
    save('eetmeter.profiles', profiles);
    renderSettings();
    toast('Doel aangepast');
    return;
  }
  const map = {
    'set-provider': ['provider', String],
    'set-gemini-key': ['geminiKey', (v) => v.trim()],
    'set-gemini-model': ['geminiModel', (v) => v.trim() || DEFAULT_SETTINGS.geminiModel],
    'set-ollama-url': ['ollamaUrl', (v) => v.trim() || DEFAULT_SETTINGS.ollamaUrl],
    'set-ollama-model': ['ollamaModel', (v) => v.trim() || DEFAULT_SETTINGS.ollamaModel],
  };
  const m = map[e.target.id];
  if (!m) return;
  settings[m[0]] = m[1](e.target.value);
  save('eetmeter.settings', settings);
  renderSettings();
  toast('Instelling opgeslagen');
});

$('#test-ai').onclick = async () => {
  setStatus('#settings-status', 'Testen…', 'busy');
  try {
    const r = await analyze({ text: '1 banaan' });
    const it = aiResultToItems(r)[0];
    setStatus('#settings-status', it ? `Werkt! Test: ${it.name}, ${round(it.grams)} g, ${round(itemTotals(it).kcal)} kcal.` : 'Verbonden, maar geen bruikbaar antwoord.');
  } catch (err) {
    setStatus('#settings-status', err.message === 'Failed to fetch' ? 'Geen verbinding.' : err.message, 'error');
  }
};

$('#export').onclick = () => {
  // Back-up van het actieve profiel; de API-key gaat nooit mee.
  const blob = new Blob([JSON.stringify({ version: 2, profile: profile(), log, dayAdvice }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const slug = displayName(profile()).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  a.download = `eetmeter-${slug || 'profiel'}-${todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#import').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.log || typeof data.log !== 'object') throw new Error();
    if (!confirm(`Back-up samenvoegen met profiel "${displayName(profile())}"?`)) return;
    for (const [day, entries] of Object.entries(data.log)) {
      const existing = (log[day] ||= []);
      for (const entry of entries) if (!existing.some((x) => x.id === entry.id)) existing.push(entry);
    }
    save(logKey(), log);
    toast('Back-up geïmporteerd');
  } catch {
    toast('Dit is geen geldige back-up');
  }
};

// ---------- Start ----------

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
initProfiles();
if (!profile().answers && !profile().skipped) openProfileForm(profiles.active);
else show(settings.geminiKey || settings.provider === 'ollama' ? 'today' : 'settings');
if (!settings.geminiKey && settings.provider === 'gemini') {
  setStatus('#settings-status', 'Welkom! Vul je gratis Gemini API-key in om foto\'s te laten herkennen. Barcode en zoeken werken ook zonder.');
}
