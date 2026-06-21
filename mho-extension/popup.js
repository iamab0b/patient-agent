// ─── CareGuide Popup Script ───────────────────────────────────────────────
// Loads saved settings into the popup and saves them back to chrome.storage.

const fields = {
  caregiverPhone: document.getElementById("caregiver-phone"),
  languagePref:   document.getElementById("language-pref"),
  voiceEnabled:   document.getElementById("voice-enabled"),
  autoOpen:       document.getElementById("auto-open"),
};

// Load saved settings
chrome.storage.local.get(
  ["caregiverPhone", "languagePref", "voiceEnabled", "autoOpen"],
  (data) => {
    if (data.caregiverPhone) fields.caregiverPhone.value = data.caregiverPhone;
    if (data.languagePref)   fields.languagePref.value   = data.languagePref;
    if (data.voiceEnabled !== undefined) fields.voiceEnabled.checked = data.voiceEnabled;
    if (data.autoOpen !== undefined)     fields.autoOpen.checked     = data.autoOpen;
  }
);

// Save settings
document.getElementById("save-btn").addEventListener("click", () => {
  chrome.storage.local.set({
    caregiverPhone: fields.caregiverPhone.value,
    languagePref:   fields.languagePref.value,
    voiceEnabled:   fields.voiceEnabled.checked,
    autoOpen:       fields.autoOpen.checked,
  }, () => {
    const msg = document.getElementById("saved-msg");
    msg.style.display = "block";
    setTimeout(() => (msg.style.display = "none"), 2000);
  });
});
