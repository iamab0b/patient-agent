// ─── CareGuide Background Service Worker ────────────────────────────────────
// Handles all API communication (Claude, Twilio) so API keys stay off the page.

console.log("CareGuide background worker starting");
const BACKEND_URL = "https://your-careguide-backend.com"; // swap with your Cloud Run URL
const ANTHROPIC_API_KEY = "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";
const CLAUDE_API_ENDPOINT = "https://api.anthropic.com/v1/messages";

function getAnthropicHeaders() {
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": "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",
    "anthropic-version": "2023-06-01",
  };
  // When calling from browser contexts, Anthropic requires an explicit header
  // acknowledging direct-browser access. This is unsafe for production; prefer
  // routing requests through a backend proxy so API keys are not exposed.
  headers["anthropic-dangerous-direct-browser-access"] = "true";
  return headers;
}

function isAnthropicKeyConfigured() {
  return ANTHROPIC_API_KEY && !ANTHROPIC_API_KEY.includes("<REPLACE_WITH");
}

// ── Context Menu Setup ───────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "careguide-explain",
    title: "Explain with CareGuide",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "careguide-explain") {
    chrome.tabs.sendMessage(tab.id, {
      type: "EXPLAIN_SELECTION",
      text: info.selectionText
    });
  }
});



// ── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    console.log("background onMessage received:", message?.type);

    if (message?.type === "ASK_CLAUDE") {
      handleClaudeRequest(message.payload)
        .then((res) => {
          console.log("handleClaudeRequest result:", res);
          sendResponse(res);
        })
        .catch((err) => {
          console.error("handleClaudeRequest error:", err);
          sendResponse({ reply: `Error processing request: ${err?.message || err}` });
        });
      return true; // keep channel open for async response
    }

    if (message?.type === "CAREGIVER_SUMMARY") {
      handleCaregiverSummary(message.payload)
        .then((res) => sendResponse(res))
        .catch((err) => {
          console.error("handleCaregiverSummary error:", err);
          sendResponse({ summary: "Error generating summary." });
        });
      return true;
    }

    console.warn("Unhandled background message type:", message?.type, message);
  } catch (e) {
    console.error("onMessage listener error:", e);
  }
});

// ── Claude AI Request ────────────────────────────────────────────────────────
async function handleClaudeRequest({ userText, selectedText, language, portalName }) {
  try {
    console.log("handleClaudeRequest payload:", { userText, selectedText, language, portalName });
    const systemPrompt = `You are CareGuide, a warm and patient health assistant helping elderly users 
navigate their ${portalName} patient portal. 

Your rules:
- Always respond in ${language}
- Use simple, clear language — no medical jargon without explanation
- Be reassuring, never alarming
- Keep responses under 3 sentences unless explaining a complex result
- If explaining a lab result, always note that their doctor has reviewed it
- Never give medical advice — only explain what they're seeing`;

    const userMessage = selectedText
      ? `The user selected this text on their portal: "${selectedText}"\n\nThey asked: "${userText}"`
      : userText;

    const requestBody = {
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    };

    // Prefer routing via a backend proxy if configured to avoid exposing API keys
    if (BACKEND_URL && !BACKEND_URL.includes('your-careguide-backend.com')) {
      try {
        const proxyResp = await fetch(`${BACKEND_URL.replace(/\/+$/,'')}/claude`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestBody }),
        });
        if (!proxyResp.ok) {
          const txt = await proxyResp.text().catch(() => '');
          console.error('Backend proxy error', proxyResp.status, txt);
          return { reply: `Backend proxy error ${proxyResp.status} ${txt}` };
        }
        const proxyData = await proxyResp.json().catch(() => null);
        return { reply: proxyData?.reply || proxyData?.text || 'No reply from backend proxy.' };
      } catch (e) {
        console.error('Backend proxy request failed:', e);
        // fall through to direct call if possible
      }
    }

    if (!isAnthropicKeyConfigured()) {
      return { reply: "CareGuide is not configured with an Anthropic API key. Please set ANTHROPIC_API_KEY in background.js or configure BACKEND_URL." };
    }

    console.warn('Calling Anthropic directly from the extension. This exposes your API key to client-side contexts. For production, use BACKEND_URL proxy.');

    const response = await fetch(CLAUDE_API_ENDPOINT, {
      method: "POST",
      headers: getAnthropicHeaders(),
      body: JSON.stringify(requestBody),
    });

    let data = null;
    if (!response.ok) {
      const txt = await response.text().catch(() => "");
      console.error("Claude API non-OK response", response.status, response.statusText, txt);
      const errorDetail = txt ? ` ${txt}` : "";
      return {
        reply: `Claude API error ${response.status}${errorDetail}`,
      };
    }

    data = await response.json().catch((e) => {
      console.error("Error parsing Claude JSON:", e);
      return null;
    });
    console.log("Claude response payload:", data);

    // Try multiple possible response shapes (robust fallback)
    let reply = null;
    if (data) {
      reply = data.content?.[0]?.text || data.completion?.[0]?.data?.text || data.completion?.[0]?.text || data.message || data.reply || data.output?.[0]?.content || null;
    }
    reply = reply || "I couldn't understand that. Please try again.";
    return { reply };
  } catch (err) {
    console.error("Claude API error:", err);
    return { reply: `Connection error: ${err?.message || err}` };
  }
}

// ── Caregiver Summary ────────────────────────────────────────────────────────
async function handleCaregiverSummary({ pageText, portalName }) {
  try {
    console.log("handleCaregiverSummary payload: portal=", portalName, "chars=", pageText?.length || 0);
    if (!isAnthropicKeyConfigured()) {
      return { summary: "CareGuide is not configured with an Anthropic API key. Please set ANTHROPIC_API_KEY in background.js." };
    }

    // Prefer backend proxy for summarization as well
    if (BACKEND_URL && !BACKEND_URL.includes('your-careguide-backend.com')) {
      try {
        const proxyResp = await fetch(`${BACKEND_URL.replace(/\/+$/,'')}/caregiver-summary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ portalName, pageText }),
        });
        if (!proxyResp.ok) {
          const txt = await proxyResp.text().catch(() => '');
          console.error('Backend proxy error', proxyResp.status, txt);
          return { summary: `Backend proxy error ${proxyResp.status} ${txt}` };
        }
        const proxyData = await proxyResp.json().catch(() => null);
        return { summary: proxyData?.summary || proxyData?.text || 'No summary from backend proxy.' };
      } catch (e) {
        console.error('Backend proxy request failed:', e);
        // fall through to direct call if possible
      }
    }

    if (!isAnthropicKeyConfigured()) {
      return { summary: "CareGuide is not configured with an Anthropic API key. Please set ANTHROPIC_API_KEY in background.js or configure BACKEND_URL." };
    }

    console.warn('Calling Anthropic directly from the extension. This exposes your API key to client-side contexts. For production, use BACKEND_URL proxy.');

    const response = await fetch(CLAUDE_API_ENDPOINT, {
      method: "POST",
      headers: getAnthropicHeaders(),
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: `You summarize patient portal pages for caregivers of elderly patients. 
Write in plain, warm language. Focus on: upcoming appointments, new test results, 
medication changes, and any action items. Keep it under 150 words. 
Start with "Here's a summary of [patient's] portal as of today:",`,
        messages: [{
          role: "user",
          content: `Portal: ${portalName}\n\nPage content:\n${pageText}`,
        }],
      }),
    });

    if (!response.ok) {
      const txt = await response.text().catch(() => "");
      console.error("Caregiver summary API error status:", response.status, response.statusText, txt);
      const errorDetail = txt ? ` ${txt}` : "";
      return { summary: `Caregiver API error ${response.status}${errorDetail}` };
    }

    const data = await response.json().catch((e) => {
      console.error("Error parsing summary JSON:", e);
      return null;
    });
    console.log("Caregiver API response:", data);
    const summary = data?.content?.[0]?.text || data?.completion?.[0]?.data?.text || data?.message || data?.reply || "Could not generate summary.";
    return { summary };
  } catch (err) {
    return { summary: "Error generating summary. Please try again." };
  }
}
