// ─── CareGuide Background Service Worker ────────────────────────────────────
// Handles all API communication (Claude, Twilio) so API keys stay off the page.

const BACKEND_URL = "https://your-careguide-backend.com"; // swap with your Cloud Run URL

// ── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ASK_CLAUDE") {
    handleClaudeRequest(message.payload).then(sendResponse);
    return true; // keep channel open for async response
  }

  if (message.type === "CAREGIVER_SUMMARY") {
    handleCaregiverSummary(message.payload).then(sendResponse);
    return true;
  }
});

// ── Claude AI Request ────────────────────────────────────────────────────────
async function handleClaudeRequest({ userText, selectedText, language, portalName }) {
  try {
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    const data = await response.json();
    const reply = data.content?.[0]?.text || "I couldn't understand that. Please try again.";
    return { reply };
  } catch (err) {
    console.error("Claude API error:", err);
    return { reply: "I'm having trouble connecting right now. Please try again in a moment." };
  }
}

// ── Caregiver Summary ────────────────────────────────────────────────────────
async function handleCaregiverSummary({ pageText, portalName }) {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

    const data = await response.json();
    const summary = data.content?.[0]?.text || "Could not generate summary.";
    return { summary };
  } catch (err) {
    return { summary: "Error generating summary. Please try again." };
  }
}
