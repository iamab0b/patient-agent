// ─── CareGuide Content Script ───────────────────────────────────────────────
// Runs on patient portal pages. Detects the portal, injects the sidebar,
// handles voice input, and highlights DOM elements based on user intent.

try {
  window.__careguideDebugVersion = "20240620-noSpeak";

  if (typeof window.speechSynthesis === "undefined") {
    window.speechSynthesis = {
      speak: () => {
        console.log("CareGuide fallback speechSynthesis.speak() called");
      },
    };
    console.log("CareGuide speechSynthesis fallback installed");
  }

  if (typeof window.SpeechSynthesisUtterance === "undefined") {
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
        this.rate = 1.0;
        this.pitch = 1.0;
      }
    };
    console.log("CareGuide SpeechSynthesisUtterance fallback installed");
  }
} catch (e) {
  console.log("CareGuide speech fallback install failed:", e);
}

const PORTALS = {
  "mychart.org": "Epic MyChart",
  "mychart.com": "Epic MyChart",
  "followmyhealth.com": "FollowMyHealth",
  "healow.com": "Healow",
  "athenahealth.com": "Athena Health",
  "cerner.com": "Cerner",
  "myuhcare.com": "UH MyChart",
  "nextgen.com": "NextGen Patient Portal",
  "eclinicalweb.com": "eClinicalWorks",
  "portalconnect.net": "PortalConnect",
  "meditech.com": "Meditech",
  "sutterhealth.org": "Sutter Health MyHealth Online",
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
  console.log("CareGuide sidebar injected for portal:", portalName);
  attachSidebarEvents();
}

// ── Global Error Capture ───────────────────────────────────────────────────
window.addEventListener("error", (event) => {
  console.error("CareGuide uncaught error:", event.error || event.message, event.filename, event.lineno, event.colno);
  setResponse("An internal extension error occurred. Check the console for details.");
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("CareGuide unhandled rejection:", event.reason);
  setResponse("An internal extension error occurred. Check the console for details.");
});

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
    const selectedText = window.getSelection()?.toString() || "";
    const language = getSelectedLanguageLabel();

    console.log("askClaude called", { userText, selectedText });

    if (!chrome?.runtime?.sendMessage) {
      console.log("Chrome runtime messaging unavailable.");
      setResponse("Internal messaging error: browser runtime not available.");
      return;
    }

    const response = await sendRuntimeMessage({
      type: "ASK_CLAUDE",
      payload: {
        userText,
        selectedText,
        language,
        portalName: detectPortal(),
      },
    });

    console.log("Got response:", response);

    if (response?.reply) {
      setResponse(response.reply);
    } else {
      console.log("Full response object:", JSON.stringify(response));
      setResponse("I had trouble getting a response. Please try again.");
    }
  } catch (err) {
    console.log("askClaude error:", err.message);
    setResponse("Connection error: " + err.message);
  }
}

// ── 7. Text-to-Speech ────────────────────────────────────────────────────────
function speak(text) {
  try {
    console.log("speak() called but disabled in this build", { text });
    return;
  } catch (e) {
    console.log("TTS disabled fallback error:", e);
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    if (!chrome?.runtime?.sendMessage) {
      reject(new Error("chrome.runtime.sendMessage is unavailable"));
      return;
    }

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ── 8. Caregiver Summary ─────────────────────────────────────────────────────
async function sendCaregiverSummary() {
  const pageText = document.body.innerText.substring(0, 3000);
  setResponse("Preparing summary for your caregiver...");

  try {
    const response = await sendRuntimeMessage({
      type: "CAREGIVER_SUMMARY",
      payload: { pageText, portalName: detectPortal() },
    });

    if (response?.summary) {
      setResponse(`✅ Summary ready!\n\n${response.summary}\n\nShare this with your caregiver.`);
    } else {
      setResponse("Error generating caregiver summary. Please try again.");
    }
  } catch (err) {
    console.log("sendCaregiverSummary error:", err);
    setResponse("Could not connect to the extension background service.");
  }
}

// ── 9. Selection Explainer ───────────────────────────────────────────────────
// When user selects text on the page, offer to explain it
document.addEventListener("mouseup", () => {
  const selected = window.getSelection()?.toString().trim();
  console.log("selection mouseup", { selected });
  if (selected && selected.length > 10 && selected.length < 500) {
    const responseEl = document.getElementById("cg-response-text");
    if (responseEl) {
      responseEl.innerHTML = `
        <em>Selected: "${selected.substring(0, 60)}..."</em><br><br>
        <button id="cg-explain-selection" style="
          margin-top:8px;
          padding:8px 12px;
          background:#2563eb;
          color:white;
          border:none;
          border-radius:8px;
          cursor:pointer;
          font-size:13px;
        ">Explain this</button>
      `;
    }

    const sidebar = document.getElementById("careguide-sidebar");
    if (sidebar) {
      sidebar.addEventListener("click", function handler(e) {
        console.log("sidebar click event", { targetId: e.target?.id });
        if (e.target.id === "cg-explain-selection") {
          this.removeEventListener("click", handler);
          askClaude(`Please explain this in simple language: "${selected}"`);
        }
      });
    }
  }
});

// ── 10. Event Listeners ──────────────────────────────────────────────────────
function attachSidebarEvents() {
  console.log("attachSidebarEvents called");
  document.getElementById("cg-voice-btn")?.addEventListener("click", () => {
    console.log("voice button clicked");
    startVoice();
  });
  document.getElementById("cg-close")?.addEventListener("click", () => {
    console.log("close button clicked");
    document.getElementById("careguide-sidebar")?.remove();
  });
  document.getElementById("cg-caregiver-btn")?.addEventListener("click", () => {
    console.log("caregiver summary clicked");
    sendCaregiverSummary();
  });

  document.querySelectorAll(".cg-action-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const intent = btn.dataset.intent;
      console.log("action button clicked", intent);
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

// ── Init ─────────────────────────────────────────────────────────────────────console.log("CareGuide content script loaded on:", window.location.href);injectSidebar(detectPortal());
