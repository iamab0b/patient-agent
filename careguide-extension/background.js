// ─── CareGuide Background Service Worker ────────────────────────────────────
// Handles all API communication (Claude, Twilio) so API keys stay off the page.

console.log("CareGuide background worker starting");
const BACKEND_URL = "https://your-careguide-backend.com"; // swap with your Cloud Run URL

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
          sendResponse({ reply: "Error processing request." });
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

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "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",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const txt = await response.text().catch(() => "");
      console.error("Claude API non-OK response", response.status, txt);
      return { reply: "I'm having trouble connecting right now. Please try again in a moment." };
    }

    const data = await response.json().catch((e) => {
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
    return { reply: "I'm having trouble connecting right now. Please try again in a moment." };
  }
}

// ── Caregiver Summary ────────────────────────────────────────────────────────
async function handleCaregiverSummary({ pageText, portalName }) {
  try {
    console.log("handleCaregiverSummary payload: portal=", portalName, "chars=", pageText?.length || 0);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json",
        "x-api-key": "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",
        "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: `You summarize patient portal pages for caregivers of elderly patients. 
Write in plain, warm language. Focus on: upcoming appointments, new test results, 
medication changes, and any action items. Keep it under 150 words. 
Start with "Here's a summary of [patient's] portal as of today:"`,
        messages: [{
          role: "user",
          content: `Portal: ${portalName}\n\nPage content:\n${pageText}`,
        }],
      }),
    });

    if (!response.ok) {
      console.error("Caregiver summary API error status:", response.status);
      return { summary: "Error generating summary. Please try again." };
    }

    const data = await response.json().catch((e) => (console.error("Error parsing summary JSON:", e), null));
    console.log("Caregiver API response:", data);
    const summary = data?.content?.[0]?.text || data?.completion?.[0]?.data?.text || data?.message || data?.reply || "Could not generate summary.";
    return { summary };
  } catch (err) {
    return { summary: "Error generating summary. Please try again." };
  }
}
