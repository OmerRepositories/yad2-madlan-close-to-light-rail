// חלון ההגדרות: שומר אוטומטית ל-chrome.storage.sync. ה-content script מאזין לשינויים ומתעדכן מיד.
const DEFAULTS = {
  maxPpsm: 0,
  belowMedianPct: 10,
  requireRail: true,
  nearM: 800,
  highlight: true,
};

const $ = (id) => document.getElementById(id);
const numberKeys = ["maxPpsm", "belowMedianPct", "nearM"];
const boolKeys = ["requireRail", "highlight"];

function fill(s) {
  for (const k of numberKeys) $(k).value = s[k] ? s[k] : k === "nearM" ? s[k] : "";
  for (const k of boolKeys) $(k).checked = Boolean(s[k]);
  syncDisabled();
}

// כשמבטלים את הדרישה לרכבת, שדה המרחק לא רלוונטי
function syncDisabled() {
  $("nearM").disabled = !$("requireRail").checked;
}

function read() {
  const out = {};
  for (const k of numberKeys) {
    const n = Number($(k).value);
    out[k] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  if (!out.nearM) out.nearM = DEFAULTS.nearM;
  out.belowMedianPct = Math.min(out.belowMedianPct, 90);
  for (const k of boolKeys) out[k] = $(k).checked;
  return out;
}

let statusTimer = null;
function flash(msg) {
  $("status").textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($("status").textContent = ""), 1500);
}

let saveTimer = null;
function save() {
  syncDisabled();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.sync.set(read(), () => flash("✓ נשמר"));
  }, 250);
}

chrome.storage.sync.get(DEFAULTS, (s) => fill(s));

for (const k of [...numberKeys, ...boolKeys]) {
  $(k).addEventListener("input", save);
  $(k).addEventListener("change", save);
}

$("reset").addEventListener("click", () => {
  fill(DEFAULTS);
  chrome.storage.sync.set(DEFAULTS, () => flash("✓ אופס"));
});
