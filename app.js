/* CardVault – scan visiting cards, extract contact details, save to phone, search by category. */
'use strict';

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
const esc = s => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- IndexedDB ----------
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('cardvault', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('cards', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(mode) { return this.db.transaction('cards', mode).objectStore('cards'); },
  all() { return new Promise((res, rej) => { const q = this.tx('readonly').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  put(c) { return new Promise((res, rej) => { const q = this.tx('readwrite').put(c); q.onsuccess = () => res(); q.onerror = () => rej(q.error); }); },
  del(id) { return new Promise((res, rej) => { const q = this.tx('readwrite').delete(id); q.onsuccess = () => res(); q.onerror = () => rej(q.error); }); }
};

// ---------- settings ----------
const Settings = {
  get() { try { return JSON.parse(localStorage.getItem('cv_settings') || '{}'); } catch { return {}; } },
  set(v) { localStorage.setItem('cv_settings', JSON.stringify(v)); }
};

// ---------- state ----------
let cards = [];
let filterCat = '';
let current = null;       // card being edited
let activeSlot = 'front';

// ---------- image handling ----------
function fileToDataURL(file, max = 1400, quality = 0.82) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read image')); };
    img.src = url;
  });
}

// ---------- parsing (offline OCR text -> fields) ----------
const COMPANY_WORDS = /\b(pvt|private|ltd|limited|llp|inc|corp|co\.|company|solutions|technologies|tech|enterprises|enterprise|industries|industry|traders|trading|associates|group|studio|studios|agency|labs|services|systems|international|exports|imports|packaging|printers|prints|printing|logistics|consultants|consulting|works|mart|store|shop|hub)\b/i;
const TITLE_WORDS = /\b(founder|co-?founder|ceo|cto|cfo|coo|md|director|manager|owner|partner|proprietor|head|lead|executive|officer|president|vice president|vp|sales|marketing|engineer|consultant|designer|associate|proprieter)\b/i;
const ADDR_WORDS = /\b(road|rd\.?|street|st\.?|floor|sector|nagar|colony|plot|block|building|bldg|tower|near|opp\.?|opposite|lane|marg|phase|industrial|area|extension|city|dist|district|state|india|delhi|mumbai|gurgaon|gurugram|noida|bangalore|bengaluru|chennai|hyderabad|pune|kolkata|jaipur|ghaziabad|faridabad)\b|\b\d{6}\b/i;

function parseCardText(text) {
  const out = { name: '', business: '', title: '', phone: '', phone2: '', email: '', website: '', address: '' };
  let lines = text.split(/\r?\n/).map(l => l.replace(/[|_]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(l => l.length > 1);
  const used = new Set();

  // email
  const em = text.match(/[A-Za-z0-9._%+-]+\s?@\s?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/);
  if (em) out.email = em[0].replace(/\s/g, '').toLowerCase();

  // website
  lines.forEach((l, i) => {
    if (out.website) return;
    if (/@/.test(l)) return;
    const m = l.match(/((https?:\/\/)?(www\.)[^\s,;]+)|([a-z0-9-]+\.(com|in|co\.in|org|net|io|biz|store|shop|co)\b[^\s,;]*)/i);
    if (m) { out.website = m[0].replace(/[.,;]+$/, '').toLowerCase(); }
  });

  // phones
  const phones = [];
  lines.forEach((l, i) => {
    if (/@/.test(l)) return;
    const found = l.match(/(\+?\d[\d\s().-]{7,}\d)/g);
    if (found) found.forEach(p => {
      const digits = p.replace(/\D/g, '');
      if (digits.length >= 10 && digits.length <= 13 && !(/^\d{6}$/.test(digits))) { phones.push(p.trim()); used.add(i); }
    });
  });
  const norm = p => { let d = p.replace(/[^\d+]/g, ''); if (/^\d{10}$/.test(d)) d = '+91' + d; return d; };
  const uniq = [...new Set(phones.map(norm))];
  out.phone = uniq[0] || ''; out.phone2 = uniq[1] || '';

  // mark email/website lines as used
  lines.forEach((l, i) => { if (/@/.test(l) || (out.website && l.toLowerCase().includes(out.website.replace(/^https?:\/\//, '')))) used.add(i); });

  // address: consecutive address-looking lines
  const addr = [];
  lines.forEach((l, i) => { if (!used.has(i) && ADDR_WORDS.test(l) && !TITLE_WORDS.test(l)) { addr.push(l); used.add(i); } });
  out.address = addr.join(', ');

  // title
  lines.forEach((l, i) => { if (!out.title && !used.has(i) && TITLE_WORDS.test(l) && l.split(' ').length <= 6) { out.title = l; used.add(i); } });

  // business
  lines.forEach((l, i) => { if (!out.business && !used.has(i) && COMPANY_WORDS.test(l)) { out.business = l; used.add(i); } });

  // name: first clean alphabetic line of 2-4 words
  lines.forEach((l, i) => {
    if (out.name || used.has(i)) return;
    const w = l.split(' ');
    if (w.length >= 2 && w.length <= 4 && /^[A-Za-z.\s'-]+$/.test(l)) { out.name = l.replace(/\b\w/g, c => c.toUpperCase()); used.add(i); }
  });

  // fallback business: first leftover line
  if (!out.business) lines.forEach((l, i) => { if (!out.business && !used.has(i) && /[A-Za-z]/.test(l) && l.length > 2) { out.business = l; used.add(i); } });
  return out;
}

// ---------- extraction ----------
async function ocrImages(dataUrls, onProgress) {
  if (!window.Tesseract) throw new Error('OCR engine not loaded (check internet once, then it works offline).');
  let text = '';
  for (let i = 0; i < dataUrls.length; i++) {
    const r = await Tesseract.recognize(dataUrls[i], 'eng', {
      logger: m => { if (m.status === 'recognizing text') onProgress && onProgress(Math.round(((i + m.progress) / dataUrls.length) * 100)); }
    });
    text += '\n' + r.data.text;
  }
  return text;
}

async function aiExtract(dataUrls, key) {
  const content = dataUrls.map(u => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: u.split(',')[1] } }));
  content.push({ type: 'text', text: 'These are photos of a business/visiting card (front, maybe back). Extract the contact details. Reply with ONLY a JSON object with keys: name, business, title, phone, phone2, email, website, address, category (a short 1-2 word industry/niche label for what the business does). Use empty string if missing. Phone numbers in international format if a country can be inferred.' });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 800, messages: [{ role: 'user', content }] })
  });
  if (!r.ok) throw new Error('AI request failed (' + r.status + ')');
  const j = await r.json();
  const txt = (j.content || []).map(c => c.text || '').join('');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI returned no data');
  return JSON.parse(m[0]);
}

// guess a category from the text if user did not give one
function guessCategory(f, rawText) {
  const t = (rawText || '') + ' ' + f.business;
  const map = [
    [/print|packag|label|box/i, 'Printing & Packaging'], [/gift|hamper|merch/i, 'Gifting'],
    [/event|wedding|decor|photo|entertain/i, 'Events'], [/logistic|transport|cargo|freight|courier/i, 'Logistics'],
    [/tech|software|app|digital|it\b|web/i, 'Technology'], [/market|ads|media|brand|creative|agency/i, 'Marketing'],
    [/food|cafe|restaurant|catering|bakery/i, 'Food'], [/real\s?estate|builder|propert|construction/i, 'Real Estate'],
    [/finance|invest|insurance|account|ca\b|tax|loan/i, 'Finance'], [/textile|garment|fashion|apparel/i, 'Fashion & Textile']
  ];
  for (const [re, c] of map) if (re.test(t)) return c;
  return '';
}

// ---------- vCard ----------
const vEsc = s => (s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
function toVCard(c) {
  const parts = (c.name || '').trim().split(/\s+/);
  const last = parts.length > 1 ? parts.pop() : '';
  const first = parts.join(' ');
  const L = ['BEGIN:VCARD', 'VERSION:3.0', `N:${vEsc(last)};${vEsc(first)};;;`, `FN:${vEsc(c.name || c.business || 'Unknown')}`];
  if (c.business) L.push('ORG:' + vEsc(c.business));
  if (c.title) L.push('TITLE:' + vEsc(c.title));
  if (c.phone) L.push('TEL;TYPE=WORK,VOICE:' + c.phone);
  if (c.phone2) L.push('TEL;TYPE=CELL:' + c.phone2);
  if (c.email) L.push('EMAIL;TYPE=INTERNET:' + c.email);
  if (c.website) L.push('URL:' + (/^https?:/.test(c.website) ? c.website : 'https://' + c.website));
  if (c.address) L.push('ADR;TYPE=WORK:;;' + vEsc(c.address) + ';;;;');
  if (c.category) L.push('CATEGORIES:' + vEsc(c.category));
  const note = [c.category && 'Category: ' + c.category, c.notes].filter(Boolean).join(' | ');
  if (note) L.push('NOTE:' + vEsc(note));
  L.push('END:VCARD');
  return L.join('\r\n');
}
async function shareOrDownload(filename, text, mime) {
  const file = new File([text], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
const fname = c => ((c.name || c.business || 'contact').replace(/[^\w]+/g, '_')) + '.vcf';

// ---------- list rendering ----------
function categories() { return [...new Set(cards.map(c => (c.category || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)); }
function render() {
  const q = $('#search').value.trim().toLowerCase();
  const cats = categories();
  $('#chips').innerHTML = ['', ...cats].map(c => `<button class="chip ${filterCat === c ? 'on' : ''}" data-cat="${esc(c)}">${c ? esc(c) + ' (' + cards.filter(x => x.category === c).length + ')' : 'All (' + cards.length + ')'}</button>`).join('');
  $('#catList').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
  const list = cards.filter(c => (!filterCat || c.category === filterCat) &&
    (!q || [c.name, c.business, c.title, c.phone, c.phone2, c.email, c.address, c.category, c.notes].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => b.createdAt - a.createdAt);
  $('#list').innerHTML = list.map(c => `<li class="item" data-id="${c.id}">
      ${c.front ? `<img class="thumb" src="${c.front}" alt="">` : '<div class="thumb"></div>'}
      <div><div class="t">${esc(c.name || c.business || 'Unnamed')}</div>
      <div class="s">${esc([c.business && c.name ? c.business : '', c.phone].filter(Boolean).join(' · '))}</div>
      ${c.category ? `<span class="tag">${esc(c.category)}</span>` : ''}</div></li>`).join('');
  $('#empty').classList.toggle('hidden', cards.length > 0);
  $('#count').textContent = cards.length ? `${list.length} of ${cards.length} cards` : '';
}

// ---------- sheet (add / edit) ----------
function openSheet(card) {
  current = card ? { ...card } : { id: uid(), createdAt: Date.now(), front: '', back: '', extra: '' };
  const isNew = !card;
  $('#sheetTitle').textContent = isNew ? 'New card' : 'Edit card';
  const f = $('#form');
  ['name', 'business', 'title', 'category', 'phone', 'phone2', 'email', 'website', 'address', 'notes'].forEach(k => f.elements[k].value = current[k] || '');
  ['front', 'back', 'extra'].forEach(s => setPhoto(s, current[s]));
  $('#status').textContent = '';
  $('#detailActions').classList.toggle('hidden', isNew);
  $('#btnExtract').classList.remove('hidden');
  activeSlot = 'front'; markActive();
  $('#sheet').classList.remove('hidden'); $('#sheet').scrollTop = 0;
  updateLinks();
}
function closeSheet() { $('#sheet').classList.add('hidden'); current = null; }
function setPhoto(slot, url) {
  const el = $(`.photo[data-slot="${slot}"]`);
  el.classList.toggle('has', !!url); $('img', el).src = url || '';
}
function markActive() { $$('.photo').forEach(p => p.classList.toggle('active', p.dataset.slot === activeSlot)); }
function readForm() {
  const o = {}; new FormData($('#form')).forEach((v, k) => o[k] = String(v).trim()); return o;
}
function updateLinks() {
  const f = readForm();
  $('#lnkCall').href = f.phone ? 'tel:' + f.phone.replace(/[^\d+]/g, '') : '#';
  $('#lnkMail').href = f.email ? 'mailto:' + f.email : '#';
  $('#lnkCall').classList.toggle('hidden', !f.phone); $('#lnkMail').classList.toggle('hidden', !f.email);
}
async function handleFile(slot, file) {
  if (!file) return;
  try { current[slot] = await fileToDataURL(file); setPhoto(slot, current[slot]); activeSlot = slot; markActive(); $('#status').textContent = 'Photo added. Tap "Extract details" when front/back are ready.'; }
  catch (e) { toast(e.message); }
}
async function extract() {
  const imgs = [current.front, current.back, current.extra].filter(Boolean);
  if (!imgs.length) return toast('Add a photo of the card first');
  const st = $('#status'); $('#btnExtract').disabled = true;
  try {
    const s = Settings.get();
    let fields, raw = '';
    if (s.apiKey && s.useAI) {
      st.textContent = 'Reading card with AI…';
      fields = await aiExtract(imgs.slice(0, 2), s.apiKey);
    } else {
      st.textContent = 'Reading card… 0%';
      raw = await ocrImages(imgs.slice(0, 2), p => st.textContent = `Reading card… ${p}%`);
      fields = parseCardText(raw);
    }
    const f = $('#form');
    for (const k of ['name', 'business', 'title', 'phone', 'phone2', 'email', 'website', 'address']) if (fields[k]) f.elements[k].value = fields[k];
    if (!f.elements.category.value) f.elements.category.value = fields.category || guessCategory(fields, raw);
    st.textContent = 'Done — please check the details below and fix anything wrong.';
    updateLinks();
  } catch (e) { st.textContent = 'Extraction failed: ' + e.message + ' You can still type the details in.'; }
  $('#btnExtract').disabled = false;
}
async function save(silent) {
  const f = readForm();
  if (!f.name && !f.business && !f.phone && !f.email) return toast('Nothing to save yet'), false;
  Object.assign(current, f);
  await DB.put(current);
  cards = await DB.all(); render();
  if (!silent) toast('Saved');
  return true;
}

// ---------- backup ----------
function download(name, text, mime) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// ---------- wire up ----------
async function init() {
  await DB.open(); cards = await DB.all(); render();

  $('#search').addEventListener('input', render);
  $('#chips').addEventListener('click', e => { const b = e.target.closest('.chip'); if (b) { filterCat = b.dataset.cat; render(); } });
  $('#list').addEventListener('click', e => { const li = e.target.closest('.item'); if (li) openSheet(cards.find(c => c.id === li.dataset.id)); });
  $('#fab').addEventListener('click', () => openSheet(null));
  $('#btnClose').addEventListener('click', closeSheet);
  $('#btnSave').addEventListener('click', async () => { if (await save()) closeSheet(); });
  $('#btnExtract').addEventListener('click', extract);
  $('#form').addEventListener('input', updateLinks);

  $$('.photo').forEach(p => {
    const inp = $('input', p);
    p.addEventListener('click', () => { activeSlot = p.dataset.slot; markActive(); });
    inp.addEventListener('change', () => { handleFile(p.dataset.slot, inp.files[0]); inp.value = ''; });
  });
  const gal = document.createElement('input'); gal.type = 'file'; gal.accept = 'image/*';
  gal.addEventListener('change', () => { handleFile(activeSlot, gal.files[0]); gal.value = ''; });
  $('#btnGallery').addEventListener('click', () => gal.click());

  $('#btnVcf').addEventListener('click', async () => {
    if (!(await save(true))) return;
    await shareOrDownload(fname(current), toVCard(current), 'text/vcard');
    toast('Open the .vcf to add it to your phone contacts', 3500);
  });
  $('#btnDelete').addEventListener('click', async () => {
    if (!confirm('Delete this card?')) return;
    await DB.del(current.id); cards = await DB.all(); closeSheet(); render(); toast('Deleted');
  });

  // menu
  const menu = $('#menu');
  $('#btnMenu').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('hidden'); });
  document.addEventListener('click', () => menu.classList.add('hidden'));
  $('#btnExportVcf').addEventListener('click', () => {
    const list = cards.filter(c => !filterCat || c.category === filterCat);
    if (!list.length) return toast('No cards to export');
    shareOrDownload(filterCat ? `cardvault_${filterCat.replace(/\W+/g, '_')}.vcf` : 'cardvault_all.vcf', list.map(toVCard).join('\r\n'), 'text/vcard');
  });
  $('#btnExportJson').addEventListener('click', () => download('cardvault_backup.json', JSON.stringify(cards), 'application/json'));
  $('#btnImportJson').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async e => {
    try {
      const arr = JSON.parse(await e.target.files[0].text());
      for (const c of arr) if (c && c.id) await DB.put(c);
      cards = await DB.all(); render(); toast('Restored ' + arr.length + ' cards');
    } catch { toast('Invalid backup file'); }
    e.target.value = '';
  });

  // settings
  $('#btnSettings').addEventListener('click', () => {
    const s = Settings.get(); $('#apiKey').value = s.apiKey || ''; $('#useAI').checked = !!s.useAI; $('#settings').classList.remove('hidden');
  });
  $('#btnSetClose').addEventListener('click', () => $('#settings').classList.add('hidden'));
  $('#btnSetSave').addEventListener('click', () => {
    Settings.set({ apiKey: $('#apiKey').value.trim(), useAI: $('#useAI').checked });
    $('#settings').classList.add('hidden'); toast('Settings saved');
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
