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
  const href = window.location.href;
  if (href.includes('demo-portal.html') || host === 'localhost' || host === '127.0.0.1') {
    return 'Demo Patient Portal';
  }
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
let _cg_micStream = null;

async function ensureMicPermission() {
  // Try permissions API first
  try {
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const p = await navigator.permissions.query({ name: 'microphone' });
        if (p.state === 'denied') {
          throw new Error('denied');
        }
        if (p.state === 'granted') return true;
        // state === 'prompt' -> fallthrough to getUserMedia
      } catch (e) {
        // Some browsers may reject the permissions query; ignore and fallback
        console.log('permissions.query() failed:', e);
      }
    }

    // Ask for mic access explicitly so sites with restrictive CSP that still allow getUserMedia will prompt the user
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // store and stop tracks immediately; we only needed to prompt for permission
        _cg_micStream = stream;
        for (const t of stream.getTracks()) t.stop();
        _cg_micStream = null;
        return true;
      } catch (err) {
        // bubble the exact error
        throw err;
      }
    }

    // If neither API is present, permission cannot be requested
    throw new Error('no-mic-api');
  } catch (err) {
    throw err;
  }
}

async function startVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setResponse("Voice isn't supported in this browser. Please use Chrome.");
    return;
  }

  try {
    setResponse('Requesting microphone permission...');
    await ensureMicPermission();
  } catch (permErr) {
    console.error('Microphone permission failed:', permErr);
    const name = permErr?.name || permErr?.message || String(permErr);
    if (name === 'NotAllowedError' || name === 'denied') {
      setResponse('Microphone permission denied. Please enable microphone access for this site in your browser settings. (' + name + ')');
    } else if (name === 'NotFoundError') {
      setResponse('No microphone found on this device. (' + name + ')');
    } else if (name === 'SecurityError') {
      setResponse('Microphone access blocked by the page or browser security policy. (' + name + ')');
    } else if (name === 'no-mic-api') {
      setResponse('This browser does not support microphone access APIs.');
    } else {
      setResponse('Could not get microphone permission: ' + name);
    }
    return;
  }

  // Create recognition after permissions are confirmed
  try {
    recognition = new SpeechRecognition();
  } catch (e) {
    console.error('SpeechRecognition construction failed:', e);
    setResponse('Speech recognition is blocked or not available on this page. (' + (e?.name || e?.message || e) + ')');
    return;
  }

  recognition.lang = getSelectedLanguageSpeechCode();
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  document.getElementById('cg-voice-btn').classList.add('listening');
  document.getElementById('cg-voice-label').textContent = 'Listening...';

  recognition.onstart = () => {
    console.log('Speech recognition started');
    setResponse('Listening...');
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    document.getElementById('cg-transcript').textContent = `"${transcript}"`;
    handleUserIntent(transcript);
  };

  recognition.onerror = (event) => {
    stopVoice();
    console.log('Voice error event:', event);
    // event.error is standard (e.g., 'no-speech', 'audio-capture', 'not-allowed')
    const errCode = event?.error || event?.message || 'unknown';
    setResponse('Voice error: ' + errCode);
  };

  recognition.onend = () => {
    console.log('Speech recognition ended');
    stopVoice();
  };

  // Start recognition
  try {
    recognition.start();
  } catch (startErr) {
    console.error('recognition.start() threw:', startErr);
    // Try prompting for mic explicitly then retry once
    try {
      await ensureMicPermission();
      recognition.start();
    } catch (retryErr) {
      console.error('Retry start failed:', retryErr);
      setResponse('Could not start speech recognition: ' + (retryErr?.name || retryErr?.message || retryErr));
      stopVoice();
    }
  }
}

function stopVoice() {
  try {
    if (recognition && typeof recognition.stop === 'function') {
      try { recognition.stop(); } catch (e) { console.log('recognition.stop error', e); }
      recognition = null;
    }
  } finally {
    document.getElementById('cg-voice-btn')?.classList.remove('listening');
    const label = document.getElementById('cg-voice-label');
    if (label) label.textContent = 'Tap to speak';
  }
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

    setResponse("Thinking...");

    const response = await sendRuntimeMessage({
      type: "ASK_CLAUDE",
      payload: {
        userText,
        selectedText,
        language,
        portalName: detectPortal(),
      },
    });

    console.log("askClaude background response:", response);
    if (response?.reply) {
      setResponse(response.reply);
      try {
        speak(response.reply);
      } catch (e) { console.error('speak() failed after Claude reply', e); }
    } else {
      setResponse("I couldn't get a response from CareGuide. Please try again.");
    }

  } catch (err) {
    console.error("askClaude runtime error:", err);
    setResponse("Could not connect to CareGuide background service: " + (err?.message || err));
  }
}

// ── 7. Text-to-Speech ────────────────────────────────────────────────────────
function speak(text) {
  try {
    if (!text) return;
    const utter = new SpeechSynthesisUtterance(typeof text === 'string' ? text : String(text));
    // try to match the selected language for TTS
    try { utter.lang = getSelectedLanguageSpeechCode(); } catch (e) { /* ignore */ }
    // default voice options
    utter.rate = 1.0;
    utter.pitch = 1.0;
    if (window.speechSynthesis && typeof window.speechSynthesis.speak === 'function') {
      window.speechSynthesis.cancel(); // stop any current speech
      window.speechSynthesis.speak(utter);
    } else {
      console.log('No speechSynthesis available, fallback log:', text);
    }
  } catch (e) {
    console.log("TTS error:", e);
  }
}

function stopSpeaking() {
  try {
    if (window.speechSynthesis && typeof window.speechSynthesis.cancel === "function") {
      window.speechSynthesis.cancel();
    }
  } catch (e) {
    console.log("stopSpeaking error:", e);
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
          explainMedicalTerm(selected, "");
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
    stopSpeaking();
    document.getElementById("careguide-sidebar")?.remove();
  });
  document.getElementById("cg-caregiver-btn")?.addEventListener("click", () => {
    console.log("caregiver summary clicked");
    sendCaregiverSummary();
  });
  document.getElementById("cg-language-select")?.addEventListener("change", (e) => {
    console.log("language changed to", e.target.value);
    translatePage(e.target.value);
    applyCgUiLanguage();
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

function getSelectedLanguageSpeechCode() {
  const code = getSelectedLanguage();
  // map select codes to speech-recognition / TTS locale codes
  const map = {
    en: 'en-US',
    es: 'es-ES',
    zh: 'zh-CN',
    hi: 'hi-IN',
    ur: 'ur-PK',
  };
  return map[code] || code || 'en-US';
}

// ── 12. Medical Term Hover/Select "Explain" Button ───────────────────────────
const MEDICAL_TERMS = [
  // vitals
  "blood pressure", "heart rate", "pulse", "temperature", "oxygen saturation",
  "respiratory rate", "BMI", "SpO2",
  // labs
  "HbA1c", "A1C", "hemoglobin", "cholesterol", "LDL", "HDL", "triglycerides",
  "blood sugar", "glucose", "creatinine", "GFR", "white blood cell count", "WBC",
  "platelet count", "potassium", "sodium", "calcium",
  // diagnoses
  "hypertension", "type 2 diabetes", "type 1 diabetes", "diabetes",
  "atrial fibrillation", "COPD", "asthma", "pneumonia", "stroke",
  "urinary tract infection", "UTI", "congestive heart failure", "CHF",
  "chronic kidney disease", "CKD", "kidney function", "anemia", "hyperlipidemia",
  "hypothyroidism", "hyperthyroidism",
  // medications
  "metformin", "lisinopril", "atorvastatin", "amlodipine", "levothyroxine",
  "metoprolol", "losartan", "omeprazole", "albuterol", "insulin", "warfarin",
  "aspirin", "ibuprofen", "acetaminophen", "prednisone", "gabapentin",
  "sertraline", "furosemide", "hydrochlorothiazide",
];

const MEDICAL_TERMS_REGEX = new RegExp(
  "\\b(" +
    MEDICAL_TERMS
      .slice()
      .sort((a, b) => b.length - a.length)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|") +
  ")\\b",
  "gi"
);

// Local knowledge base for common terms — answers instantly with zero API
// call, in any of the 4 supported languages. Keyed by the language <select>
// option label (matches getSelectedLanguageLabel()), then by canonical term.
const LOCAL_KB = {
  English: {
    "blood pressure": `**Blood Pressure**\n\n**What it means**\n- Force of blood pushing on artery walls\n\n**Why it matters**\n- Reflects heart and blood vessel health\n\n**Normal range**\n- Normal: under 120/80 mmHg\n- High: 130/80 mmHg or above\n\n**What to watch for**\n- Frequent high readings, chest pain, severe headache, dizziness`,
    "heart rate": `**Heart Rate**\n\n**What it means**\n- Number of heartbeats per minute\n\n**Why it matters**\n- Shows how hard your heart is working\n\n**Normal range**\n- Resting: 60-100 beats per minute\n\n**What to watch for**\n- Very fast, very slow, or irregular heartbeat, fainting`,
    "cholesterol": `**Cholesterol**\n\n**What it means**\n- A fat in your blood used to build cells\n\n**Why it matters**\n- High levels raise risk of heart disease and stroke\n\n**Normal range**\n- Total cholesterol under 200 mg/dL is healthy\n\n**What to watch for**\n- Levels consistently above 200 mg/dL`,
    "diabetes": `**Diabetes**\n\n**What it means**\n- A condition where blood sugar stays too high\n\n**Why it matters**\n- Can damage the heart, kidneys, eyes, and nerves over time\n\n**What to watch for**\n- Frequent thirst, fatigue, blurry vision, slow-healing sores`,
    "glucose": `**Glucose (Blood Sugar)**\n\n**What it means**\n- The amount of sugar in your blood\n\n**Why it matters**\n- Helps check for diabetes and energy balance\n\n**Normal range**\n- Fasting: 70-99 mg/dL is normal\n\n**What to watch for**\n- Readings above 125 mg/dL or below 70 mg/dL`,
    "hba1c": `**Hemoglobin A1C**\n\n**What it means**\n- Average blood sugar over the past 2-3 months\n\n**Why it matters**\n- Used to diagnose and monitor diabetes\n\n**Normal range**\n- Normal: below 5.7%\n- Diabetes: 6.5% or higher\n\n**What to watch for**\n- A rising trend over time`,
    "bmi": `**BMI (Body Mass Index)**\n\n**What it means**\n- Estimates body fat using height and weight\n\n**Why it matters**\n- Helps assess weight-related health risks\n\n**Normal range**\n- Healthy: 18.5-24.9\n\n**What to watch for**\n- BMI under 18.5 or over 30`,
    "hypertension": `**Hypertension (High Blood Pressure)**\n\n**What it means**\n- Blood pressure that stays consistently high\n\n**Why it matters**\n- Raises risk of heart attack, stroke, and kidney damage\n\n**Normal range**\n- Goal is usually under 130/80 mmHg\n\n**What to watch for**\n- Headaches, chest pain, vision changes`,
    "stroke": `**Stroke**\n\n**What it means**\n- A sudden loss of blood flow to part of the brain\n\n**Why it matters**\n- Can cause lasting brain damage if not treated quickly\n\n**What to watch for**\n- Sudden numbness, slurred speech, face drooping, vision loss — call emergency services immediately`,
    "asthma": `**Asthma**\n\n**What it means**\n- A condition that narrows and inflames the airways\n\n**Why it matters**\n- Can make breathing difficult, especially during flare-ups\n\n**What to watch for**\n- Wheezing, shortness of breath, chest tightness, frequent coughing`,
    "kidney function": `**Kidney Function**\n\n**What it means**\n- How well your kidneys filter waste from your blood\n\n**Why it matters**\n- Poor function can let toxins build up in the body\n\n**Normal range**\n- GFR above 90 is generally normal\n\n**What to watch for**\n- Swelling, fatigue, changes in urination`,
  },
  "Español": {
    "blood pressure": `**Presión Arterial**\n\n**Qué significa**\n- Fuerza con la que la sangre empuja las paredes de las arterias\n\n**Por qué importa**\n- Refleja la salud del corazón y los vasos sanguíneos\n\n**Rango normal**\n- Normal: menos de 120/80 mmHg\n- Alta: 130/80 mmHg o más\n\n**Qué vigilar**\n- Lecturas altas frecuentes, dolor de pecho, dolor de cabeza intenso, mareos`,
    "heart rate": `**Frecuencia Cardíaca**\n\n**Qué significa**\n- Número de latidos del corazón por minuto\n\n**Por qué importa**\n- Muestra qué tan fuerte está trabajando su corazón\n\n**Rango normal**\n- En reposo: 60-100 latidos por minuto\n\n**Qué vigilar**\n- Latidos muy rápidos, muy lentos o irregulares, desmayos`,
    "cholesterol": `**Colesterol**\n\n**Qué significa**\n- Una grasa en la sangre usada para construir células\n\n**Por qué importa**\n- Niveles altos aumentan el riesgo de enfermedad cardíaca y derrame cerebral\n\n**Rango normal**\n- Colesterol total por debajo de 200 mg/dL es saludable\n\n**Qué vigilar**\n- Niveles constantemente por encima de 200 mg/dL`,
    "diabetes": `**Diabetes**\n\n**Qué significa**\n- Una condición en la que el azúcar en la sangre se mantiene demasiado alto\n\n**Por qué importa**\n- Puede dañar el corazón, los riñones, los ojos y los nervios con el tiempo\n\n**Qué vigilar**\n- Sed frecuente, fatiga, visión borrosa, llagas que tardan en curar`,
    "glucose": `**Glucosa (Azúcar en la Sangre)**\n\n**Qué significa**\n- La cantidad de azúcar en su sangre\n\n**Por qué importa**\n- Ayuda a detectar diabetes y el equilibrio de energía\n\n**Rango normal**\n- En ayunas: 70-99 mg/dL es normal\n\n**Qué vigilar**\n- Lecturas por encima de 125 mg/dL o por debajo de 70 mg/dL`,
    "hba1c": `**Hemoglobina A1C**\n\n**Qué significa**\n- Azúcar promedio en la sangre durante los últimos 2-3 meses\n\n**Por qué importa**\n- Se usa para diagnosticar y monitorear la diabetes\n\n**Rango normal**\n- Normal: menos de 5.7%\n- Diabetes: 6.5% o más\n\n**Qué vigilar**\n- Una tendencia al alza con el tiempo`,
    "bmi": `**IMC (Índice de Masa Corporal)**\n\n**Qué significa**\n- Estima la grasa corporal usando la altura y el peso\n\n**Por qué importa**\n- Ayuda a evaluar riesgos de salud relacionados con el peso\n\n**Rango normal**\n- Saludable: 18.5-24.9\n\n**Qué vigilar**\n- IMC por debajo de 18.5 o por encima de 30`,
    "hypertension": `**Hipertensión (Presión Arterial Alta)**\n\n**Qué significa**\n- Presión arterial que se mantiene constantemente alta\n\n**Por qué importa**\n- Aumenta el riesgo de ataque cardíaco, derrame cerebral y daño renal\n\n**Rango normal**\n- La meta suele ser menos de 130/80 mmHg\n\n**Qué vigilar**\n- Dolores de cabeza, dolor de pecho, cambios en la visión`,
    "stroke": `**Derrame Cerebral**\n\n**Qué significa**\n- Una pérdida súbita de flujo sanguíneo a parte del cerebro\n\n**Por qué importa**\n- Puede causar daño cerebral duradero si no se trata rápido\n\n**Qué vigilar**\n- Entumecimiento súbito, habla arrastrada, caída facial, pérdida de visión — llame a emergencias de inmediato`,
    "asthma": `**Asma**\n\n**Qué significa**\n- Una condición que estrecha e inflama las vías respiratorias\n\n**Por qué importa**\n- Puede dificultar la respiración, especialmente durante las crisis\n\n**Qué vigilar**\n- Silbidos al respirar, falta de aire, opresión en el pecho, tos frecuente`,
    "kidney function": `**Función Renal**\n\n**Qué significa**\n- Qué tan bien sus riñones filtran los desechos de su sangre\n\n**Por qué importa**\n- Una función deficiente puede dejar que las toxinas se acumulen en el cuerpo\n\n**Rango normal**\n- Una TFG por encima de 90 generalmente es normal\n\n**Qué vigilar**\n- Hinchazón, fatiga, cambios en la orina`,
  },
  "中文": {
    "blood pressure": `**血压**\n\n**含义**\n- 血液对血管壁施加的压力\n\n**重要性**\n- 反映心脏和血管的健康状况\n\n**正常范围**\n- 正常：低于120/80 mmHg\n- 偏高：130/80 mmHg 或更高\n\n**注意事项**\n- 经常偏高、胸痛、剧烈头痛、头晕`,
    "heart rate": `**心率**\n\n**含义**\n- 每分钟心跳的次数\n\n**重要性**\n- 显示心脏的工作强度\n\n**正常范围**\n- 静息心率：每分钟60-100次\n\n**注意事项**\n- 心跳过快、过慢或不规律，晕厥`,
    "cholesterol": `**胆固醇**\n\n**含义**\n- 血液中用于构建细胞的一种脂肪\n\n**重要性**\n- 水平过高会增加心脏病和中风的风险\n\n**正常范围**\n- 总胆固醇低于200 mg/dL为健康\n\n**注意事项**\n- 持续高于200 mg/dL`,
    "diabetes": `**糖尿病**\n\n**含义**\n- 一种血糖持续过高的疾病\n\n**重要性**\n- 长期可能损害心脏、肾脏、眼睛和神经\n\n**注意事项**\n- 频繁口渴、疲劳、视力模糊、伤口愈合缓慢`,
    "glucose": `**血糖（葡萄糖）**\n\n**含义**\n- 血液中的糖含量\n\n**重要性**\n- 有助于检测糖尿病和能量平衡\n\n**正常范围**\n- 空腹：70-99 mg/dL为正常\n\n**注意事项**\n- 持续高于125 mg/dL或低于70 mg/dL`,
    "hba1c": `**糖化血红蛋白（HbA1c）**\n\n**含义**\n- 过去2-3个月的平均血糖水平\n\n**重要性**\n- 用于诊断和监测糖尿病\n\n**正常范围**\n- 正常：低于5.7%\n- 糖尿病：6.5%或更高\n\n**注意事项**\n- 随时间呈上升趋势`,
    "bmi": `**体重指数（BMI）**\n\n**含义**\n- 通过身高和体重估算体脂\n\n**重要性**\n- 有助于评估与体重相关的健康风险\n\n**正常范围**\n- 健康范围：18.5-24.9\n\n**注意事项**\n- BMI低于18.5或高于30`,
    "hypertension": `**高血压**\n\n**含义**\n- 血压持续偏高的状态\n\n**重要性**\n- 增加心脏病发作、中风和肾损伤的风险\n\n**正常范围**\n- 目标通常是低于130/80 mmHg\n\n**注意事项**\n- 头痛、胸痛、视力变化`,
    "stroke": `**中风**\n\n**含义**\n- 大脑部分区域突然失去血流供应\n\n**重要性**\n- 如果不及时治疗可能造成持久性脑损伤\n\n**注意事项**\n- 突然麻木、言语不清、面部下垂、视力丧失——请立即呼叫急救`,
    "asthma": `**哮喘**\n\n**含义**\n- 一种使气道变窄和发炎的疾病\n\n**重要性**\n- 可能导致呼吸困难，尤其是发作期间\n\n**注意事项**\n- 喘息、呼吸急促、胸闷、频繁咳嗽`,
    "kidney function": `**肾功能**\n\n**含义**\n- 肾脏过滤血液中废物的能力\n\n**重要性**\n- 功能不良可能导致毒素在体内积聚\n\n**正常范围**\n- 肾小球滤过率（GFR）高于90通常为正常\n\n**注意事项**\n- 浮肿、疲劳、排尿变化`,
  },
  "हिन्दी": {
    "blood pressure": `**रक्तचाप**\n\n**इसका मतलब**\n- रक्त धमनी की दीवारों पर जो दबाव डालता है\n\n**यह क्यों महत्वपूर्ण है**\n- हृदय और रक्त वाहिकाओं के स्वास्थ्य को दर्शाता है\n\n**सामान्य सीमा**\n- सामान्य: 120/80 mmHg से कम\n- उच्च: 130/80 mmHg या अधिक\n\n**किन बातों पर ध्यान दें**\n- बार-बार उच्च रीडिंग, सीने में दर्द, गंभीर सिरदर्द, चक्कर आना`,
    "heart rate": `**हृदय गति**\n\n**इसका मतलब**\n- प्रति मिनट हृदय की धड़कनों की संख्या\n\n**यह क्यों महत्वपूर्ण है**\n- दर्शाता है कि आपका हृदय कितनी मेहनत कर रहा है\n\n**सामान्य सीमा**\n- आराम की स्थिति में: प्रति मिनट 60-100 धड़कनें\n\n**किन बातों पर ध्यान दें**\n- बहुत तेज़, बहुत धीमी या अनियमित धड़कन, बेहोशी`,
    "cholesterol": `**कोलेस्ट्रॉल**\n\n**इसका मतलब**\n- रक्त में मौजूद एक वसा जो कोशिकाओं के निर्माण में उपयोग होती है\n\n**यह क्यों महत्वपूर्ण है**\n- उच्च स्तर हृदय रोग और स्ट्रोक के जोखिम को बढ़ाता है\n\n**सामान्य सीमा**\n- कुल कोलेस्ट्रॉल 200 mg/dL से कम स्वस्थ है\n\n**किन बातों पर ध्यान दें**\n- लगातार 200 mg/dL से अधिक स्तर`,
    "diabetes": `**मधुमेह**\n\n**इसका मतलब**\n- एक स्थिति जिसमें रक्त शर्करा बहुत अधिक बनी रहती है\n\n**यह क्यों महत्वपूर्ण है**\n- समय के साथ हृदय, किडनी, आंखों और नसों को नुकसान पहुंचा सकती है\n\n**किन बातों पर ध्यान दें**\n- बार-बार प्यास लगना, थकान, धुंधली दृष्टि, घाव का धीरे भरना`,
    "glucose": `**ग्लूकोज (रक्त शर्करा)**\n\n**इसका मतलब**\n- आपके रक्त में शर्करा की मात्रा\n\n**यह क्यों महत्वपूर्ण है**\n- मधुमेह की जांच और ऊर्जा संतुलन में मदद करता है\n\n**सामान्य सीमा**\n- खाली पेट: 70-99 mg/dL सामान्य है\n\n**किन बातों पर ध्यान दें**\n- 125 mg/dL से अधिक या 70 mg/dL से कम रीडिंग`,
    "hba1c": `**हीमोग्लोबिन A1C**\n\n**इसका मतलब**\n- पिछले 2-3 महीनों का औसत रक्त शर्करा स्तर\n\n**यह क्यों महत्वपूर्ण है**\n- मधुमेह के निदान और निगरानी के लिए उपयोग किया जाता है\n\n**सामान्य सीमा**\n- सामान्य: 5.7% से कम\n- मधुमेह: 6.5% या अधिक\n\n**किन बातों पर ध्यान दें**\n- समय के साथ बढ़ता रुझान`,
    "bmi": `**बीएमआई (बॉडी मास इंडेक्स)**\n\n**इसका मतलब**\n- ऊंचाई और वजन का उपयोग करके शरीर की चर्बी का अनुमान\n\n**यह क्यों महत्वपूर्ण है**\n- वजन से संबंधित स्वास्थ्य जोखिमों का आकलन करने में मदद करता है\n\n**सामान्य सीमा**\n- स्वस्थ: 18.5-24.9\n\n**किन बातों पर ध्यान दें**\n- बीएमआई 18.5 से कम या 30 से अधिक`,
    "hypertension": `**हाइपरटेंशन (उच्च रक्तचाप)**\n\n**इसका मतलब**\n- रक्तचाप जो लगातार उच्च बना रहता है\n\n**यह क्यों महत्वपूर्ण है**\n- हृदयाघात, स्ट्रोक और किडनी क्षति का जोखिम बढ़ाता है\n\n**सामान्य सीमा**\n- लक्ष्य आमतौर पर 130/80 mmHg से कम होता है\n\n**किन बातों पर ध्यान दें**\n- सिरदर्द, सीने में दर्द, दृष्टि में बदलाव`,
    "stroke": `**स्ट्रोक**\n\n**इसका मतलब**\n- मस्तिष्क के किसी हिस्से में रक्त प्रवाह का अचानक रुक जाना\n\n**यह क्यों महत्वपूर्ण है**\n- समय पर इलाज न होने पर स्थायी मस्तिष्क क्षति हो सकती है\n\n**किन बातों पर ध्यान दें**\n- अचानक सुन्नपन, बोलने में दिक्कत, चेहरे का लटकना, दृष्टि का जाना — तुरंत आपातकालीन सेवा को कॉल करें`,
    "asthma": `**अस्थमा**\n\n**इसका मतलब**\n- एक स्थिति जो वायुमार्ग को संकुचित और सूजा हुआ बना देती है\n\n**यह क्यों महत्वपूर्ण है**\n- सांस लेना मुश्किल कर सकती है, खासकर दौरे के दौरान\n\n**किन बातों पर ध्यान दें**\n- सांस लेते समय सीटी जैसी आवाज़, सांस फूलना, सीने में जकड़न, बार-बार खांसी`,
    "kidney function": `**किडनी कार्य**\n\n**इसका मतलब**\n- आपकी किडनी रक्त से अपशिष्ट कितनी अच्छी तरह छानती है\n\n**यह क्यों महत्वपूर्ण है**\n- खराब कार्यक्षमता से शरीर में विषाक्त पदार्थ जमा हो सकते हैं\n\n**सामान्य सीमा**\n- GFR 90 से अधिक होना सामान्यतः सामान्य है\n\n**किन बातों पर ध्यान दें**\n- सूजन, थकान, पेशाब में बदलाव`,
  },
  "اردو": {
    "blood pressure": `**بلڈ پریشر**\n\n**اس کا مطلب**\n- وہ طاقت جس سے خون شریانوں کی دیواروں پر دباؤ ڈالتا ہے\n\n**یہ کیوں اہم ہے**\n- دل اور خون کی نالیوں کی صحت کو ظاہر کرتا ہے\n\n**نارمل رینج**\n- نارمل: 120/80 mmHg سے کم\n- زیادہ: 130/80 mmHg یا اس سے زیادہ\n\n**کن باتوں پر دھیان دیں**\n- بار بار زیادہ ریڈنگ، سینے میں درد، شدید سر درد، چکر آنا`,
    "heart rate": `**دل کی دھڑکن**\n\n**اس کا مطلب**\n- ایک منٹ میں دل کی دھڑکنوں کی تعداد\n\n**یہ کیوں اہم ہے**\n- ظاہر کرتا ہے کہ آپ کا دل کتنی مشقت کر رہا ہے\n\n**نارمل رینج**\n- آرام کی حالت میں: 60-100 دھڑکن فی منٹ\n\n**کن باتوں پر دھیان دیں**\n- بہت تیز، بہت سست یا بے ترتیب دھڑکن، بے ہوشی`,
    "cholesterol": `**کولیسٹرول**\n\n**اس کا مطلب**\n- خون میں ایک چکنائی جو خلیات بنانے میں استعمال ہوتی ہے\n\n**یہ کیوں اہم ہے**\n- زیادہ مقدار دل کی بیماری اور فالج کا خطرہ بڑھاتی ہے\n\n**نارمل رینج**\n- کل کولیسٹرول 200 mg/dL سے کم صحت مند ہے\n\n**کن باتوں پر دھیان دیں**\n- مستقل طور پر 200 mg/dL سے زیادہ ہونا`,
    "diabetes": `**ذیابیطس**\n\n**اس کا مطلب**\n- ایک حالت جس میں خون میں شکر کی مقدار بہت زیادہ رہتی ہے\n\n**یہ کیوں اہم ہے**\n- وقت کے ساتھ دل، گردوں، آنکھوں اور اعصاب کو نقصان پہنچا سکتی ہے\n\n**کن باتوں پر دھیان دیں**\n- بار بار پیاس لگنا، تھکاوٹ، نظر کا دھندلانا، زخموں کا دیر سے بھرنا`,
    "glucose": `**گلوکوز (بلڈ شوگر)**\n\n**اس کا مطلب**\n- آپ کے خون میں شکر کی مقدار\n\n**یہ کیوں اہم ہے**\n- ذیابیطس کی جانچ اور توانائی کے توازن میں مدد کرتا ہے\n\n**نارمل رینج**\n- خالی پیٹ: 70-99 mg/dL نارمل ہے\n\n**کن باتوں پر دھیان دیں**\n- 125 mg/dL سے زیادہ یا 70 mg/dL سے کم ریڈنگ`,
    "hba1c": `**ہیموگلوبن A1C**\n\n**اس کا مطلب**\n- پچھلے 2-3 مہینوں کا اوسط بلڈ شوگر کی سطح\n\n**یہ کیوں اہم ہے**\n- ذیابیطس کی تشخیص اور نگرانی کے لیے استعمال ہوتا ہے\n\n**نارمل رینج**\n- نارمل: 5.7% سے کم\n- ذیابیطس: 6.5% یا اس سے زیادہ\n\n**کن باتوں پر دھیان دیں**\n- وقت کے ساتھ بڑھتا ہوا رجحان`,
    "bmi": `**بی ایم آئی (باڈی ماس انڈیکس)**\n\n**اس کا مطلب**\n- قد اور وزن کے ذریعے جسمانی چکنائی کا تخمینہ\n\n**یہ کیوں اہم ہے**\n- وزن سے متعلق صحت کے خطرات کا اندازہ لگانے میں مدد کرتا ہے\n\n**نارمل رینج**\n- صحت مند: 18.5-24.9\n\n**کن باتوں پر دھیان دیں**\n- بی ایم آئی 18.5 سے کم یا 30 سے زیادہ`,
    "hypertension": `**ہائی بلڈ پریشر (ہائپرٹینشن)**\n\n**اس کا مطلب**\n- بلڈ پریشر جو مستقل طور پر زیادہ رہتا ہے\n\n**یہ کیوں اہم ہے**\n- دل کا دورہ، فالج اور گردے کو نقصان پہنچنے کا خطرہ بڑھاتا ہے\n\n**نارمل رینج**\n- ہدف عام طور پر 130/80 mmHg سے کم ہوتا ہے\n\n**کن باتوں پر دھیان دیں**\n- سر درد، سینے میں درد، نظر میں تبدیلی`,
    "stroke": `**فالج (اسٹروک)**\n\n**اس کا مطلب**\n- دماغ کے کسی حصے کو خون کی فراہمی کا اچانک رک جانا\n\n**یہ کیوں اہم ہے**\n- جلدی علاج نہ ہونے کی صورت میں دماغ کو دیرپا نقصان پہنچ سکتا ہے\n\n**کن باتوں پر دھیان دیں**\n- اچانک سن ہونا، بولنے میں دقت، چہرے کا لٹک جانا، نظر کا چلا جانا — فوری طور پر ایمرجنسی سروسز کو کال کریں`,
    "asthma": `**دمہ**\n\n**اس کا مطلب**\n- ایک حالت جو سانس کی نالیوں کو تنگ اور سوجن زدہ کر دیتی ہے\n\n**یہ کیوں اہم ہے**\n- سانس لینا مشکل بنا سکتی ہے، خصوصاً دورے کے دوران\n\n**کن باتوں پر دھیان دیں**\n- سانس میں سیٹی کی آواز، سانس پھولنا، سینے میں جکڑن، بار بار کھانسی`,
    "kidney function": `**گردوں کی کارکردگی**\n\n**اس کا مطلب**\n- آپ کے گردے خون سے فاضل مادے کتنی اچھی طرح فلٹر کرتے ہیں\n\n**یہ کیوں اہم ہے**\n- ناقص کارکردگی جسم میں زہریلے مادوں کو جمع ہونے دے سکتی ہے\n\n**نارمل رینج**\n- GFR 90 سے زیادہ عام طور پر نارمل ہے\n\n**کن باتوں پر دھیان دیں**\n- سوجن، تھکاوٹ، پیشاب میں تبدیلی`,
  },
};

const LOCAL_KB_ALIASES = {
  "pulse": "heart rate",
  "type 2 diabetes": "diabetes",
  "type 1 diabetes": "diabetes",
  "blood sugar": "glucose",
  "a1c": "hba1c",
  "gfr": "kidney function",
  "ckd": "kidney function",
  "chronic kidney disease": "kidney function",
};

function getLocalKbEntry(term, language) {
  const key = LOCAL_KB_ALIASES[term.trim().toLowerCase()] || term.trim().toLowerCase();
  return LOCAL_KB[language]?.[key] || null;
}

// Cache of in-flight/completed explanation promises, keyed by "term::language".
// Populated by hover-prefetch and reused by the click handler so the common
// case (user hovers, then clicks) feels instant.
const cgExplainCache = new Map();

function getExplainCacheKey(term, language) {
  return `${term.trim().toLowerCase()}::${language}`;
}

function fetchExplanationFromAI(term, context, language, portalName) {
  return sendRuntimeMessage({
    type: "EXPLAIN_TERM",
    payload: { term, context, language, portalName },
  }).then((response) => {
    if (!response?.reply) throw new Error("No reply from CareGuide");
    return response.reply;
  });
}

function getOrCreateExplanationPromise(term, context, language, portalName) {
  const key = getExplainCacheKey(term, language);
  let cached = cgExplainCache.get(key);
  if (cached) return cached;

  const kb = getLocalKbEntry(term, language);
  cached = kb ? Promise.resolve(kb) : fetchExplanationFromAI(term, context, language, portalName);
  cgExplainCache.set(key, cached);
  cached.catch(() => cgExplainCache.delete(key)); // allow retry after a failure
  return cached;
}

// UI strings for the explain button/popover, localized to match the
// selected portal language (not just the AI-generated explanation).
const CG_UI_STRINGS = {
  English: { explainTooltip: "Explain this", close: "Close", generating: "Generating explanation..." },
  "Español": { explainTooltip: "Explicar esto", close: "Cerrar", generating: "Generando explicación..." },
  "中文": { explainTooltip: "解释这个", close: "关闭", generating: "正在生成解释..." },
  "हिन्दी": { explainTooltip: "इसे समझाएं", close: "बंद करें", generating: "स्पष्टीकरण तैयार किया जा रहा है..." },
  "اردو": { explainTooltip: "اسے سمجھائیں", close: "بند کریں", generating: "وضاحت تیار کی جا رہی ہے..." },
};

function getCgUiString(key) {
  const language = getSelectedLanguageLabel();
  return CG_UI_STRINGS[language]?.[key] || CG_UI_STRINGS.English[key];
}

function applyCgUiLanguage() {
  if (cgExplainBtn) {
    const label = getCgUiString("explainTooltip");
    cgExplainBtn.title = label;
    cgExplainBtn.setAttribute("aria-label", label);
  }
  if (cgExplainPopover) {
    const closeBtn = cgExplainPopover.querySelector("#cg-term-popover-close");
    if (closeBtn) {
      const label = getCgUiString("close");
      closeBtn.title = label;
      closeBtn.setAttribute("aria-label", label);
    }
  }
}

let cgExplainBtn = null;
let cgExplainPopover = null;
let cgHoverHideTimer = null;
let cgCurrentTermText = null;
let cgCurrentTermNode = null;
let cgMouseMoveRAF = null;
let cgHoverPrefetchTimer = null;
let cgHoverPrefetchKey = null;

function ensureExplainUi() {
  if (!cgExplainBtn) {
    cgExplainBtn = document.createElement("button");
    cgExplainBtn.id = "cg-term-explain-btn";
    cgExplainBtn.textContent = "?";
    document.body.appendChild(cgExplainBtn);

    cgExplainBtn.addEventListener("mouseenter", () => clearHoverHideTimer());
    cgExplainBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (cgCurrentTermText) {
        explainMedicalTerm(cgCurrentTermText, getSurroundingContext(cgCurrentTermNode));
      }
    });
  }
  if (!cgExplainPopover) {
    cgExplainPopover = document.createElement("div");
    cgExplainPopover.id = "cg-term-popover";
    cgExplainPopover.innerHTML = `
      <div id="cg-term-popover-header">
        <span id="cg-term-popover-title"></span>
        <button id="cg-term-popover-close">✕</button>
      </div>
      <div id="cg-term-popover-body"></div>
    `;
    document.body.appendChild(cgExplainPopover);
    cgExplainPopover.querySelector("#cg-term-popover-close").addEventListener("click", () => {
      stopSpeaking();
      cgExplainPopover.style.display = "none";
    });
    cgExplainPopover.addEventListener("mouseenter", () => clearHoverHideTimer());
  }
  applyCgUiLanguage();
}

function clearHoverHideTimer() {
  if (cgHoverHideTimer) {
    clearTimeout(cgHoverHideTimer);
    cgHoverHideTimer = null;
  }
}

function scheduleHideExplainBtn() {
  clearHoverHideTimer();
  cgHoverHideTimer = setTimeout(() => {
    if (cgExplainBtn) cgExplainBtn.style.display = "none";
  }, 350);
}

function getSurroundingContext(node) {
  const el = node?.nodeType === 3 ? node.parentElement : node;
  const block = el?.closest("li, p, tr, div, td") || el;
  return block ? block.textContent.trim().substring(0, 300) : "";
}

function positionExplainBtnAtRect(rect) {
  ensureExplainUi();
  cgExplainBtn.style.display = "flex";
  cgExplainBtn.style.top = `${rect.top + window.scrollY - 6}px`;
  cgExplainBtn.style.left = `${rect.right + window.scrollX + 4}px`;
}

// Detects whether the word under the mouse cursor matches a known medical
// term, without modifying the page DOM (so it can't conflict with the
// demo-portal exact-string translation dictionary, which matches whole
// text-node strings).
function checkWordAtPoint(x, y) {
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos?.offsetNode) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
    }
  }

  if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) {
    scheduleHideExplainBtn();
    return;
  }

  const node = range.startContainer;
  if (node.parentElement?.closest("#careguide-sidebar, #cg-term-popover, #cg-term-explain-btn")) {
    scheduleHideExplainBtn();
    return;
  }

  const offset = range.startOffset;
  const text = node.textContent;
  MEDICAL_TERMS_REGEX.lastIndex = 0;
  let match;
  let found = null;
  while ((match = MEDICAL_TERMS_REGEX.exec(text))) {
    if (offset >= match.index && offset <= match.index + match[0].length) {
      found = match;
      break;
    }
  }

  if (!found) {
    scheduleHideExplainBtn();
    clearHoverPrefetchTimer();
    return;
  }

  clearHoverHideTimer();
  const wordRange = document.createRange();
  wordRange.setStart(node, found.index);
  wordRange.setEnd(node, found.index + found[0].length);
  cgCurrentTermText = found[0];
  cgCurrentTermNode = node;
  positionExplainBtnAtRect(wordRange.getBoundingClientRect());
  scheduleHoverPrefetch(found[0], node);
}

// Begin generating the explanation in the background ~500ms into a hover, so
// it's often already cached by the time the user clicks the "?" button.
function scheduleHoverPrefetch(term, node) {
  const language = getSelectedLanguageLabel();
  const key = getExplainCacheKey(term, language);
  if (key === cgHoverPrefetchKey) return; // already scheduled/prefetched for this term
  clearHoverPrefetchTimer();
  cgHoverPrefetchKey = key;
  cgHoverPrefetchTimer = setTimeout(() => {
    getOrCreateExplanationPromise(term, getSurroundingContext(node), language, detectPortal());
  }, 500);
}

function clearHoverPrefetchTimer() {
  if (cgHoverPrefetchTimer) {
    clearTimeout(cgHoverPrefetchTimer);
    cgHoverPrefetchTimer = null;
  }
  cgHoverPrefetchKey = null;
}

document.addEventListener("mousemove", (e) => {
  if (e.target.closest?.("#careguide-sidebar, #cg-term-popover, #cg-term-explain-btn")) return;
  if (cgMouseMoveRAF) return;
  cgMouseMoveRAF = requestAnimationFrame(() => {
    cgMouseMoveRAF = null;
    checkWordAtPoint(e.clientX, e.clientY);
  });
});

// Safely render Claude's markdown-lite (**bold** + newlines) response as DOM, escaping all other content.
function renderFormattedExplanation(container, text) {
  container.textContent = "";
  const lines = String(text).split("\n");
  lines.forEach((line, i) => {
    if (i > 0) container.appendChild(document.createElement("br"));
    const parts = line.split(/\*\*(.+?)\*\*/g);
    parts.forEach((part, idx) => {
      if (!part) return;
      if (idx % 2 === 1) {
        const strong = document.createElement("strong");
        strong.textContent = part;
        container.appendChild(strong);
      } else {
        container.appendChild(document.createTextNode(part));
      }
    });
  });
}

async function explainMedicalTerm(term, context) {
  ensureExplainUi();
  clearHoverPrefetchTimer();
  cgExplainBtn.style.display = "none";
  cgExplainPopover.style.display = "block";

  const titleEl = cgExplainPopover.querySelector("#cg-term-popover-title");
  const bodyEl = cgExplainPopover.querySelector("#cg-term-popover-body");
  titleEl.textContent = term;
  bodyEl.textContent = getCgUiString("generating");

  const anchorRect = cgExplainBtn.getBoundingClientRect();
  cgExplainPopover.style.top = `${anchorRect.bottom + window.scrollY + 8}px`;
  cgExplainPopover.style.left = `${Math.max(8, anchorRect.left + window.scrollX)}px`;

  try {
    const language = getSelectedLanguageLabel();
    const reply = await getOrCreateExplanationPromise(term, context, language, detectPortal());
    renderFormattedExplanation(bodyEl, reply);
    try { speak(reply.replace(/\*\*/g, "")); } catch (e) { /* ignore */ }
  } catch (err) {
    console.error("explainMedicalTerm error:", err);
    bodyEl.textContent = "Could not connect to CareGuide background service.";
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────
console.log("CareGuide content script loaded on:", window.location.href);
injectSidebar(detectPortal());

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "EXPLAIN_SELECTION") {
    explainMedicalTerm(message.text, "");
  }
});


// ── 11. Translation ──────────────────────────────────────────────────────────
const DEMO_TRANSLATIONS = {
  es: {
    "MyHealth Portal": "MiPortal de Salud",
    "Secure Patient Access": "Acceso seguro del paciente",
    "Dashboard": "Tablero",
    "Test Results": "Resultados de Pruebas",
    "Medications": "Medicamentos",
    "Messages": "Mensajes",
    "Appointments": "Citas",
    "Upcoming Appointment": "Próxima Cita",
    "Dr. Sarah Chen — Cardiology": "Dra. Sarah Chen — Cardiología",
    "June 25, 2026 at 2:30 PM · Virtual Visit": "25 de junio de 2026 a las 2:30 p.m. · Visita virtual",
    "Add to calendar": "Agregar al calendario",
    "Health Alerts": "Alertas de Salud",
    "You have 1 new message": "Tienes 1 mensaje nuevo",
    "Lab Results (Most recent)": "Resultados de Laboratorio (Más recientes)",
    "Note: Results are for informational purposes. Contact your clinician for medical advice.": "Nota: Los resultados son solo para información. Comuníquese con su médico para asesoramiento médico.",
    "Take twice daily with meals": "Tomar dos veces al día con las comidas",
    "Once daily — morning": "Una vez al día — mañana",
    "At bedtime": "Al acostarse",
    "Request Refill": "Solicitar receta",
    "Click \"Request Refill\" to send a refill request to your provider.": "Haga clic en \"Solicitar receta\" para enviar una solicitud a su proveedor.",
    "Annual flu shot is due — click to schedule at a nearby clinic.": "Se debe la vacuna anual contra la gripe: haga clic para programar en una clínica cercana.",
    "John—Your HbA1c is 7.2. I'd like to review your blood sugar logs and consider a small med adjustment. Please schedule a telehealth follow-up.": "John: Su HbA1c es 7.2. Me gustaría revisar sus registros de azúcar y considerar un pequeño ajuste de medicamento. Programe una consulta de telemedicina.",
    "Routine Blood Draw": "Análisis de sangre de rutina",
    "Completed Jun 17, 2026": "Completado el 17 de junio de 2026",
    "Refill request sent to your pharmacy.": "Solicitud de relleno enviada a su farmacia."
  },
  zh: {
    "MyHealth Portal": "我的健康门户",
    "Secure Patient Access": "安全的患者访问",
    "Dashboard": "仪表板",
    "Test Results": "检查结果",
    "Medications": "药物",
    "Messages": "消息",
    "Appointments": "预约",
    "Upcoming Appointment": "即将到来的预约",
    "Dr. Sarah Chen — Cardiology": "陈医生 — 心脏病学",
    "June 25, 2026 at 2:30 PM · Virtual Visit": "2026年6月25日 下午2:30 · 虚拟访问",
    "Add to calendar": "添加到日历",
    "Health Alerts": "健康提醒",
    "You have 1 new message": "您有1条新消息",
    "Lab Results (Most recent)": "实验室结果（最新）",
    "Note: Results are for informational purposes. Contact your clinician for medical advice.": "注意：结果仅供参考。如需医疗建议，请联系您的临床医生。",
    "Take twice daily with meals": "每日随餐服用两次",
    "Once daily — morning": "每天一次 — 早晨",
    "At bedtime": "睡前",
    "Request Refill": "请求续药",
    "Click \"Request Refill\" to send a refill request to your provider.": "单击“请求续药”以向您的提供者发送续药请求。",
    "Annual flu shot is due — click to schedule at a nearby clinic.": "年度流感疫苗到期 — 单击以在附近的诊所安排。",
    "John—Your HbA1c is 7.2. I'd like to review your blood sugar logs and consider a small med adjustment. Please schedule a telehealth follow-up.": "约翰——您的HbA1c为7.2。 我想查看您的血糖记录并考虑小的药物调整。 请安排远程随访。",
    "Routine Blood Draw": "常规抽血",
    "Completed Jun 17, 2026": "已完成 2026年6月17日",
    "Refill request sent to your pharmacy.": "续药请求已发送到您的药房。"
  },
  ur: {
    "MyHealth Portal": "میرا ہیلتھ پورٹل",
    "Secure Patient Access": "مریض کا محفوظ رسائی",
    "Dashboard": "ڈیش بورڈ",
    "Test Results": "ٹیسٹ کے نتائج",
    "Medications": "دوائیں",
    "Messages": "پیغامات",
    "Appointments": "ملاقاتیں",
    "Upcoming Appointment": "آنے والی ملاقات",
    "Dr. Sarah Chen — Cardiology": "ڈاکٹر سارہ چن — قلبی امراض",
    "June 25, 2026 at 2:30 PM · Virtual Visit": "25 جون 2026 کو 2:30 بجے دوپہر · ورچوئل دورہ",
    "Add to calendar": "کلینڈر میں شامل کریں",
    "Health Alerts": "صحت کی انتباہات",
    "You have 1 new message": "آپ کے پاس 1 نیا پیغام ہے",
    "Lab Results (Most recent)": "لیبارٹری کے نتائج (تازہ ترین)",
    "Note: Results are for informational purposes. Contact your clinician for medical advice.": "نوٹ: نتائج صرف معلوماتی مقاصد کے لیے ہیں۔ طبی مشورے کے لیے اپنے معالج سے رابطہ کریں۔",
    "Take twice daily with meals": "کھانے کے ساتھ روزانہ دو بار لیں",
    "Once daily — morning": "روزانہ ایک بار — صبح",
    "At bedtime": "سونے سے پہلے",
    "Request Refill": "بھرتی کی درخواست کریں",
    "Click \"Request Refill\" to send a refill request to your provider.": "اپنے فراہم کنندہ کو بھرتی کی درخواست بھیجنے کے لیے \"بھرتی کی درخواست کریں\" پر کلک کریں۔",
    "Annual flu shot is due — click to schedule at a nearby clinic.": "سالانہ فلو شاٹ واجب الادا ہے — قریب ترین کلینک میں شیڈول کرنے کے لیے کلک کریں۔",
    "John—Your HbA1c is 7.2. I'd like to review your blood sugar logs and consider a small med adjustment. Please schedule a telehealth follow-up.": "جان — آپ کا HbA1c 7.2 ہے۔ میں آپ کے بلڈ شوگر لاگز کا جائزہ لینا چاہوں گا اور ایک چھوٹا میڈ ایڈجسٹمنٹ پر غور کروں گا۔ براہ کرم ٹیل ہیلتھ فالو اپ شیڈول کریں۔",
    "Routine Blood Draw": "معمول کا خون کا ٹیسٹ",
    "Completed Jun 17, 2026": "17 جون 2026 کو مکمل ہوا",
    "Refill request sent to your pharmacy.": "بھرتی کی درخواست آپ کی فارمیسی کو بھیج دی گئی ہے۔"
  },
  hi: {
    "MyHealth Portal": "माईहेल्थ पोर्टल",
    "Secure Patient Access": "सुरक्षित रोगी पहुँच",
    "Dashboard": "डैशबोर्ड",
    "Test Results": "परीक्षण परिणाम",
    "Medications": "दवाइयाँ",
    "Messages": "संदेश",
    "Appointments": "अपॉइंटमेंट",
    "Upcoming Appointment": "आगामी अपॉइंटमेंट",
    "Dr. Sarah Chen — Cardiology": "डॉ. सारा चेन — कार्डियोलॉजी",
    "June 25, 2026 at 2:30 PM · Virtual Visit": "25 जून 2026 को 2:30 बजे दोपहर · वर्चुअल विज़िट",
    "Add to calendar": "कैलेंडर में जोड़ें",
    "Health Alerts": "स्वास्थ्य अलर्ट",
    "You have 1 new message": "आपके पास 1 नया संदेश है",
    "Lab Results (Most recent)": "प्रयोगशाला परिणाम (सबसे हाल के)",
    "Note: Results are for informational purposes. Contact your clinician for medical advice.": "नोट: परिणाम केवल सूचना के लिए हैं। चिकित्सा सलाह के लिए अपने चिकित्सक से संपर्क करें.",
    "Take twice daily with meals": "खाने के साथ दिन में दो बार लें",
    "Once daily — morning": "दिन में एक बार — सुबह",
    "At bedtime": "सोने के समय",
    "Request Refill": "रिक्वेस्ट रीफिल",
    "Click \"Request Refill\" to send a refill request to your provider.": "अपने प्रावाइडर को एक रीफिल अनुरोध भेजने के लिए \"रिक्वेस्ट रीफिल\" पर क्लिक करें।",
    "Annual flu shot is due — click to schedule at a nearby clinic.": "वार्षिक फ्लू शॉट देय है — नज़दीकी क्लिनिक में निर्धारित करने के लिए क्लिक करें।",
    "John—Your HbA1c is 7.2. I'd like to review your blood sugar logs and consider a small med adjustment. Please schedule a telehealth follow-up.": "जॉन — आपका HbA1c 7.2 है। मैं आपके रक्त शर्करा लॉग की समीक्षा करना चाहूंगा और एक छोटा दवा समायोजन पर विचार करना चाहूंगा। कृपया एक टेलीहेल्थ फॉलो-अप निर्धारित करें।",
    "Routine Blood Draw": "साधारण रक्त जांच",
    "Completed Jun 17, 2026": "17 जून 2026 को पूरा हुआ",
    "Refill request sent to your pharmacy.": "रीफिल अनुरोध आपकी फार्मेसी को भेजा गया है।"
  }
};

function isDemoPortalPage() {
  const href = window.location.href;
  const host = window.location.hostname;
  return href.includes('demo-portal.html') || host === 'localhost' || host === '127.0.0.1';
}

function translatePage(targetLang) {
  if (targetLang === "en") {
    if (isDemoPortalPage()) {
      restoreDemoPageText();
      setResponse('Page restored to English.');
      return;
    }
    location.reload(); // restore original for other portals
    return;
  }

  setResponse("Translating page...");

  if (isDemoPortalPage() && DEMO_TRANSLATIONS[targetLang]) {
    translateDemoPortalPage(targetLang);
    setResponse(`Page translated to ${getSelectedLanguageLabel()}.`);
    return;
  }

  // Fallback translation for other portals
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest("#careguide-sidebar")) return NodeFilter.FILTER_REJECT;
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  const BATCH_SIZE = 10;
  (async function processBatches() {
    for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
      const batch = nodes.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(node => translateNode(node, targetLang)));
    }
    setResponse(`Page translated to ${getSelectedLanguageLabel()}.`);
  })();
}

function translateDemoPortalPage(targetLang) {
  const dictionary = DEMO_TRANSLATIONS[targetLang] || {};
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest("#careguide-sidebar")) return NodeFilter.FILTER_REJECT;
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const original = node.textContent;
    if (!node.__cgOriginal) {
      node.__cgOriginal = original;
    }
    const sourceText = node.__cgOriginal || original;
    const trimmed = sourceText.trim();
    const translated = dictionary[trimmed];
    if (translated) {
      node.textContent = sourceText.replace(trimmed, translated);
    }
  }
}

function restoreDemoPageText() {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest("#careguide-sidebar")) return NodeFilter.FILTER_REJECT;
        if (!node.__cgOriginal) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  while (walker.nextNode()) {
    const node = walker.currentNode;
    node.textContent = node.__cgOriginal;
    delete node.__cgOriginal;
  }
}

async function translateNode(node, targetLang) {
  const text = node.textContent.trim();
  if (!text || text.length > 500) return; // skip very long nodes

  try {
    const res = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`
    );
    const data = await res.json();
    if (data.responseStatus === 200) {
      node.textContent = data.responseData.translatedText;
    }
  } catch (err) {
    console.error("Translation error:", err);
  }
}
