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
const ocrCache = {};      // slot -> hi-res, contrast-boosted copy used only for reading text

// ---------- image handling ----------
// Hi-res grayscale copy with stretched contrast: text on a small card photo needs the pixels.
function fileToOcrImage(file, max = 2800) {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1.5, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
      const d = x.getImageData(0, 0, c.width, c.height), px = d.data;
      let lo = 255, hi = 0; const g = new Uint8Array(px.length / 4);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) { const v = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0; g[j] = v; }
      const hist = new Uint32Array(256); g.forEach(v => hist[v]++);
      const total = g.length; let acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.01) { lo = v; break; } }
      acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.01) { hi = v; break; } }
      const span = Math.max(1, hi - lo);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) { const v = Math.max(0, Math.min(255, ((g[j] - lo) * 255 / span) | 0)); px[i] = px[i + 1] = px[i + 2] = v; }
      x.putImageData(d, 0, 0); URL.revokeObjectURL(url);
      res(c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read image')); };
    img.src = url;
  });
}

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

// ---------- extraction ----------
async function ocrImages(dataUrls, onProgress) {
  if (!window.Tesseract) throw new Error('OCR engine not loaded (connect to the internet once, then it works offline).');
  const texts = [];
  for (let i = 0; i < dataUrls.length; i++) {
    const r = await Tesseract.recognize(dataUrls[i], 'eng', {
      logger: m => { if (m.status === 'recognizing text') onProgress && onProgress(Math.round(((i + m.progress) / dataUrls.length) * 100)); }
    });
    texts.push(r.data.text);
  }
  return texts;
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
  Object.keys(ocrCache).forEach(k => delete ocrCache[k]);
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
  try { current[slot] = await fileToDataURL(file); ocrCache[slot] = await fileToOcrImage(file); setPhoto(slot, current[slot]); activeSlot = slot; markActive(); $('#status').textContent = 'Photo added. Tap "Extract details" when front/back are ready.'; }
  catch (e) { toast(e.message); }
}
async function extract() {
  const slots = ['front', 'back', 'extra'].filter(k => current[k]);
  if (!slots.length) return toast('Add a photo of the card first');
  const st = $('#status'); $('#btnExtract').disabled = true;
  try {
    const cfg = Settings.get();
    let fields;
    if (cfg.apiKey && cfg.useAI) {
      st.textContent = 'Reading card with AI…';
      fields = await aiExtract(slots.slice(0, 2).map(k => current[k]), cfg.apiKey);
      if (fields.category == null) fields.category = '';
    } else {
      st.textContent = 'Reading card… 0%';
      const imgs = slots.slice(0, 3).map(k => ocrCache[k] || current[k]);
      const texts = await ocrImages(imgs, p => st.textContent = `Reading card… ${p}%`);
      fields = mergeSides(texts.map(parseCardText));
      fields.category = guessCategory(fields);
    }
    const f = $('#form');
    for (const k of ['name', 'business', 'title', 'phone', 'phone2', 'email', 'website', 'address']) if (fields[k]) f.elements[k].value = fields[k];
    if (!f.elements.category.value && fields.category) f.elements.category.value = fields.category;
    if (!f.elements.notes.value && fields.about) f.elements.notes.value = fields.about;
    const missing = ['name', 'phone', 'email'].filter(k => !f.elements[k].value);
    st.textContent = missing.length ? `Done. Couldn't find: ${missing.join(', ')} — retake a sharper, closer photo or type it in.` : 'Done — please check the details below and fix anything wrong.';
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
