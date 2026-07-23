# CareGuide

**An AI patient-navigation copilot for elderly and low-tech-literacy patients, built into the browser.**

🏆 Built at the UC Berkeley AI Hackathon (2026)

---

## The problem

Patient portals (MyChart and similar) are dense, jargon-heavy, and were never designed for the people who rely on them most: elderly patients managing chronic conditions, often without a caregiver in the room. A patient trying to find "my last A1C result" has to navigate unlabeled nav trees and clinical shorthand with zero guidance — and when they can't, the burden falls on an adult child or caregiver who isn't there.

CareGuide sits on top of any patient portal as a Chrome extension and acts as a voice-driven, plain-language interpreter between the patient and the portal — without requiring the healthcare system to change a single line of their software.

## How it works

CareGuide is an **agentic browser layer**, not a chatbot bolted onto a page. It observes the DOM, understands user intent from voice or text, acts on the page (highlighting the real nav element the user needs), and closes the loop by generating a caregiver-ready summary — all without the portal provider's cooperation or an API integration.

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│   content.js     │      │  background.js    │      │   FastAPI proxy  │
│  (runs on portal)│─────▶│ (service worker)   │─────▶│  (key handling,  │
│                  │◀─────│                    │◀─────│   Claude API)    │
│ • DOM scan       │      │ • Voice→intent     │      └─────────────────┘
│ • Voice capture   │      │ • Highlight target │
│ • Highlight inject│      │ • Summary request  │
└─────────────────┘      └──────────────────┘
```

**Flow:** patient speaks → Web Speech API transcribes → intent sent to Claude via the background service worker → Claude maps intent to a DOM target → `content.js` highlights the real element on the live page → on request, Claude condenses the visible page into an SMS-ready plain-language summary for a caregiver.

## Why this design

- **API key never touches the client.** All Claude calls are proxied through a local FastAPI backend — the extension itself holds no secret, which matters for anything meant to run beyond a hackathon demo.
- **Portal-agnostic by design.** Detection is domain-based (`window.location.hostname` against known portal domains) and DOM-based rather than hardcoded per-provider, so adding a new portal doesn't require a new integration.
- **Voice is the primary interface, not an add-on.** For the target user, typing is often the actual barrier — voice-first was a deliberate accessibility choice, not a demo gimmick.
- **The caregiver summary is the actual deliverable.** The highlight/voice interaction is the "wow" moment for a demo, but the SMS-ready summary is the feature that closes the loop for the person who isn't in the room.

## Tech stack

| Layer | Choice |
|---|---|
| Extension | Manifest V3, vanilla JS (content script + service worker) |
| Voice input | Web Speech API (native, no external dependency) |
| AI | Claude API (Anthropic) — intent parsing, DOM target mapping, summarization |
| Backend | FastAPI + `anthropic` + `httpx` (key proxying only) |
| Persistence | `chrome.storage.local` for settings |
| Styling | Injected CSS (`sidebar.css`) scoped to avoid portal style collisions |

## Key features

| Feature | Implementation |
|---|---|
| Auto-detect portal | Hostname match against known portal domains on page load |
| Voice input | Web Speech API transcription, passed to Claude for intent extraction |
| DOM highlighting | Queries portal nav structure, applies `.cg-highlight` to the matched element |
| AI explanation | Claude API call (via background worker) explains selected page content in plain language |
| Caregiver summary | Claude condenses visible page content into an SMS-length, jargon-free summary |
| Multilingual | Target language passed in the Claude system prompt |
| Settings | Persisted via `chrome.storage.local` across sessions |

## Setup

**1. Backend (handles the Claude API key — never exposed to the client)**
```bash
cd backend/
pip install fastapi uvicorn anthropic httpx
uvicorn main:app --reload
```
Add your Anthropic API key to the backend's environment (see `backend/main.py`), not to `background.js`.

**2. Load the extension**
- `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `careguide-extension/`
- Confirm `BACKEND_URL` in `background.js` points to `http://localhost:8000`

**3. Try it**
- Navigate to a MyChart URL (or the included `demo.html`) — the sidebar appears automatically
- Say *"I want to see my test results"* — watch the matching nav element highlight
- Select a result → **Explain this**
- **Send Summary to Caregiver** → view the plain-language output

## File structure

```
careguide-extension/
├── manifest.json      — extension config + permissions
├── content.js         — runs on portal pages (DOM scan, voice capture, highlighting)
├── background.js      — service worker (Claude API orchestration)
├── sidebar.css         — injected sidebar + highlight styles
├── popup.html/js       — settings UI
└── icons/
backend/
└── main.py            — FastAPI proxy (key handling, Claude calls)
```

## Roadmap / what's next

- [ ] Persistent caregiver linking (SMS delivery, not just copy-paste output)
- [ ] Expand portal detection beyond hostname matching to handle white-labeled portal instances
- [ ] Session-level conversation memory so follow-up questions don't require re-establishing context
- [ ] Accessibility audit (screen reader compatibility, WCAG pass)

## Demo script (hackathon judging)

1. Navigate to a MyChart URL (or `demo.html`)
2. Sidebar appears automatically
3. Tap 🎤 → *"I want to see my test results"* → matching nav element highlights
4. Select a lab value → **Explain this**
5. **Send Summary to Caregiver** → show plain-language output

---

Built by our team at the UC Berkeley AI Hackathon, 2026.
