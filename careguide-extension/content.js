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
    minimizeSidebar();
  });
  document.getElementById("cg-caregiver-btn")?.addEventListener("click", () => {
    console.log("caregiver summary clicked");
    sendCaregiverSummary();
  });
  document.getElementById("cg-language-select")?.addEventListener("change", (e) => {
    console.log("language changed to", e.target.value);
    translatePage(e.target.value);
  });

  document.querySelectorAll(".cg-action-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const intent = btn.dataset.intent;
      console.log("action button clicked", intent);
      highlightElement(intent);
    });
  });
}

function minimizeSidebar() {
  const sidebar = document.getElementById('careguide-sidebar');
  if (!sidebar) return;
  sidebar.classList.add('minimized');

  // Add a small restore button if not present
  if (!document.getElementById('cg-restore')) {
    const rb = document.createElement('button');
    rb.id = 'cg-restore';
    rb.title = 'Open CareGuide';
    rb.textContent = '🩺';
    Object.assign(rb.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      width: '48px',
      height: '48px',
      borderRadius: '24px',
      border: 'none',
      background: '#2563eb',
      color: '#fff',
      zIndex: 999999,
      cursor: 'pointer',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
    });
    rb.addEventListener('click', () => restoreSidebar());
    document.body.appendChild(rb);
  }
}

function restoreSidebar() {
  const sidebar = document.getElementById('careguide-sidebar');
  if (sidebar) sidebar.classList.remove('minimized');
  const rb = document.getElementById('cg-restore');
  if (rb) rb.remove();
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

// ── Init ─────────────────────────────────────────────────────────────────────
console.log("CareGuide content script loaded on:", window.location.href);
injectSidebar(detectPortal());

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "EXPLAIN_SELECTION") {
    askClaude(`Please explain this in simple language: "${message.text}"`);
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
