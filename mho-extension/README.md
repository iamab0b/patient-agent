# CareGuide — Chrome Extension

AI-powered patient portal navigator for elderly users.
Built at UC Berkeley Hackathon 2026.

---

## Setup (5 minutes)

### 1. Add your Anthropic API key
Open `background.js` and find the fetch call to `api.anthropic.com`.
The API key is handled via your backend proxy (see step 3).

### 2. Load the extension in Chrome
1. Open Chrome and go to `chrome://extensions`
2. Toggle **Developer mode** ON (top right)
3. Click **Load unpacked**
4. Select this `careguide-extension/` folder
5. The CareGuide icon appears in your toolbar ✅

### 3. Run the FastAPI backend (for API key proxying)
```bash
cd backend/
pip install fastapi uvicorn anthropic httpx
uvicorn main:app --reload
```
Update `BACKEND_URL` in `background.js` to `http://localhost:8000`.

### 4. Test it
Go to any MyChart URL (or use the demo HTML below).
The sidebar should appear automatically on the right side.

---

## File Structure

```
careguide-extension/
├── manifest.json      ← Extension config + permissions
├── content.js         ← Runs on portal pages (DOM + voice + highlight)
├── background.js      ← Service worker (Claude API calls)
├── sidebar.css        ← Sidebar + highlight styles (injected into portal)
├── popup.html         ← Settings UI (opens when you click the icon)
├── popup.js           ← Settings load/save logic
└── icons/
    └── icon128.png    ← Extension icon (add your own)
```

---

## Key Features

| Feature | How it works |
|---|---|
| Auto-detect portal | Checks `window.location.hostname` against known portal domains |
| Voice input | Web Speech API — free, built into Chrome |
| DOM highlighting | Queries DOM for portal nav links, adds `.cg-highlight` CSS class |
| AI explanation | Calls Claude API via background.js service worker |
| Caregiver summary | Claude summarizes page content into plain-language SMS-ready text |
| Multilingual | Language passed to Claude in the system prompt |
| Settings | Saved to `chrome.storage.local` — persists across sessions |

---

## Demo Script (for judges)

1. Open browser → navigate to mychart.com (or demo page)
2. CareGuide sidebar appears automatically on the right
3. Tap 🎤 and say: *"I want to see my test results"*
4. Watch the correct nav button glow on screen
5. Select a lab result value → click "Explain this"
6. Tap "Send Summary to Caregiver" → show the plain-language output

---

## Hackathon Tips

- The **voice + DOM highlight** combo is your wow moment — demo this first
- Have a MyChart demo account ready, or use the portal's demo/sandbox URL
- If live portal isn't accessible, build a simple `demo.html` that mimics the portal UI
