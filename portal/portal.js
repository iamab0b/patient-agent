/* Shared chrome + demo state for the MyHealth portal.
   - Injects sidebar nav, header (with notification bell + account link), patient banner.
   - Provides window.Portal: localStorage-backed notifications + action flags so that
     actions taken on one page persist and are reflected (as badges) across pages.
   Declarative button wiring (no per-page JS needed for simple actions):
     data-act="message"        -> posts a notification + toast on click
     data-flag="key"           -> also sets a persistent flag (once)
     data-done="Label"         -> replaces the button with a success badge after click
     data-goto="page.html"     -> navigates there shortly after the action
     data-flag-when="key"      -> element only shown if that flag is set
     data-flag-unless="key"    -> element only shown if that flag is NOT set
   Pages with dynamic actions can call Portal.notify()/Portal.setFlag() directly. */
(function () {
  var PATIENT = { name: "John Smith", dob: "12/10/1957", age: 68, mrn: "11223344", pcp: "Sarah Chen, MD" };

  var NAV = [
    { key: "home",         label: "Home",           href: "demo-portal.html" },
    { key: "results",      label: "Test Results",   href: "test-results.html" },
    { key: "medications",  label: "Medications",    href: "medications.html" },
    { key: "appointments", label: "Appointments",   href: "appointments.html" },
    { key: "health",       label: "Health Summary", href: "health-summary.html" },
    { key: "messages",     label: "Messages",       href: "messages.html" },
    { key: "billing",      label: "Billing",        href: "billing.html" },
    { key: "care",         label: "Care Team",      href: "care-team.html" },
    { key: "documents",    label: "Documents",      href: "documents.html" }
  ];

  /* ---------- persistent demo state ---------- */
  var KEY = "mho_demo_v1";
  var mem = {};
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return mem; } }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { mem = state; } }
  var state = load();
  state.notifications = state.notifications || [];
  state.flags = state.flags || {};

  function nowStr() {
    return new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  var Portal = {
    notify: function (text) {
      state.notifications.unshift({ text: text, time: nowStr(), read: false });
      persist(); updateBell(); toast(text);
    },
    flag: function (k) { return !!state.flags[k]; },
    setFlag: function (k, v) { state.flags[k] = v; persist(); },
    list: function () { return state.notifications; },
    unread: function () { return state.notifications.filter(function (n) { return !n.read; }).length; },
    markAllRead: function () { state.notifications.forEach(function (n) { n.read = true; }); persist(); updateBell(); },
    clear: function () { state.notifications = []; persist(); updateBell(); },
    reset: function () { state.notifications = []; state.flags = {}; persist(); updateBell(); }
  };
  window.Portal = Portal;

  function toast(text) {
    var c = document.getElementById("toast-c");
    if (!c) { c = document.createElement("div"); c.id = "toast-c"; c.className = "toast-c"; document.body.appendChild(c); }
    var t = document.createElement("div"); t.className = "toast"; t.textContent = "✓ " + text; c.appendChild(t);
    setTimeout(function () { t.classList.add("show"); }, 10);
    setTimeout(function () { t.classList.remove("show"); setTimeout(function () { t.remove(); }, 300); }, 3200);
  }

  function updateBell() {
    var b = document.getElementById("bell-count"); if (!b) return;
    var n = Portal.unread(); b.textContent = n; b.style.display = n ? "" : "none";
  }

  /* ---------- chrome injection ---------- */
  var page = document.body.getAttribute("data-page") || "home";
  var app = document.querySelector(".app");
  var main = document.querySelector(".main");
  if (!app || !main) return;

  var aside = document.createElement("aside");
  aside.className = "sidebar";
  aside.innerHTML =
    '<div class="logo"><div class="mark">MH</div><div>MyHealth Online' +
    '<small>Secure Patient Access</small></div></div>' +
    '<nav class="nav" aria-label="Main navigation">' +
    NAV.map(function (n) {
      return '<a href="' + n.href + '"' + (n.key === page ? ' class="active"' : "") + '>' + n.label + "</a>";
    }).join("") +
    "</nav>";
  app.insertBefore(aside, main);

  var header = document.createElement("header");
  header.className = "topbar";
  header.innerHTML =
    '<div class="title">MyHealth Online</div>' +
    '<div class="hdr-actions">' +
      '<a class="bell" href="notifications.html" title="Notifications">🔔' +
        '<span id="bell-count" class="bell-badge"></span></a>' +
      '<a class="acct" href="profile.html">' + PATIENT.name + ' ▾</a>' +
    '</div>';
  main.insertBefore(header, main.firstChild);

  var banner = document.createElement("div");
  banner.className = "banner";
  banner.innerHTML =
    "<span>Name: <b>" + PATIENT.name + "</b></span>" +
    "<span>DOB: <b>" + PATIENT.dob + "</b> (age " + PATIENT.age + ")</span>" +
    "<span>MRN: <b>" + PATIENT.mrn + "</b></span>" +
    "<span>PCP: <b>" + PATIENT.pcp + "</b></span>";
  main.insertBefore(banner, header.nextSibling);

  /* ---------- declarative action handler ---------- */
  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-act],[data-demo-action]");
    if (!el) return;
    e.preventDefault();
    var msg = el.getAttribute("data-act") || el.getAttribute("data-demo-action");
    var flag = el.getAttribute("data-flag");
    if (flag) { if (Portal.flag(flag)) return; Portal.setFlag(flag, true); }
    if (msg) Portal.notify(msg);
    var done = el.getAttribute("data-done");
    if (done) { var s = document.createElement("span"); s.className = "badge ok"; s.textContent = done; el.replaceWith(s); }
    var goto = el.getAttribute("data-goto");
    if (goto) setTimeout(function () { location.href = goto; }, 700);
  });

  /* ---------- reflect persisted flags on load ---------- */
  document.querySelectorAll("[data-flag][data-done]").forEach(function (el) {
    if (Portal.flag(el.getAttribute("data-flag"))) {
      var s = document.createElement("span"); s.className = "badge ok"; s.textContent = el.getAttribute("data-done"); el.replaceWith(s);
    }
  });
  document.querySelectorAll("[data-flag-when]").forEach(function (el) {
    el.style.display = Portal.flag(el.getAttribute("data-flag-when")) ? "" : "none";
  });
  document.querySelectorAll("[data-flag-unless]").forEach(function (el) {
    el.style.display = Portal.flag(el.getAttribute("data-flag-unless")) ? "none" : "";
  });
  updateBell();
})();
