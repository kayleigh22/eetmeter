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
let water = {}; // { 'YYYY-MM-DD': aantal glazen }

const profile = () => profiles.list.find((p) => p.id === profiles.active);
const logKey = () => `eetmeter.log.${profiles.active}`;
const adviceKey = () => `eetmeter.dayAdvice.${profiles.active}`;
const waterKey = () => `eetmeter.water.${profiles.active}`;

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
  water = load(waterKey(), {});
}
function switchProfile(id) {
  profiles.active = id;
  save('eetmeter.profiles', profiles);
  state.draft = null;
  state.ideas = null;
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

// unit: de gewone maat die bij dit product hoort (bijv. sneetje van 35 g);
// measure + amount: de maat waarin het nu is ingevuld (bijv. 2 × sneetje). Zonder measure is het in gram.
function makeItem({ name, grams, per100, nutriscore, unit, measure, amount, source }) {
  const p = {};
  for (const k of NUTRIENTS) p[k] = num(per100?.[k]);
  const item = { name: String(name ?? ''), grams: num(grams) || 100, per100: p };
  if (/^[a-e]$/.test(nutriscore || '')) item.nutriscore = nutriscore;
  if (source) item.source = source;
  const u = cleanUnit(unit);
  if (u) item.unit = u;
  const m = cleanUnit(measure);
  if (m) {
    item.measure = m;
    item.amount = num(amount) || 1;
    item.grams = item.amount * m.grams;
  }
  return item;
}
function cleanUnit(u) {
  if (!u || !u.name || /^(g|gr|gram)$/i.test(String(u.name).trim()) || !(num(u.grams) > 0)) return null;
  return { name: String(u.name).trim(), grams: num(u.grams) };
}

const GENERIC_UNITS = [
  { name: 'eetlepel', grams: 15 }, { name: 'theelepel', grams: 5 }, { name: 'opscheplepel', grams: 50 },
  { name: 'glas', grams: 200 }, { name: 'kopje', grams: 150 }, { name: 'schaaltje', grams: 150 },
];
function unitsFor(it) {
  const list = [{ name: 'gram', grams: 1 }];
  if (it.unit) list.push(it.unit);
  if (it.measure && !list.some((u) => u.name === it.measure.name)) list.push(it.measure);
  for (const g of GENERIC_UNITS) if (!list.some((u) => u.name === g.name)) list.push(g);
  return list;
}
const fmtNum = (n) => (Math.round(n * 100) / 100).toLocaleString('nl-NL');
const amountLabel = (it) => it.measure
  ? `${fmtNum(it.amount)} ${it.measure.name} (${round(it.grams)} g)`
  : `${round(it.grams)} g`;
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
    search: 'Zoeken', review: 'Controleren', settings: 'Instellingen', profile: 'Profiel', progress: 'Voortgang',
  };
  const isDayView = view === 'today';
  $('#day-label').textContent = isDayView ? dateLabel(state.date) : titles[view];
  $('#day-prev').style.visibility = isDayView ? 'visible' : 'hidden';
  $('#day-next').style.visibility = isDayView ? 'visible' : 'hidden';

  if (view === 'today') renderToday();
  if (view === 'add') renderAdd();
  if (view === 'review') renderReview();
  if (view === 'settings') renderSettings();
  if (view === 'progress') renderProgress();
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
        <span class="num">${amountLabel(it)} · ${round(itemTotals(it).kcal)} kcal</span>
      </div>`).join('')}
    </div>`;
  }).join('');
  $('#today-empty').hidden = entries.length > 0;
  renderDayAdvice();
  renderWater();
  $('#ideas-btn').hidden = state.date !== todayKey();
  renderIdeas();
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
  renderFavorites();
  const recent = recentItems();
  $('#recent-title').hidden = recent.length === 0;
  $('#recent').innerHTML = recent.map((it, i) =>
    `<button class="chip" data-recent="${i}">${esc(it.name)} · ${esc(amountLabel(it))}</button>`).join('');
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
        <button class="del" data-del="${i}" aria-label="Verwijderen">×</button>
      </div>
      <div class="item-qty">
        <input class="amount" data-f="amount" type="text" inputmode="decimal" aria-label="Hoeveelheid"
          value="${it.measure ? fmtNum(it.amount) : round(it.grams)}">
        <select data-f="unit" aria-label="Maat">${unitsFor(it).map((u, j) => {
          const selected = it.measure ? u.name === it.measure.name : j === 0;
          return `<option value="${j}" ${selected ? 'selected' : ''}>${u.name === 'gram' ? 'gram' : `${esc(u.name)} (${round(u.grams)} g)`}</option>`;
        }).join('')}</select>
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
      `${d.items[i].measure ? `${round(d.items[i].grams)} g · ` : ''}${round(t.kcal)} kcal · E ${round(t.protein)} · K ${round(t.carbs)} · V ${round(t.fat)}`;
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
  else if (f === 'amount') {
    if (it.measure) {
      it.amount = num(e.target.value);
      it.grams = it.amount * it.measure.grams;
    } else {
      it.grams = num(e.target.value);
    }
  } else if (f === 'unit') {
    const u = unitsFor(it)[Number(e.target.value)];
    if (u.name === 'gram') {
      delete it.measure;
      delete it.amount;
    } else {
      // Hoeveelheid zo goed mogelijk behouden, afgerond op halven.
      it.measure = { ...u };
      it.amount = Math.max(0.5, Math.round((it.grams / u.grams) * 2) / 2);
      it.grams = it.amount * u.grams;
    }
    card.querySelector('.amount').value = it.measure ? fmtNum(it.amount) : round(it.grams);
  } else it.per100[f] = num(e.target.value);
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
- een gewone huishoudelijke maat ("unit_name", bijv. "sneetje", "stuk", "eetlepel", "opscheplepel", "glas",
  "schaaltje", "plak"), het gewicht van één zo'n maat in gram ("unit_grams") en hoeveel ervan ("amount", mag 0,5 zijn).
  grams moet gelijk zijn aan amount × unit_grams.
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
          unit_name: { type: 'STRING' },
          unit_grams: { type: 'NUMBER' },
          amount: { type: 'NUMBER' },
          kcal_per_100g: { type: 'NUMBER' },
          protein_per_100g: { type: 'NUMBER' },
          carbs_per_100g: { type: 'NUMBER' },
          fat_per_100g: { type: 'NUMBER' },
          fiber_per_100g: { type: 'NUMBER' },
        },
        required: ['name', 'grams', 'unit_name', 'unit_grams', 'amount',
          'kcal_per_100g', 'protein_per_100g', 'carbs_per_100g', 'fat_per_100g', 'fiber_per_100g'],
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
    unit: { name: x.unit_name, grams: x.unit_grams },
    measure: { name: x.unit_name, grams: x.unit_grams },
    amount: x.amount,
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
  const portion = num(p.serving_quantity) ? { name: 'portie', grams: num(p.serving_quantity) } : null;
  return makeItem({
    name: brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${name} (${brand})` : name,
    grams: portion?.grams || 100,
    unit: portion,
    measure: portion,
    amount: 1,
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
  // NEVO staat op het apparaat en is direct klaar; Open Food Facts komt er daarna bij.
  const nevoItems = searchNevo(q);
  const renderResults = () => {
    $('#search-results').innerHTML = searchResults.map((it, i) => `
      <div class="card result" data-r="${i}">
        <span>${it.source === 'NEVO' ? '<span class="src">NEVO</span>' : ''}${nutriBadge(it)}${esc(it.name)}</span>
        <span class="num">${round(it.per100.kcal)} kcal/100 g</span>
      </div>`).join('');
  };
  searchResults = nevoItems;
  renderResults();
  setStatus('#search-status', 'Producten zoeken in Open Food Facts…', 'busy');
  const url = (host) => `https://${host}.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}`
    + `&search_simple=1&action=process&json=1&page_size=25&fields=${OFF_FIELDS}`;
  try {
    // Eerst Nederlandse producten, anders wereldwijd.
    let products = [];
    for (const host of ['nl', 'world']) {
      const res = await fetch(url(host));
      if (!res.ok) throw new Error(res.status === 429 || res.status === 503
        ? 'Open Food Facts is even druk. Probeer het over een minuut opnieuw.'
        : 'Zoeken in Open Food Facts mislukt.');
      products = ((await res.json()).products || []).filter(hasNutrition);
      if (products.length) break;
    }
    searchResults = [...nevoItems, ...products.map(offToItem)];
    setStatus('#search-status', searchResults.length ? '' : 'Niets gevonden. Probeer een andere zoekterm of "Beschrijven".');
    renderResults();
  } catch (err) {
    setStatus('#search-status', err.message === 'Failed to fetch' ? 'Geen internetverbinding.' : err.message, 'error');
  }
};
$('#search-results').onclick = (e) => {
  const r = e.target.closest('[data-r]');
  if (r) addToDraft([makeItem(searchResults[Number(r.dataset.r)])]);
};

// ---------- NEVO (Nederlandse voedingsmiddelentabel) ----------

// Opgeslagen als { rows: [[naam, kcal, eiwit, koolh, vet, vezels], ...], count, date }, gedeeld door alle profielen.
let nevo = load('eetmeter.nevo', null);

function searchNevo(q) {
  if (!nevo?.rows?.length) return [];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return nevo.rows
    .filter((r) => { const n = r[0].toLowerCase(); return words.every((w) => n.includes(w)); })
    .sort((a, b) => a[0].length - b[0].length)
    .slice(0, 15)
    .map((r) => makeItem({
      name: r[0], grams: 100, source: 'NEVO',
      per100: { kcal: r[1], protein: r[2], carbs: r[3], fat: r[4], fiber: r[5] },
    }));
}

// Eenvoudige CSV-lezer die aanhalingstekens en elk scheidingsteken aankan.
function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

function parseNevo(text) {
  // Scheidingsteken: het teken dat in de eerste regels het vaakst voorkomt.
  const head = text.split(/\r?\n/, 10).join('\n');
  const delim = ['|', ';', '\t', ','].sort((a, b) => head.split(b).length - head.split(a).length)[0];
  const allRows = parseDelimited(text, delim);
  // Soms staan er titelregels boven de kolomnamen.
  const hi = Math.max(0, allRows.slice(0, 10).findIndex((r) =>
    r.some((h) => /voedingsmiddelnaam|food ?name/i.test(h)) && r.some((h) => /ENERCC|kcal/i.test(h))));
  const rows = allRows.slice(hi);
  const header = rows[0].map((h) => h.trim());
  const find = (...res) => {
    for (const re of res) {
      const i = header.findIndex((h) => re.test(h));
      if (i >= 0) return i;
    }
    return -1;
  };
  const col = {
    name: find(/voedingsmiddelnaam/i, /dutch food name/i, /food ?name/i, /naam/i),
    kcal: find(/^ENERCC\b/i, /kcal/i),
    protein: find(/^PROT\b/i, /eiwit/i),
    carbs: find(/^CHO\b/i, /koolhydra/i),
    fat: find(/^FAT\b/i, /^vet/i),
    fiber: find(/^FIBT\b/i, /vezel/i),
  };
  if (col.name < 0 || col.kcal < 0) {
    throw new Error('Dit lijkt geen NEVO-bestand: kolommen voor naam en kcal niet gevonden.');
  }
  const val = (r, i) => (i < 0 ? 0 : num(r[i]));
  const out = rows.slice(1)
    .filter((r) => r[col.name]?.trim())
    .map((r) => [r[col.name].trim(), val(r, col.kcal), val(r, col.protein), val(r, col.carbs), val(r, col.fat), val(r, col.fiber)]);
  if (!out.length) throw new Error('Geen producten gevonden in dit bestand.');
  return out;
}

async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(buf);
  // Oudere NEVO-bestanden zijn in Windows-codering; dan worden é en ë anders kapot.
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8;
}

// Excel lezen met SheetJS; alleen geladen als iemand een Excel-bestand kiest.
async function excelToCsv(file) {
  if (!window.XLSX) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Excel-lezer kon niet laden (geen internet?).'));
      document.head.appendChild(s);
    });
  }
  const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
  return window.XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]], { FS: '|' });
}

function renderNevoStatus() {
  $('#nevo-status').textContent = nevo?.rows?.length
    ? `Geïmporteerd: ${nevo.rows.length.toLocaleString('nl-NL')} producten (${shortDate(nevo.date)}).`
    : 'Nog niet geïmporteerd.';
  $('#nevo-remove').hidden = !nevo?.rows?.length;
}

$('#nevo-file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (/\.zip$/i.test(file.name)) {
    toast('Pak het zip-bestand eerst uit en kies dan het CSV- of Excel-bestand.');
    return;
  }
  try {
    toast('Bestand inlezen…');
    const text = /\.xlsx?$/i.test(file.name) ? await excelToCsv(file) : await readTextFile(file);
    const rows = parseNevo(text);
    nevo = { rows, date: todayKey() };
    save('eetmeter.nevo', nevo);
    renderNevoStatus();
    toast(`${rows.length.toLocaleString('nl-NL')} NEVO-producten geïmporteerd`);
  } catch (err) {
    toast(err.message);
  }
};
$('#nevo-remove').onclick = () => {
  if (!confirm('NEVO-tabel van dit apparaat verwijderen?')) return;
  nevo = null;
  try { localStorage.removeItem('eetmeter.nevo'); } catch { /* niets */ }
  renderNevoStatus();
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
  const goalChanged = !p.answers || p.answers.goal !== a.goal || p.answers.target !== a.target || p.answers.pace !== a.pace;
  Object.assign(p, { name, answers: a, goalKcal: c.kcal, goalProtein: c.protein, skipped: false, manualGoal: false });
  // Startpunt van het plan, om later te kunnen zeggen of je op schema ligt.
  if (goalChanged || !p.goalSince) p.goalSince = todayKey();
  recordWeight(p, a.weight);
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
    localStorage.removeItem(`eetmeter.water.${id}`);
  } catch { /* niets */ }
  switchProfile(profiles.list[0].id);
  state.profileEdit = null;
  show('today');
};

$('#edit-profile').onclick = () => openProfileForm(profiles.active);
$('#new-profile').onclick = () => openProfileForm(null);

// ---------- Gewicht ----------

const shortDate = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
};
const daysBetween = (a, b) => {
  const toDate = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toDate(b) - toDate(a)) / 864e5);
};

// Alleen opslaan, niets herberekenen (gebruikt door de vragenlijst).
function recordWeight(p, value, date = todayKey()) {
  const w = (p.weights ||= []);
  const existing = w.find((x) => x.date === date);
  if (existing) existing.kg = value;
  else w.push({ date, kg: value });
  w.sort((a, b) => a.date.localeCompare(b.date));
}

const goalReached = (p) => {
  const a = p.answers;
  const last = p.weights?.at(-1)?.kg;
  if (!a || last == null) return false;
  return (a.goal === 'af' && last <= a.target) || (a.goal === 'aan' && last >= a.target);
};

function saveWeight(value) {
  const p = profile();
  recordWeight(p, value);
  let msg = 'Gewicht opgeslagen';
  if (p.answers) {
    p.answers.weight = value;
    if (goalReached(p)) {
      msg = 'Streefgewicht bereikt, goed gedaan!';
    } else if (!p.manualGoal) {
      // Dagdoel meebewegen met je gewicht, tenzij je het zelf hebt aangepast.
      const c = calculate(p.answers);
      if (!c.blocks.length && c.kcal !== p.goalKcal) {
        p.goalKcal = c.kcal;
        p.goalProtein = c.protein;
        msg = `Gewicht opgeslagen. Nieuw dagdoel: ${c.kcal} kcal`;
      }
    }
  }
  save('eetmeter.profiles', profiles);
  toast(msg);
  renderProgress();
}

$('#weight-form').onsubmit = (e) => {
  e.preventDefault();
  const v = num($('#weight-input').value);
  if (v < 30 || v > 350) return toast('Vul een gewicht in kg in, bijv. 72,4');
  $('#weight-input').value = '';
  saveWeight(v);
};

$('#weight-list').onclick = (e) => {
  const b = e.target.closest('[data-wdel]');
  if (!b) return;
  const p = profile();
  p.weights = p.weights.filter((w) => w.date !== b.dataset.wdel);
  save('eetmeter.profiles', profiles);
  renderProgress();
};

$('#goal-maintain').onclick = () => {
  const p = profile();
  const last = p.weights.at(-1).kg;
  Object.assign(p.answers, { goal: 'gelijk', weight: last, target: last });
  const c = calculate(p.answers);
  Object.assign(p, { goalKcal: c.kcal, goalProtein: c.protein, manualGoal: false, goalSince: todayKey() });
  save('eetmeter.profiles', profiles);
  toast(`Nieuw doel: op gewicht blijven, ${c.kcal} kcal per dag`);
  renderProgress();
};

// Hoe ver je bent ten opzichte van het geplande tempo.
function scheduleText(p) {
  const a = p.answers;
  const w = p.weights || [];
  if (!a || w.length < 2) return '';
  const start = [...w].reverse().find((x) => x.date <= (p.goalSince || w[0].date)) || w[0];
  const last = w.at(-1);
  const weeks = daysBetween(start.date, last.date) / 7;
  const change = last.kg - start.kg;
  if (a.goal === 'gelijk') {
    return Math.abs(last.kg - a.target) <= 1
      ? 'Je blijft mooi rond je gewicht.'
      : `Je zit ${kg(Math.abs(last.kg - a.target))} kg ${last.kg > a.target ? 'boven' : 'onder'} je streefgewicht.`;
  }
  if (weeks < 1) return '';
  const dir = a.goal === 'af' ? -1 : 1;
  const expected = a.pace * weeks; // kg verandering volgens plan
  const actual = change * dir; // positief = goede richting
  if (actual >= expected - 0.3) return `Je ligt op schema: ${kg(Math.abs(change))} kg in ${Math.round(weeks)} weken.`;
  if (actual > 0) return `Je gaat de goede kant op (${kg(Math.abs(change))} kg), iets langzamer dan gepland. Geen zorgen: gewicht schommelt per week.`;
  return 'Nog geen verandering richting je doel. Kijk eens of je dagdoel en porties kloppen, of vraag om advies.';
}

// Lijngrafiek van je gewicht met een stippellijn voor je streefgewicht. Eén reeks, dus geen legenda.
function weightChart(weights, target) {
  const W = 340, H = 180, L = 36, R = 10, T = 12, B = 24;
  const today = todayKey();
  const first = weights[0].date;
  const lastDate = weights.at(-1).date > today ? weights.at(-1).date : today;
  const span = Math.max(daysBetween(first, lastDate), 1);
  const vals = weights.map((w) => w.kg).concat(target ? [target] : []);
  let lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1);
  if (hi - lo < 4) { lo -= 1; hi += 1; }
  const x = (d) => L + (daysBetween(first, d) / span) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  const pts = weights.map((w) => `${x(w.date).toFixed(1)},${y(w.kg).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Gewicht in de tijd">
    ${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/>
      <text x="${L - 6}" y="${y(t) + 4}" class="axis" text-anchor="end">${t}</text>`).join('')}
    ${target ? `<line x1="${L}" x2="${W - R}" y1="${y(target)}" y2="${y(target)}" class="ref"/>
      <text x="${W - R}" y="${y(target) - 5}" class="axis" text-anchor="end">doel ${kg(target)} kg</text>` : ''}
    ${weights.length > 1 ? `<polyline points="${pts}" class="line"/>` : ''}
    ${weights.map((w) => `<g class="pt" data-tip="${shortDate(w.date)}: ${kg(w.kg)} kg">
      <circle cx="${x(w.date)}" cy="${y(w.kg)}" r="12" class="hit"/>
      <circle cx="${x(w.date)}" cy="${y(w.kg)}" r="4" class="dot"/></g>`).join('')}
    <text x="${L}" y="${H - 6}" class="axis">${shortDate(first)}</text>
    <text x="${W - R}" y="${H - 6}" class="axis" text-anchor="end">${shortDate(lastDate)}</text>
  </svg>`;
}

function renderWeight() {
  const p = profile();
  const w = p.weights || [];
  const a = p.answers;
  const last = w.at(-1);
  let summary = 'Vul je gewicht in om je voortgang te zien.';
  if (last) {
    const diff = last.kg - w[0].kg;
    summary = `<div><span class="kcal-big">${kg(last.kg)}</span> kg <span class="muted small">op ${shortDate(last.date)}</span></div>`
      + (w.length > 1 ? `<div class="muted small">${diff <= 0 ? '−' : '+'}${kg(Math.abs(diff))} kg sinds ${shortDate(w[0].date)}</div>` : '')
      + (a && a.goal !== 'gelijk' && !goalReached(p) ? `<div class="small">Nog ${kg(Math.abs(last.kg - a.target))} kg tot je streefgewicht van ${kg(a.target)} kg.</div>` : '')
      + (scheduleText(p) ? `<div class="small">${esc(scheduleText(p))}</div>` : '');
  }
  $('#weight-summary').innerHTML = summary;
  $('#goal-reached').hidden = !goalReached(p);
  $('#weight-chart').innerHTML = w.length ? weightChart(w, a && a.goal !== 'gelijk' ? a.target : null) : '';
  $('#weight-tip').textContent = w.length ? 'Tik op een punt voor de waarde.' : '';
  // Lijst als tabelweergave van de grafiek, nieuwste eerst.
  $('#weight-list').innerHTML = [...w].reverse().slice(0, 10).map((x) =>
    `<div class="wrow"><span>${shortDate(x.date)}</span><span>${kg(x.kg)} kg</span>
      <button class="del" data-wdel="${x.date}" aria-label="Verwijderen">×</button></div>`).join('');
}

// Tooltip voor grafieken: tik of beweeg over een punt of balk.
function chartTip(container, tipEl) {
  const showTip = (e) => {
    const g = e.target.closest('[data-tip]');
    if (g) $(tipEl).textContent = g.dataset.tip;
  };
  $(container).addEventListener('click', showTip);
  $(container).addEventListener('pointerover', showTip);
}
chartTip('#weight-chart', '#weight-tip');
chartTip('#week-chart', '#week-tip');

// ---------- Weekoverzicht ----------

function mondayOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  const day = (new Date(y, m - 1, d).getDay() + 6) % 7; // 0 = maandag
  return shiftDate(key, -day);
}

function renderWeek() {
  state.weekStart ||= mondayOf(todayKey());
  const start = state.weekStart;
  const days = Array.from({ length: 7 }, (_, i) => shiftDate(start, i));
  const goal = profile().goalKcal;
  const stats = days.map((d) => {
    const t = sumItems((log[d] || []).flatMap((e) => e.items));
    return { d, kcal: t.kcal, protein: t.protein, fiber: t.fiber, logged: (log[d] || []).length > 0, water: water[d] || 0 };
  });
  const logged = stats.filter((s) => s.logged);
  const avg = (k) => (logged.length ? logged.reduce((s, x) => s + x[k], 0) / logged.length : 0);
  const onTarget = logged.filter((s) => s.kcal >= goal * 0.9 && s.kcal <= goal * 1.1).length;

  $('#week-label').textContent = `${shortDate(days[0])} – ${shortDate(days[6])}`;
  $('#week-next').disabled = shiftDate(start, 7) > todayKey();
  $('#week-stats').innerHTML = logged.length
    ? `<div class="macros">
        <div><b>${round(avg('kcal'))}</b><span>kcal gem. (doel ${goal})</span></div>
        <div><b>${round(avg('protein'))}</b><span>eiwit gem.${profile().goalProtein ? ` (${profile().goalProtein})` : ''}</span></div>
        <div><b>${onTarget}/${logged.length}</b><span>dagen op doel</span></div>
        <div><b>${round(avg('fiber'))}</b><span>vezels gem.</span></div>
      </div>
      <p class="muted small">Gemiddelden over de ${logged.length} bijgehouden dag${logged.length === 1 ? '' : 'en'}.
        "Op doel" = binnen 10% van je dagdoel. Vezels: het advies is zo'n 30–40 g per dag.</p>`
    : '<p class="muted small">Deze week is nog niets bijgehouden.</p>';

  // Staafgrafiek per dag met een stippellijn voor het dagdoel.
  const W = 340, H = 170, L = 8, R = 8, T = 16, B = 24;
  const max = Math.max(goal * 1.25, ...stats.map((s) => s.kcal));
  const bw = (W - L - R) / 7;
  const y = (v) => T + (1 - v / max) * (H - T - B);
  const names = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
  $('#week-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="kcal per dag deze week">
    <line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="baseline"/>
    ${stats.map((s, i) => {
      const x0 = L + i * bw + bw * 0.2, w = bw * 0.6, top = y(s.kcal), h = H - B - top;
      const tip = `${names[i]} ${shortDate(s.d)}: ${s.logged ? `${round(s.kcal)} kcal, ${round(s.protein)} g eiwit` : 'niets bijgehouden'}`;
      return `<g data-tip="${tip}">
        <rect x="${L + i * bw}" y="${T}" width="${bw}" height="${H - B - T}" class="hit"/>
        ${s.kcal > 0 ? `<path d="M${x0},${H - B} v${-(h - 4)} q0,-4 4,-4 h${w - 8} q4,0 4,4 v${h - 4} z" class="bar"/>` : ''}
        <text x="${L + i * bw + bw / 2}" y="${H - 7}" class="axis" text-anchor="middle">${names[i]}</text></g>`;
    }).join('')}
    <line x1="${L}" x2="${W - R}" y1="${y(goal)}" y2="${y(goal)}" class="ref"/>
    <text x="${W - R}" y="${y(goal) - 5}" class="axis" text-anchor="end">doel ${goal}</text>
  </svg>`;
  $('#week-tip').textContent = 'Tik op een dag voor de waarde.';
}

$('#week-prev').onclick = () => { state.weekStart = shiftDate(state.weekStart, -7); renderWeek(); };
$('#week-next').onclick = () => { state.weekStart = shiftDate(state.weekStart, 7); renderWeek(); };

function renderProgress() {
  renderWeight();
  renderWeek();
}

// ---------- Vaste maaltijden ----------

$('#review-fav').onclick = () => {
  const d = state.draft;
  if (!d.items.length) return;
  const name = prompt('Naam voor deze vaste maaltijd:', `Mijn ${d.meal.toLowerCase()}`);
  if (!name?.trim()) return;
  const p = profile();
  (p.favorites ||= []).push({
    id: uid(), name: name.trim(),
    items: d.items.map((it) => makeItem({ ...it, name: it.name.trim() || 'Onbekend' })),
  });
  save('eetmeter.profiles', profiles);
  toast(`"${name.trim()}" bewaard als vaste maaltijd`);
};

function renderFavorites() {
  const favs = profile().favorites || [];
  $('#fav-title').hidden = favs.length === 0;
  $('#favorites').innerHTML = favs.map((f, i) => `
    <div class="card result" data-fav="${i}">
      <span><b>★ ${esc(f.name)}</b><br><span class="muted small">${f.items.map((it) => esc(it.name)).join(', ')}</span></span>
      <span class="num">${round(sumItems(f.items).kcal)} kcal
        <button class="del" data-fav-del="${i}" aria-label="Vaste maaltijd verwijderen">×</button></span>
    </div>`).join('');
}

$('#favorites').onclick = (e) => {
  const favs = profile().favorites || [];
  const del = e.target.closest('[data-fav-del]');
  if (del) {
    const f = favs[Number(del.dataset.favDel)];
    if (!confirm(`Vaste maaltijd "${f.name}" verwijderen?`)) return;
    favs.splice(Number(del.dataset.favDel), 1);
    save('eetmeter.profiles', profiles);
    renderFavorites();
    return;
  }
  const card = e.target.closest('[data-fav]');
  if (card) addToDraft(favs[Number(card.dataset.fav)].items.map((it) => makeItem(it)));
};

// ---------- Water ----------

const WATER_GOAL = 8; // glazen van 250 ml, ongeveer 2 liter

function renderWater() {
  const n = water[state.date] || 0;
  $('#water-count').textContent = `${n} / ${WATER_GOAL} glazen`;
  $('#water-drops').innerHTML = Array.from({ length: Math.max(WATER_GOAL, n) }, (_, i) =>
    `<span class="drop ${i < n ? 'full' : ''}"></span>`).join('');
  $('#water-minus').disabled = n === 0;
}
function changeWater(delta) {
  water[state.date] = Math.max(0, (water[state.date] || 0) + delta);
  if (!water[state.date]) delete water[state.date];
  save(waterKey(), water);
  renderWater();
}
$('#water-plus').onclick = () => changeWater(1);
$('#water-minus').onclick = () => changeWater(-1);

// ---------- Maaltijdideeën ----------

const IDEAS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    ideas: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { title: { type: 'STRING' }, why: { type: 'STRING' }, items: AI_SCHEMA.properties.items },
        required: ['title', 'why', 'items'],
      },
    },
  },
  required: ['ideas'],
};

$('#ideas-btn').onclick = () => runAdvice($('#ideas-btn'), '#ideas-status', async () => {
  const p = profile();
  const items = dayItems(state.date);
  const t = sumItems(items);
  const leftKcal = round(p.goalKcal - t.kcal);
  const leftProtein = p.goalProtein ? round(p.goalProtein - t.protein) : null;
  const meal = defaultMeal().toLowerCase();
  const prompt = `Je bent een praktische voedingscoach die werkt volgens de Schijf van Vijf van het Voedingscentrum.
Het is ${new Date().toTimeString().slice(0, 5)}. Bedenk 3 ideeën voor de volgende maaltijd (waarschijnlijk ${meal}).
Dagdoel: ${p.goalKcal} kcal${p.goalProtein ? `, ${p.goalProtein} g eiwit` : ''}. ${p.answers ? goalDescription(p.answers) : ''}
Vandaag al gegeten: ${items.length ? items.map((it) => `${it.name} (${round(it.grams)} g)`).join('; ') : 'nog niets'}.
Nog over: ${leftKcal} kcal${leftProtein !== null ? `, ${leftProtein} g eiwit` : ''}.

Regels:
- Elk idee past bij wat er nog over is (ongeveer, niet meer). Is er weinig of niets over, stel dan lichte opties voor
  zoals groente, fruit, magere kwark of soep, en zeg vriendelijk dat dat prima is; nooit veroordelend.
- Gewone producten uit een Nederlandse supermarkt, klaar in maximaal 20 minuten.
- Zorg voor afwisseling met wat er vandaag al gegeten is, en let op eiwit en groente.
- "title": korte naam van het gerecht. "why": één zin waarom dit nu goed past.
- "items": de onderdelen met hoeveelheden en voedingswaardes, net zo als bij het analyseren van eten:
  naam, grams, unit_name, unit_grams, amount en per 100 g kcal, eiwit, koolhydraten, vet en vezels.
Schrijf in het Nederlands.`;
  const r = await askAI(prompt, IDEAS_SCHEMA);
  state.ideas = (r.ideas || []).slice(0, 3).map((idea) => ({
    title: String(idea.title || ''), why: String(idea.why || ''), items: aiResultToItems({ items: idea.items }),
  })).filter((idea) => idea.items.length);
  renderIdeas();
});

function renderIdeas() {
  const ideas = state.date === todayKey() ? state.ideas || [] : [];
  $('#ideas').innerHTML = ideas.map((idea, i) => {
    const t = sumItems(idea.items);
    return `<div class="card idea">
      <div class="idea-head"><b>${esc(idea.title)}</b><span class="num">${round(t.kcal)} kcal · ${round(t.protein)} g eiwit</span></div>
      <div class="muted small">${esc(idea.why)}</div>
      <div class="small">${idea.items.map((it) => `${esc(amountLabel(it))} ${esc(it.name)}`).join(' · ')}</div>
      <button class="btn secondary" data-idea="${i}">Dit ga ik eten</button>
    </div>`;
  }).join('');
}
$('#ideas').onclick = (e) => {
  const b = e.target.closest('[data-idea]');
  if (b) addToDraft(state.ideas[Number(b.dataset.idea)].items.map((it) => makeItem(it)));
};

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
  $('#goal-manual-note').hidden = !p.manualGoal;
  renderNevoStatus();
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
    profile().manualGoal = true; // niet meer automatisch bijwerken bij nieuw gewicht
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
  const blob = new Blob([JSON.stringify({ version: 2, profile: profile(), log, dayAdvice, water }, null, 2)], { type: 'application/json' });
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
    for (const [day, n] of Object.entries(data.water || {})) water[day] = Math.max(water[day] || 0, n);
    save(waterKey(), water);
    const p = profile();
    for (const w of data.profile?.weights || []) if (!p.weights?.some((x) => x.date === w.date)) recordWeight(p, w.kg, w.date);
    for (const f of data.profile?.favorites || []) if (!(p.favorites ||= []).some((x) => x.id === f.id)) p.favorites.push(f);
    save('eetmeter.profiles', profiles);
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
