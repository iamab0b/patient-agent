/* Shared chrome for the demo MyHealth portal: sidebar nav + top header + patient banner.
   Each page sets <body data-page="..."> and provides a <main class="main"><div class="content">.
   This injects the rest so the nav/banner stay consistent across pages. */
(function () {
  // Fictional demo patient — no real PHI.
  var PATIENT = { name: "John Smith", dob: "12/10/1957", age: 68, mrn: "11223344", pcp: "Sarah Chen, MD" };

  var NAV = [
    { key: "home",         label: "Home",            href: "demo-portal.html" },
    { key: "results",      label: "Test Results",    href: "test-results.html" },
    { key: "medications",  label: "Medications",     href: "medications.html" },
    { key: "appointments", label: "Appointments",    href: "appointments.html" },
    { key: "health",       label: "Health Summary",  href: "health-summary.html" },
    { key: "messages",     label: "Messages",        href: "messages.html" }
  ];

  var page = document.body.getAttribute("data-page") || "home";

  var app = document.querySelector(".app");
  var main = document.querySelector(".main");
  if (!app || !main) return;

  // Sidebar
  var aside = document.createElement("aside");
  aside.className = "sidebar";
  aside.innerHTML =
    '<div class="logo"><div class="mark">MH</div><div>MyHealth Online' +
    '<small>Secure Patient Access</small></div></div>' +
    '<nav class="nav" aria-label="Main navigation">' +
    NAV.map(function (n) {
      return '<a href="' + n.href + '"' + (n.key === page ? ' class="active"' : "") +
             '>' + n.label + "</a>";
    }).join("") +
    "</nav>";
  app.insertBefore(aside, main);

  // Top header
  var header = document.createElement("header");
  header.className = "topbar";
  header.innerHTML =
    '<div class="title">MyHealth Online</div>' +
    '<div class="signin">' + PATIENT.name + ' &middot; Last signed in: Jun 18, 2026</div>';
  main.insertBefore(header, main.firstChild);

  // Patient banner
  var banner = document.createElement("div");
  banner.className = "banner";
  banner.innerHTML =
    "<span>Name: <b>" + PATIENT.name + "</b></span>" +
    "<span>DOB: <b>" + PATIENT.dob + "</b> (age " + PATIENT.age + ")</span>" +
    "<span>MRN: <b>" + PATIENT.mrn + "</b></span>" +
    "<span>PCP: <b>" + PATIENT.pcp + "</b></span>";
  main.insertBefore(banner, header.nextSibling);

  // Demo-only interactions: any element with data-demo-action shows a confirmation.
  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-demo-action]");
    if (el) {
      e.preventDefault();
      alert(el.getAttribute("data-demo-action"));
    }
  });
})();
