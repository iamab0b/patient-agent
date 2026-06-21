// ─── CareGuide Popup Script ───────────────────────────────────────────────
// Loads saved settings into the popup and saves them back to chrome.storage.

const fields = {
  caregiverEmail: document.getElementById("caregiver-email"),
  languagePref:   document.getElementById("language-pref"),
  voiceEnabled:   document.getElementById("voice-enabled"),
  autoOpen:       document.getElementById("auto-open"),
};

// Load saved settings
chrome.storage.local.get(
  ["caregiverEmail", "languagePref", "voiceEnabled", "autoOpen"],
  (data) => {
    if (data.caregiverEmail) fields.caregiverEmail.value = data.caregiverEmail;
    if (data.languagePref)   fields.languagePref.value   = data.languagePref;
    if (data.voiceEnabled !== undefined) fields.voiceEnabled.checked = data.voiceEnabled;
    if (data.autoOpen !== undefined)     fields.autoOpen.checked     = data.autoOpen;
  }
);

// Save settings
document.getElementById("save-btn").addEventListener("click", () => {
  chrome.storage.local.set({
    caregiverEmail: fields.caregiverEmail.value,
    languagePref:   fields.languagePref.value,
    voiceEnabled:   fields.voiceEnabled.checked,
    autoOpen:       fields.autoOpen.checked,
  }, () => {
    const msg = document.getElementById("saved-msg");
    msg.style.display = "block";
    setTimeout(() => (msg.style.display = "none"), 2000);
  });
});
