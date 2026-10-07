# CardVault

Scan visiting cards (front, back and an optional extra photo), auto-extract name, business, phone, email, website and address, save the contact to your phone, and organise everything by business category so you can pull up everyone in the same niche.

Pure static web app (no build step, no server). Installs on your phone as a PWA.

## Features
- Camera capture or gallery upload for front / back / extra photo
- Offline OCR with Tesseract.js; optional AI extraction (Claude) via your own API key in Settings
- Editable fields, so you can correct anything the scanner gets wrong
- **Save to phone contacts**: exports a `.vcf` and opens the phone share sheet / contact import
- Categories with filter chips + free-text search across all fields
- Export all (or just the filtered category) as `.vcf`; JSON backup / restore
- Data is stored only on your device (IndexedDB)

## Run locally
```bash
python3 -m http.server 8000
# open http://localhost:8000  (camera needs https or localhost)
```

## Deploy on GitHub Pages
1. Push this folder to a new GitHub repo.
2. Repo **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, folder = `/ (root)`.
3. Open `https://<your-username>.github.io/<repo>/` on your phone, then **Add to Home Screen** (Android: menu → *Install app*; iPhone: Share → *Add to Home Screen*).

## Notes
- Browsers cannot write to the phone's address book directly, so "Save to phone" uses a vCard file; tapping it imports the contact in one step.
- The AI API key (optional) stays in your browser's localStorage and is sent only to api.anthropic.com. Do not use it on a shared device.
- OCR accuracy depends on photo quality: good light, card flat, fill the frame.
