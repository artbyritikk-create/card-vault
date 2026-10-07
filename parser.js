/* Turns raw OCR text from a visiting card into contact fields. Pure functions (testable in Node). */
(function (root) {
  const CO = /\b(pvt|private|ltd|limited|llp|inc|corp|company|solutions?|technologies|tech|enterprises?|industries|industry|traders?|trading|associates|group|studios?|agency|labs|services|systems|international|exports?|imports?|printers|prints|printing|logistics|consultants?|consulting|works|mart|store|shop|hub|creations|designs?|graphics|advertising|advertisers|packaging|ventures|infra|builders)\b/i;
  const LEGAL = /\b(pvt|private|ltd|limited|llp|inc|corp)\b/i;
  const TITLE = /\b(founder|co-?founder|ceo|cto|cfo|coo|md|managing director|director|manager|owner|partner|proprietor|proprieter|head|lead|executive|officer|president|vice president|vp|engineer|consultant|designer|associate|sales|marketing)\b/i;
  const SERVICE = /\b(printing|wallpaper|board|sign|signage|stand|vinyl|flex|solutions?|services?|branding|advertising|display|offset|catalogue?|brochure|leaflet|hoardings?|acrylic|canvas|sticker|label)\b/i;
  const ADDR_START = /^(regd\.?\s*office|registered\s*office|head\s*office|office|works|factory|showroom|shop|address|add)\s*[:\-.]/i;
  const ADDR_WORD = /\b(road|rd|street|st|floor|sector|nagar|vihar|colony|plot|block|building|tower|near|opp|opposite|lane|marg|phase|industrial|area|extn?|extension|new delhi|delhi|mumbai|gurgaon|gurugram|noida|bangalore|bengaluru|chennai|hyderabad|pune|kolkata|jaipur|ghaziabad|faridabad|india)\b/i;
  const GENERIC_MAIL = /^(gmail|yahoo|hotmail|outlook|rediffmail|icloud|proton|live)\./i;

  const wc = s => s.split(/\s+/).filter(Boolean).length;
  const titleCase = s => s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());

  function normPhone(raw) {
    const d = raw.replace(/\D/g, '');
    if (d.length < 8 || d.length > 13) return '';
    const last10 = d.slice(-10);
    // Indian mobile: 10 digits starting 6-9, optionally with 91 / 0 / stray icon digit in front
    if (d.length >= 10 && d.length <= 12 && /^[6-9]/.test(last10)) return '+91' + last10;
    if (d.length === 13 && d.startsWith('91') === false && /^[6-9]/.test(last10)) return '+91' + last10;
    if (d.length >= 10 && d.startsWith('0')) return d;       // landline with STD code
    if (d.length >= 10) return d;
    return d;                                                // short landline
  }

  function parseCardText(text) {
    const out = { name: '', business: '', title: '', phone: '', phone2: '', email: '', website: '', address: '', about: '', phones: [], score: 0 };
    let lines = text.split(/\r?\n/).map(l => l.replace(/[|_•·►▶■□]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(l => l.length > 1);

    // 1. emails (removed from the line so the rest of the line can still hold a name)
    const EM = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
    const emails = [];
    lines = lines.map(l => l.replace(EM, m => { emails.push(m.replace(/\s/g, '').toLowerCase()); return ' CTCT '; }).replace(/\s+/g, ' ').trim());
    out.email = emails[0] || '';

    // 2. website
    const WEB = /(?:https?:\/\/)?(?:www\.)[^\s,;]+|\b[a-z0-9-]+\.(?:com|in|co\.in|org|net|io|biz|store|shop|co|online)\b[^\s,;]*/i;
    lines = lines.map(l => {
      if (out.website) return l;
      const m = l.match(WEB);
      if (!m) return l;
      out.website = m[0].replace(/[.,;]+$/, '').toLowerCase();
      return l.replace(m[0], ' CTCT ').replace(/\s+/g, ' ').trim();
    });

    // 3. phones (strip them from the line, remember where they were)
    const PH = /\+?\d[\d\s().-]{6,}\d/g;
    const contactIdx = [];
    const phones = [];
    lines = lines.map((l, i) => {
      let hit = false;
      const rest = l.replace(PH, m => {
        const p = normPhone(m);
        if (p) { phones.push(p); hit = true; return ' CTCT '; }
        return m;
      }).replace(/\s+/g, ' ').trim();
      return rest;
    });
    const uniq = [...new Set(phones)];
    out.phones = uniq; out.phone = uniq[0] || ''; out.phone2 = uniq[1] || '';

    // 4. clean stray icon characters; remember where contact details were (anchors for the name)
    const kept = [];
    lines.forEach(l => {
      const had = /CTCT/.test(l);
      const c = l.replace(/CTCT/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/^[\d&@©®~•*]\s+(?=[A-Za-z])/, '').replace(/^[^A-Za-z0-9+(]+/, '').replace(/[\s&@,;:-]+$/, '').trim();
      if (c.length > 1) { if (had) contactIdx.push(kept.length); kept.push(c); }
      else if (had) contactIdx.push(kept.length - 0.5);
    });
    lines = kept;
    const used = new Set();

    // 5. address lines
    const addr = [];
    lines.forEach((l, i) => {
      const hasPin = /\b\d{6}\b/.test(l);
      if (ADDR_START.test(l) || hasPin || (ADDR_WORD.test(l) && /\d/.test(l) && wc(l) <= 18)) {
        addr.push(l.replace(ADDR_START, '').trim()); used.add(i);
      }
    });
    out.address = addr.join('\n');

    // 6. designation
    lines.forEach((l, i) => { if (!out.title && !used.has(i) && TITLE.test(l) && wc(l) <= 6 && !/\d/.test(l) && !SERVICE.test(l)) { out.title = l; used.add(i); } });

    // 7. name – must sit near contact details, look like a person's name and not like a service
    const cands = [];
    lines.forEach((l, i) => {
      if (used.has(i)) return;
      const w = wc(l);
      if (w < 2 || w > 4 || !/^[A-Za-z.'\- ]+$/.test(l)) return;
      if (CO.test(l) || SERVICE.test(l)) return;
      cands.push(i);
    });
    const hasContact = out.email || out.phone || out.website;
    if (cands.length && hasContact) {
      const anchors = contactIdx.length ? contactIdx : [Math.min(...cands) + 1];
      const dist = i => Math.min(...anchors.map(a => Math.abs(i - a)));
      cands.sort((a, b) => dist(a) - dist(b));
      const best = cands[0];
      if (dist(best) <= 3) { out.name = titleCase(lines[best]); used.add(best); }
    }

    // 8. business
    const bcands = [];
    lines.forEach((l, i) => {
      if (used.has(i)) return;
      const letters = (l.match(/[A-Za-z]/g) || []).length;
      if (l.length < 3 || letters < 3 || letters / l.length < 0.7) return;
      if (wc(l) > 5 || /,/.test(l)) return;
      bcands.push(i);
    });
    const legal = bcands.find(i => LEGAL.test(lines[i]));
    const pick = legal ?? bcands[0];
    if (pick !== undefined) { out.business = lines[pick]; used.add(pick); }
    if (!out.business) {
      const dom = (out.email.split('@')[1] || '');
      const src = (!dom || GENERIC_MAIL.test(dom)) ? out.website.replace(/^(https?:\/\/)?(www\.)?/, '') : dom;
      const base = (src || '').split('.')[0];
      if (base) out.business = titleCase(base);
    }

    // 9. what they do: long leftover lines
    const about = lines.filter((l, i) => !used.has(i) && wc(l) >= 5).join('. ');
    out.about = about.length > 300 ? about.slice(0, 297) + '…' : about;

    out.score = (out.email ? 1 : 0) + (out.phone ? 1 : 0) + (out.name ? 1 : 0) + (out.website ? 1 : 0);
    out.raw = text;
    return out;
  }

  // Combine front / back / extra results: contact-rich side wins each field.
  function mergeSides(results) {
    const order = [...results].sort((a, b) => b.score - a.score);
    const m = { name: '', business: '', title: '', phone: '', phone2: '', email: '', website: '', address: '', about: '' };
    for (const k of Object.keys(m)) for (const r of order) if (!m[k] && r[k]) m[k] = r[k];
    const phones = [...new Set(results.flatMap(r => r.phones))];
    m.phone = phones[0] || ''; m.phone2 = phones[1] || '';
    m.raw = results.map(r => r.raw).join('\n');
    return m;
  }

  function guessCategory(f) {
    const t = ((f.raw || '') + ' ' + (f.business || '') + ' ' + (f.about || '')).toLowerCase();
    const map = [
      [/signage|sign\s?board|flex|vinyl|hoarding|advertis|branding|wallpaper|acp/, 'Advertising & Signage'],
      [/packag|carton|corrugat|label|box/, 'Packaging'],
      [/print|offset|press/, 'Printing'],
      [/gift|hamper|merch|trophy|award/, 'Gifting'],
      [/event|wedding|decor|photograph|entertain|tent|catering/, 'Events'],
      [/logistic|transport|cargo|freight|courier|truck/, 'Logistics'],
      [/software|app development|digital marketing|web|it services|technolog/, 'Technology'],
      [/food|cafe|restaurant|bakery|sweets/, 'Food'],
      [/real\s?estate|builder|propert|construction/, 'Real Estate'],
      [/finance|invest|insurance|account|tax|loan|ca\b/, 'Finance'],
      [/textile|garment|fashion|apparel|boutique/, 'Fashion & Textile']
    ];
    for (const [re, c] of map) if (re.test(t)) return c;
    return '';
  }

  const api = { parseCardText, mergeSides, guessCategory };
  if (typeof module !== 'undefined') module.exports = api; else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
