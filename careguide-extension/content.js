// ─── CareGuide Content Script ───────────────────────────────────────────────
// Runs on patient portal pages. Detects the portal, injects the sidebar,
// handles voice input, and highlights DOM elements based on user intent.

const PORTALS = {
  "mychart.com": "Epic MyChart",
  "followmyhealth.com": "FollowMyHealth",
  "healow.com": "Healow",
  "athenahealth.com": "Athena Health",
  "cerner.com": "Cerner",
};

// ── 1. Detect which portal we're on ─────────────────────────────────────────
function detectPortal() {
  const host = window.location.hostname;
  for (const [domain, name] of Object.entries(PORTALS)) {
    if (host.includes(domain)) return name;
  }
  return "Patient Portal";
}

// ── 2. Inject the sidebar into the page ─────────────────────────────────────
function injectSidebar(portalName) {
  if (document.getElementById("careguide-sidebar")) return; // already injected

  const sidebar = document.createElement("div");
  sidebar.id = "careguide-sidebar";
  sidebar.innerHTML = `
    <div id="cg-header">
      <span id="cg-logo">🩺 CareGuide</span>
      <span id="cg-portal-name">${portalName}</span>
      <button id="cg-close" title="Close">✕</button>
    </div>

    <div id="cg-voice-section">
      <button id="cg-voice-btn" title="Tap and speak">
        🎤 <span id="cg-voice-label">Tap to speak</span>
      </button>
      <div id="cg-transcript"></div>
    </div>

    <div id="cg-response-section">
      <div id="cg-response-text">
        Hi! I'm CareGuide. Tap the mic and tell me what you'd like to do,
        or select any text on the page and I'll explain it for you.
      </div>
    </div>

    <div id="cg-actions">
      <button class="cg-action-btn" data-intent="appointments">📅 Appointments</button>
      <button class="cg-action-btn" data-intent="results">🧪 Test Results</button>
      <button class="cg-action-btn" data-intent="medications">💊 Medications</button>
      <button class="cg-action-btn" data-intent="messages">✉️ Messages</button>
    </div>

    <div id="cg-caregiver-section">
      <button id="cg-caregiver-btn">📤 Send Summary to Caregiver</button>
    </div>

    <div id="cg-language-section">
      <select id="cg-language-select">
        <option value="en">English</option>
        <option value="es">Español</option>
        <option value="zh">中文</option>
        <option value="hi">हिन्दी</option>
        <option value="ur">اردو</option>
      </select>
    </div>
  `;

  document.body.appendChild(sidebar);
  attachSidebarEvents();
}

// ── 3. Voice Input (Web Speech API) ─────────────────────────────────────────
let recognition;

function startVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setResponse("Voice isn't supported in this browser. Please use Chrome.");
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = getSelectedLanguage();
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  document.getElementById("cg-voice-btn").classList.add("listening");
  document.getElementById("cg-voice-label").textContent = "Listening...";

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    document.getElementById("cg-transcript").textContent = `"${transcript}"`;
    handleUserIntent(transcript);
  };

  recognition.onerror = () => {
    stopVoice();
    setResponse("Sorry, I couldn't hear that. Please try again.");
  };

  recognition.onend = stopVoice;
  recognition.start();
}

function stopVoice() {
  document.getElementById("cg-voice-btn")?.classList.remove("listening");
  const label = document.getElementById("cg-voice-label");
  if (label) label.textContent = "Tap to speak";
}

// ── 4. Handle User Intent ────────────────────────────────────────────────────
// Maps what the user said to a portal navigation action or AI explanation.
function handleUserIntent(text) {
  const lower = text.toLowerCase();
  setResponse("Thinking...");

  // Try to navigate the portal via DOM element highlighting
  if (matchesIntent(lower, ["appointment", "schedule", "doctor visit", "book"])) {
    highlightElement("appointments");
    return;
  }
  if (matchesIntent(lower, ["result", "lab", "blood", "test"])) {
    highlightElement("results");
    return;
  }
  if (matchesIntent(lower, ["medication", "prescription", "pill", "medicine", "refill"])) {
    highlightElement("medications");
    return;
  }
  if (matchesIntent(lower, ["message", "inbox", "doctor message", "contact"])) {
    highlightElement("messages");
    return;
  }

  // Fall through to Claude AI for explanation
  askClaude(text);
}

function matchesIntent(text, keywords) {
  return keywords.some((kw) => text.includes(kw));
}

// ── 5. DOM Highlighting ──────────────────────────────────────────────────────
// Tries to find and visually highlight the relevant link/button on the portal.
const PORTAL_SELECTORS = {
  appointments: [
    'a[href*="appointment"]', 'a[href*="schedule"]',
    'button[aria-label*="appointment" i]', '[data-test*="appointment"]',
    'a[href*="visit"]', 'nav a:contains("Appointment")',
  ],
  results: [
    'a[href*="result"]', 'a[href*="lab"]', 'a[href*="test"]',
    'button[aria-label*="result" i]', '[data-test*="result"]',
  ],
  medications: [
    'a[href*="medication"]', 'a[href*="prescription"]', 'a[href*="refill"]',
    'button[aria-label*="medication" i]',
  ],
  messages: [
    'a[href*="message"]', 'a[href*="inbox"]',
    'button[aria-label*="message" i]', '[data-test*="message"]',
  ],
};

let lastHighlighted = null;

function highlightElement(intent) {
  // Clear previous highlight
  if (lastHighlighted) {
    lastHighlighted.classList.remove("cg-highlight");
    lastHighlighted = null;
  }

  const selectors = PORTAL_SELECTORS[intent] || [];
  let found = null;

  for (const selector of selectors) {
    try {
      found = document.querySelector(selector);
      if (found) break;
    } catch (_) {}
  }

  // Fallback: text-based search
  if (!found) {
    found = findByText(intent);
  }

  if (found) {
    found.classList.add("cg-highlight");
    found.scrollIntoView({ behavior: "smooth", block: "center" });
    lastHighlighted = found;
    setResponse(`I found the ${intent} section and highlighted it for you. Click the glowing button to continue.`);
    speak(`I found the ${intent} section. It's highlighted on your screen.`);
  } else {
    setResponse(`I couldn't find a "${intent}" button on this page. Try scrolling down or check the navigation menu.`);
  }
}

function findByText(intent) {
  const keywords = {
    appointments: ["appointment", "schedule", "visit"],
    results: ["results", "lab results", "test results"],
    medications: ["medications", "prescriptions", "refills"],
    messages: ["messages", "inbox", "message center"],
  }[intent] || [];

  const all = [...document.querySelectorAll("a, button, [role='menuitem']")];
  for (const el of all) {
    const text = el.textContent.toLowerCase().trim();
    if (keywords.some((kw) => text.includes(kw))) return el;
  }
  return null;
}

// ── 6. Claude AI Explanation ─────────────────────────────────────────────────
async function askClaude(userText) {
  try {
    // Get selected text from page for context
    const selectedText = window.getSelection()?.toString() || "";
    const language = getSelectedLanguageLabel();

    const response = await chrome.runtime.sendMessage({
      type: "ASK_CLAUDE",
      payload: {
        userText,
        selectedText,
        language,
        portalName: detectPortal(),
      },
    });

    if (response?.reply) {
      setResponse(response.reply);
      speak(response.reply);
    } else {
      setResponse("I had trouble getting a response. Please try again.");
    }
  } catch (err) {
    setResponse("Connection error. Please check your internet.");
  }
}

// ── 7. Text-to-Speech ────────────────────────────────────────────────────────
function speak(text) {
  chrome.storage.local.get("voiceEnabled", ({ voiceEnabled }) => {
    if (voiceEnabled === false) return;
    chrome.tts.speak(text, { rate: 0.9, pitch: 1.0 });
  });
}

// ── 8. Caregiver Summary ─────────────────────────────────────────────────────
async function sendCaregiverSummary() {
  const pageText = document.body.innerText.substring(0, 3000);
  setResponse("Preparing summary for your caregiver...");

  const response = await chrome.runtime.sendMessage({
    type: "CAREGIVER_SUMMARY",
    payload: { pageText, portalName: detectPortal() },
  });

  if (response?.summary) {
    setResponse(`✅ Summary ready!\n\n${response.summary}\n\nShare this with your caregiver.`);
  }
}

// ── 9. Selection Explainer ───────────────────────────────────────────────────
// When user selects text on the page, offer to explain it
document.addEventListener("mouseup", () => {
  const selected = window.getSelection()?.toString().trim();
  if (selected && selected.length > 10 && selected.length < 500) {
    const responseEl = document.getElementById("cg-response-text");
    if (responseEl) {
      responseEl.innerHTML = `
        <em>Selected: "${selected.substring(0, 60)}..."</em><br><br>
        <button id="cg-explain-selection" style="margin-top:8px">Explain this</button>
      `;
      document.getElementById("cg-explain-selection")?.addEventListener("click", () => {
        askClaude(`Please explain this medical term or result in simple language: "${selected}"`);
      });
    }
  }
});

// ── 10. Event Listeners ──────────────────────────────────────────────────────
function attachSidebarEvents() {
  document.getElementById("cg-voice-btn")?.addEventListener("click", startVoice);
  document.getElementById("cg-close")?.addEventListener("click", () => {
    document.getElementById("careguide-sidebar")?.remove();
  });
  document.getElementById("cg-caregiver-btn")?.addEventListener("click", sendCaregiverSummary);

  document.querySelectorAll(".cg-action-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const intent = btn.dataset.intent;
      highlightElement(intent);
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function setResponse(text) {
  const el = document.getElementById("cg-response-text");
  if (el) el.textContent = text;
}

function getSelectedLanguage() {
  return document.getElementById("cg-language-select")?.value || "en";
}

function getSelectedLanguageLabel() {
  const select = document.getElementById("cg-language-select");
  return select?.options[select.selectedIndex]?.text || "English";
}

// ── Init ─────────────────────────────────────────────────────────────────────
injectSidebar(detectPortal());
