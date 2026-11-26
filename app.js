// Appraisal Log — non-clinical activity record for NHS appraisal and job planning.
// Same architecture as PeopleLog: vanilla ES modules, Firebase Auth + Firestore (offline), Gemini REST, no build step.

const APP_VERSION = "1.2.1";

// ───────────────────────────────────────────── 1. Firebase
import { firebaseConfig } from "./firebase-config.js?v=1.2.1";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, onSnapshot, setDoc, writeBatch, deleteDoc, terminate,
  clearIndexedDbPersistence, serverTimestamp, deleteField
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const configured = !String(firebaseConfig.apiKey || "").startsWith("PASTE");
let app, auth, db;
if (configured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
}

// ───────────────────────────────────────────── 2. Constants
const CODES = [
  { id: "S1", label: "Training" },
  { id: "S2", label: "Continuing Professional Development" },
  { id: "S3", label: "Teaching" },
  { id: "S4", label: "Audit / Clinical Governance" },
  { id: "S5", label: "Job Planning / Appraisal" },
  { id: "S6", label: "Research" },
  { id: "S7", label: "Clinical management" },
  { id: "S8", label: "General administration" },
  { id: "A2", label: "Audit or governance lead" },
  { id: "D4", label: "Work for Royal Colleges" },
  { id: "D5", label: "Other duties" },
  { id: "CX", label: "Clinical / extra sessions (not SPA)" }
];
const CODE_LABEL = Object.fromEntries(CODES.map(c => [c.id, c.label]));
const NON_SPA = new Set(["CX"]);

const DEFAULT_TAGS = [
  ["epr", "ICU EPR lead / ICCA"],
  ["gov", "ICU governance lead"],
  ["halo-sed", "RCoA HALO – sedation"],
  ["halo-res", "RCoA HALO – research management"],
  ["research", "Research"],
  ["ai", "AI / digital projects"],
  ["legal", "Medico-legal"],
  ["teach", "Teaching & admissions interviews"],
  ["appr", "Appraisal & revalidation"]
];
// Job plan items: each SPA entry is attributed to exactly one item (keywords first, then tags, in item order);
// untagged entries go to the core item; tagged entries that match nothing are "not in job plan".
const DEFAULT_ITEMS = {
  forum: { name: "ICU forum (monthly half-day)", pas: 0.2857, unlogged: null, tags: {}, keywords: "ICU forum", core: false, order: 0 },
  digital: { name: "Digital lead (ICU EPR / ICCA, AI and digital projects)", pas: 1.5, unlogged: null, tags: { epr: true, ai: true }, keywords: "", core: false, order: 1 },
  governance: { name: "ICU governance lead (incl. complaints, incidents, medico-legal)", pas: 1, unlogged: null, tags: { gov: true, legal: true }, keywords: "", core: false, order: 2 },
  core: { name: "Core SPA (CPD, appraisal, revalidation, teaching, audit)", pas: 2, unlogged: null,
    tags: { appr: true, teach: true, "halo-sed": true, "halo-res": true, research: true }, keywords: "", core: true, order: 3 }
};
const DEFAULT_JOBPLAN = { totalPAs: 10.25, weeksPerYear: 42, unloggedFrom: "2026-07-01", items: DEFAULT_ITEMS };
const DEFAULT_MODEL = "gemini-flash-latest";
const DRAFT_KEY = "appraisallog-draft";
const PAGE = 100;

// ───────────────────────────────────────────── 3. State
const state = {
  user: null,
  settings: null,
  entries: new Map(),
  reports: new Map(),
  pending: false,
  fromCache: false,
  unsub: [],
  listLimit: PAGE,
  homePeriod: null,
  reportPeriod: null
};

// ───────────────────────────────────────────── 4. Helpers
const $ = sel => document.querySelector(sel);
function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "html") n.innerHTML = v;
    else if (v === true) n.setAttribute(k, "");
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}
const uid = () => crypto.randomUUID();
const todayISO = () => isoDate(new Date());
function isoDate(d) {
  const z = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function parseISO(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function fmtDate(s, opts = { day: "numeric", month: "short", year: "numeric" }) {
  if (!s) return "";
  return parseISO(s).toLocaleDateString("en-GB", opts);
}
function addDays(s, n) { const d = parseISO(s); d.setDate(d.getDate() + n); return isoDate(d); }
function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }
function fmtHours(x) { return x == null || x === "" ? "" : `${String(round2(+x))} h`; }
const round2 = x => Math.round(x * 100) / 100;
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function tagsOf(e) { return Object.keys(e.tags || {}).filter(k => e.tags[k]); }
function tagName(id) { return state.settings?.tags?.[id]?.name || id; }
function activeTags() {
  return Object.entries(state.settings?.tags || {})
    .filter(([, t]) => !t.archived)
    .sort((a, b) => (a[1].order ?? 99) - (b[1].order ?? 99) || a[1].name.localeCompare(b[1].name))
    .map(([id, t]) => ({ id, ...t }));
}
function allTags() {
  return Object.entries(state.settings?.tags || {})
    .sort((a, b) => (a[1].order ?? 99) - (b[1].order ?? 99))
    .map(([id, t]) => ({ id, ...t }));
}
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || uid().slice(0, 8); }
function download(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function batchWrite(ops) { // ops: [{ref, data, merge} | {ref, del:true}]
  for (let i = 0; i < ops.length; i += 450) {
    const b = writeBatch(db);
    for (const op of ops.slice(i, i + 450)) {
      if (op.del) b.delete(op.ref);
      else b.set(op.ref, op.data, op.merge ? { merge: true } : undefined);
    }
    await b.commit();
  }
}
const userDoc = (...p) => doc(db, "users", state.user.uid, ...p);
const userCol = (...p) => collection(db, "users", state.user.uid, ...p);

// Information-governance check: flags things that look patient-identifiable.
function igFlags(text) {
  const t = String(text || "");
  const flags = [];
  if (/\b\d{3}[\s-]?\d{3}[\s-]?\d{4}\b/.test(t)) flags.push("a 10-digit number (NHS number?)");
  if (/\b[A-Z]{1,3}\d{5,8}\b/.test(t)) flags.push("a hospital-number-like code");
  if (/\b(d\.?o\.?b\.?|date of birth|born on)\b/i.test(t)) flags.push("a date of birth");
  if (/\b(mr|mrs|ms|miss|master)\.?\s+[A-Z][a-z]+/.test(t)) flags.push("a titled name (check it isn't a patient)");
  if (/\b(patient|pt)\s+(called|named)?\s*[A-Z][a-z]+/.test(t)) flags.push("a patient name");
  if (/\bbed\s?\d{1,2}\b/i.test(t)) flags.push("a bed number");
  return flags;
}

// ───────────────────────────────────────────── 5. Appraisal periods
function appraisalDates() {
  return Object.values(state.settings?.appraisalDates || {}).map(x => x.date).filter(Boolean).sort();
}
function periods() {
  const D = appraisalDates();
  const out = [];
  const earliest = [...state.entries.values()].reduce((m, e) => (e.date && e.date < m ? e.date : m), todayISO());
  if (!D.length) {
    out.push({ key: "p-all", start: earliest, end: null, label: "All entries", short: "All" });
    return out;
  }
  if (earliest < D[0]) out.push({ key: "p-start", start: earliest, end: D[0],
    label: `For appraisal on ${fmtDate(D[0])} · from ${fmtDate(earliest)}`, short: fmtDate(D[0], { month: "short", year: "numeric" }) });
  D.forEach((d, i) => {
    const end = D[i + 1] || null;
    const future = end && end > todayISO();
    out.push({
      key: "p-" + d, start: d, end,
      label: end
        ? `For appraisal on ${fmtDate(end)}${future ? " (booked)" : ""} · ${fmtDate(d)} – ${fmtDate(addDays(end, -1))}`
        : `Current year · since appraisal on ${fmtDate(d)}`,
      short: end ? fmtDate(end, { month: "short", year: "numeric" }) : "Current"
    });
  });
  return out;
}
function currentPeriodKey() {
  const t = todayISO();
  const p = periods().find(p => p.start <= t && (!p.end || t < p.end));
  return p ? p.key : periods().at(-1).key;
}
function periodByKey(k) { return periods().find(p => p.key === k) || periods().find(p => p.key === currentPeriodKey()); }
function inPeriod(e, p) { return e.date >= p.start && (!p.end || e.date < p.end); }
function workingWeeks(p) {
  const end = !p.end || p.end > todayISO() ? addDays(todayISO(), 1) : p.end;
  const days = Math.max(1, daysBetween(p.start, end));
  const wpy = +(state.settings?.jobPlan?.weeksPerYear || 42);
  return (days / 7) * (wpy / 52);
}
function periodStats(p) {
  const list = [...state.entries.values()].filter(e => inPeriod(e, p));
  const byCode = {}, byTag = {}, byItem = {};
  let spaHours = 0, cxHours = 0;
  const items = jobItems();
  for (const e of list) {
    const hrs = +e.hours || 0;
    const it = itemOf(e, items);
    if (it) { (byItem[it] ||= { n: 0, hours: 0, list: [] }); byItem[it].n++; byItem[it].hours += hrs; byItem[it].list.push(e); }
    (byCode[e.code] ||= { n: 0, hours: 0, list: [] });
    byCode[e.code].n++; byCode[e.code].hours += hrs; byCode[e.code].list.push(e);
    if (NON_SPA.has(e.code)) cxHours += hrs; else spaHours += hrs;
    const tg = tagsOf(e);
    for (const t of tg) {
      (byTag[t] ||= { n: 0, hours: 0, list: [] });
      byTag[t].n++; byTag[t].hours += hrs; byTag[t].list.push(e);
    }
  }
  const weeks = workingWeeks(p);
  const paw = hrs => hrs / 4 / weeks;
  // Unlogged-time estimate applies only from the date set in Settings (when itemised logging stopped covering everything).
  const from = state.settings?.jobPlan?.unloggedFrom || "2026-07-01";
  const ow = p.end && p.end <= from ? 0 : workingWeeks({ start: p.start > from ? p.start : from, end: p.end });
  const hpw = unloggedTotalHpw();
  const unl = { hpw, from, weeks: ow, hours: hpw * ow, paw: hpw * ow / 4 / weeks, keyPaw: k => unloggedHpw(k) * ow / 4 / weeks };
  return { list, byCode, byTag, byItem, spaHours, cxHours, weeks, paw, unl };
}

// ───────────────────────────────────────────── 6. Auth
async function doSignIn() {
  const provider = new GoogleAuthProvider();
  $("#signin-error").hidden = true;
  try { await signInWithPopup(auth, provider); }
  catch (err) {
    if (["auth/popup-blocked", "auth/popup-closed-by-user", "auth/cancelled-popup-request", "auth/operation-not-supported-in-this-environment"].includes(err.code)) {
      await signInWithRedirect(auth, provider);
    } else { $("#signin-error").textContent = err.message; $("#signin-error").hidden = false; }
  }
}

function startListeners() {
  stopListeners();
  state.unsub.push(onSnapshot(userDoc("config", "settings"), { includeMetadataChanges: true }, snap => {
    const s = snap.data() || {};
    state.settings = normaliseSettings(s);
    if (!snap.exists() && !snap.metadata.fromCache) seedSettings();
    else if (snap.exists() && !snap.metadata.fromCache && !s.jobPlan?.items) // one-off upgrade from the v1.1 job plan format
      saveSettings({ jobPlan: { items: DEFAULT_ITEMS, govAdded: true, unloggedFrom: s.jobPlan?.unloggedFrom || "2026-07-01", spaPAs: deleteField(), roles: deleteField(), unlogged: deleteField() } });
    else if (snap.exists() && !snap.metadata.fromCache && s.jobPlan?.items && !s.jobPlan.items.governance && !s.jobPlan.govAdded) { // one-off: add governance lead (1 PA) to v1.2.0 plans
      const order = s.jobPlan.items.core?.order ?? 2;
      saveSettings({ jobPlan: { govAdded: true, items: { governance: { ...DEFAULT_ITEMS.governance, order: order - 0.5 } } } });
    }
    renderAll();
  }));
  state.unsub.push(onSnapshot(userCol("entries"), { includeMetadataChanges: true }, snap => {
    state.entries = new Map(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
    state.pending = snap.metadata.hasPendingWrites;
    state.fromCache = snap.metadata.fromCache;
    updateSyncPill();
    renderAll();
  }));
  state.unsub.push(onSnapshot(userCol("reports"), snap => {
    state.reports = new Map(snap.docs.map(d => [d.id, d.data()]));
    if (currentScreen() === "report") renderReport(false);
  }));
}
function stopListeners() { state.unsub.forEach(u => u()); state.unsub = []; }
function normaliseSettings(s) {
  return {
    geminiApiKey: s.geminiApiKey || "",
    geminiModel: s.geminiModel || DEFAULT_MODEL,
    appraisalDates: s.appraisalDates || {},
    jobPlan: { ...DEFAULT_JOBPLAN, ...(s.jobPlan || {}), items: s.jobPlan?.items || DEFAULT_ITEMS },
    tags: s.tags || Object.fromEntries(DEFAULT_TAGS.map(([id, name], i) => [id, { name, order: i }])),
    reportName: s.reportName || state.user?.displayName || "",
    evidenceBase: s.evidenceBase || "Appraisals COWLEY\\Appraisal 2027"
  };
}
async function seedSettings() {
  await setDoc(userDoc("config", "settings"), {
    tags: Object.fromEntries(DEFAULT_TAGS.map(([id, name], i) => [id, { name, order: i }])),
    jobPlan: DEFAULT_JOBPLAN,
    geminiModel: DEFAULT_MODEL
  }, { merge: true });
}
const saveSettings = patch => setDoc(userDoc("config", "settings"), patch, { merge: true });

function updateSyncPill() {
  const p = $("#sync-pill");
  p.className = "pill";
  if (!navigator.onLine) { p.textContent = "Offline · saved on device"; p.classList.add("offline"); }
  else if (state.pending) { p.textContent = "Syncing…"; p.classList.add("pending"); }
  else p.textContent = "Synced";
}
addEventListener("online", updateSyncPill);
addEventListener("offline", updateSyncPill);

// ───────────────────────────────────────────── 7. Navigation
function currentScreen() { return (location.hash.replace("#", "") || "home").split("/")[0]; }
function showScreen(name) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = true;
  const el = $("#screen-" + name) || $("#screen-home");
  el.hidden = false;
}
function renderAll() {
  if (!state.user || !state.settings) return;
  const s = currentScreen();
  showScreen(s);
  if (s === "home") renderHome();
  else if (s === "report") renderReport(true);
  else if (s === "settings") renderSettings();
}
addEventListener("hashchange", () => { if (!modalOpen) renderAll(); });
$("#nav-home").onclick = () => (location.hash = "home");
$("#nav-report").onclick = () => (location.hash = "report");
$("#nav-settings").onclick = () => (location.hash = "settings");

// Modal with Android back-button support
let modalOpen = false, modalOnClose = null;
function openModal(title, body, onClose) {
  $("#modal-title").textContent = title;
  $("#modal-body").replaceChildren(body);
  $("#modal").hidden = false;
  document.body.style.overflow = "hidden";
  if (!modalOpen) history.pushState({ modal: true }, "");
  modalOpen = true; modalOnClose = onClose || null;
  $("#modal").scrollTop = 0;
}
function hideModal() {
  $("#modal").hidden = true; document.body.style.overflow = "";
  modalOpen = false; const f = modalOnClose; modalOnClose = null; f && f();
}
function closeModal() { if (modalOpen) history.back(); }
addEventListener("popstate", () => { if (modalOpen) hideModal(); });
$("#modal-close").onclick = closeModal;

// ───────────────────────────────────────────── 8. Home
function periodOptions(sel, selected) {
  const ps = periods().slice().reverse();
  sel.replaceChildren(...ps.map(p => h("option", { value: p.key, selected: p.key === selected }, p.label)));
}
function renderHome() {
  if (!state.homePeriod || !periods().some(p => p.key === state.homePeriod)) state.homePeriod = currentPeriodKey();
  periodOptions($("#home-period"), state.homePeriod);
  const fc = $("#filter-code");
  if (fc.options.length === 1) fc.append(...CODES.map(c => h("option", { value: c.id }, `${c.id} ${c.label}`)));
  const ft = $("#filter-tag"), keepTag = ft.value;
  ft.replaceChildren(h("option", { value: "" }, "All roles"), h("option", { value: "__none" }, "No role tag"),
    ...allTags().map(t => h("option", { value: t.id }, t.name + (t.archived ? " (archived)" : ""))));
  ft.value = keepTag;

  const p = periodByKey(state.homePeriod);
  const st = periodStats(p);
  const top = Object.entries(st.byCode).filter(([c]) => !NON_SPA.has(c)).sort((a, b) => b[1].hours - a[1].hours).slice(0, 4);
  $("#home-summary").replaceChildren(
    h("div", { class: "stat" }, h("b", {}, st.list.length), "entries"),
    h("div", { class: "stat" }, h("b", {}, `${Math.round(st.spaHours)} h`), "SPA logged"),
    h("div", { class: "stat" }, h("b", {}, st.paw(st.spaHours).toFixed(2)), "SPA PAs/week"),
    ...top.map(([c, v]) => h("div", { class: "stat" }, h("b", {}, `${Math.round(v.hours)} h`), CODE_LABEL[c] || c))
  );
  renderList(p);
}
function renderList(p) {
  const q = $("#search").value.trim().toLowerCase();
  const code = $("#filter-code").value, tag = $("#filter-tag").value;
  let list = [...state.entries.values()].filter(e => inPeriod(e, p));
  if (code) list = list.filter(e => e.code === code);
  if (tag === "__none") list = list.filter(e => !tagsOf(e).length);
  else if (tag) list = list.filter(e => e.tags?.[tag]);
  if (q) list = list.filter(e => [e.title, e.text, e.reflection, ...tagsOf(e).map(tagName), CODE_LABEL[e.code]]
    .join(" ").toLowerCase().includes(q));
  list.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  const box = $("#entry-list"); box.replaceChildren();
  if (!list.length) {
    box.append(h("p", { class: "muted" }, state.entries.size ? "No entries match." :
      "No entries yet. Tap ✎ to record something, or import your diary history in Settings."));
    return;
  }
  let month = "";
  for (const e of list.slice(0, state.listLimit)) {
    const m = fmtDate(e.date, { month: "long", year: "numeric" });
    if (m !== month) { month = m; box.append(h("div", { class: "month" }, m)); }
    box.append(entryCard(e));
  }
  if (list.length > state.listLimit) box.append(h("div", { class: "more" },
    h("button", { onclick: () => { state.listLimit += PAGE; renderList(p); } }, `Show more (${list.length - state.listLimit})`)));
}
function entryCard(e) {
  return h("div", { class: "entry", onclick: () => openEntryEditor(e) },
    h("div", { class: "meta" },
      h("span", {}, fmtDate(e.date, { weekday: "short", day: "numeric", month: "short" })),
      e.hours ? h("span", {}, "· " + fmtHours(e.hours)) : null,
      h("span", { class: "badge" + (e.code === "CX" ? " cx" : ""), title: CODE_LABEL[e.code] }, e.code),
      ...tagsOf(e).map(t => h("span", { class: "tag" }, tagName(t))),
      Object.keys(e.evidence || {}).length ? h("span", { title: "Evidence linked" }, "📎") : null),
    h("div", { class: "title" }, e.title || "(untitled)"),
    e.text ? h("div", { class: "snippet" }, e.text) : null);
}
$("#home-period").onchange = ev => { state.homePeriod = ev.target.value; state.listLimit = PAGE; renderHome(); };
let searchTimer;
$("#search").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.listLimit = PAGE; renderList(periodByKey(state.homePeriod)); }, 150); };
$("#filter-code").onchange = $("#filter-tag").onchange = () => { state.listLimit = PAGE; renderList(periodByKey(state.homePeriod)); };
$("#fab").onclick = () => openCapture();

// ───────────────────────────────────────────── 9. Entry form (used by review and edit)
function entryForm(e, { review = false, newTagNames = [] } = {}) {
  const val = {
    include: true, date: e.date || todayISO(), hours: e.hours ?? "", code: e.code || "S7",
    tags: { ...(e.tags || {}) }, title: e.title || "", text: e.text || "", reflection: e.reflection || "",
    evidence: Object.entries(e.evidence || {}).map(([id, v]) => ({ id, ...v }))
  };
  const wrap = h("div", { class: "card" + (review ? " proposal" : "") });
  const flags = igFlags([val.title, val.text, val.reflection].join(" "));

  const includeBox = h("input", { type: "checkbox", checked: true,
    onchange: ev => { val.include = ev.target.checked; wrap.classList.toggle("off", !val.include); } });
  const date = h("input", { type: "date", value: val.date });
  const hours = h("input", { type: "number", step: "0.25", min: "0", value: val.hours, placeholder: "e.g. 1.5" });
  const code = h("select", {}, ...CODES.map(c => h("option", { value: c.id, selected: c.id === val.code }, `${c.id} ${c.label}`)));
  const title = h("input", { value: val.title, placeholder: "Short title" });
  const text = h("textarea", { placeholder: "What you did, who with, outcome" }, val.text);
  const refl = h("textarea", { placeholder: "Reflection / learning (optional)" }, val.reflection);
  refl.style.minHeight = "3.5rem";

  const chips = h("div", { class: "chips" });
  const drawChips = () => {
    const shown = new Set([...activeTags().map(t => t.id), ...Object.keys(val.tags)]);
    chips.replaceChildren(...[...shown].map(id => h("button", { type: "button", class: "chip" + (val.tags[id] ? " on" : ""),
      onclick: () => { if (val.tags[id]) delete val.tags[id]; else val.tags[id] = true; drawChips(); } }, tagName(id))));
    for (const name of newTagNames) {
      chips.append(h("button", { type: "button", class: "chip", title: "Suggested new tag",
        onclick: async () => {
          const id = slug(name);
          await saveSettings({ tags: { [id]: { name, order: 50 } } });
          state.settings.tags[id] = { name, order: 50 };
          newTagNames = newTagNames.filter(n => n !== name);
          val.tags[id] = true; drawChips();
        } }, "+ " + name));
    }
  };
  drawChips();

  const evBox = h("div");
  const drawEvidence = () => {
    evBox.replaceChildren(...val.evidence.map((ev, i) => h("div", { class: "evidence-row" },
      h("input", { value: ev.label || "", placeholder: "Label", oninput: x => (val.evidence[i].label = x.target.value) }),
      h("input", { value: ev.path || "", placeholder: "OneDrive path or link", oninput: x => (val.evidence[i].path = x.target.value) }),
      /^https?:\/\//.test(ev.path || "") ? h("a", { href: ev.path, target: "_blank", rel: "noopener", class: "iconbtn" }, "↗") : null,
      h("button", { type: "button", class: "iconbtn", title: "Remove", onclick: () => { val.evidence.splice(i, 1); drawEvidence(); } }, "✕"))),
      h("button", { type: "button", onclick: () => { val.evidence.push({ id: uid(), label: "", path: (state.settings.evidenceBase || "") + "\\" }); drawEvidence(); } }, "+ Evidence link"));
  };
  drawEvidence();

  wrap.append(...[
    review ? h("label", { class: "include" }, includeBox, "Include this entry") : null,
    flags.length ? h("div", { class: "ig-warning" }, "Check for patient-identifiable information: " + flags.join(", ") + ".") : null,
    h("div", { class: "row" }, h("label", {}, "Date", date), h("label", {}, "Hours (approx.)", hours)),
    h("label", {}, "Activity code", code),
    h("label", {}, "Role / project"), chips,
    h("label", {}, "Title", title),
    h("label", {}, "Detail", text),
    h("label", {}, "Reflection", refl),
    h("label", {}, "Evidence"), evBox,
    e.importRef ? h("p", { class: "muted small" }, "Imported from " + e.importRef + (e.origCode ? ` (code ${e.origCode})` : "")) : null
  ].filter(Boolean));
  wrap.getValue = () => ({
    include: val.include,
    date: date.value || todayISO(),
    hours: hours.value === "" ? null : round2(+hours.value),
    code: code.value,
    tags: Object.fromEntries(Object.keys(val.tags).filter(k => val.tags[k]).map(k => [k, true])),
    title: title.value.trim(),
    text: text.value.trim(),
    reflection: refl.value.trim(),
    evidence: Object.fromEntries(val.evidence.filter(x => (x.path || "").trim() && x.path.trim() !== (state.settings.evidenceBase || "") + "\\")
      .map(x => [x.id || uid(), { label: (x.label || "").trim(), path: x.path.trim() }]))
  });
  return wrap;
}
function entryData(v, existing = {}) {
  const { include, ...rest } = v;
  const data = { ...existing, ...rest, updatedAt: serverTimestamp() };
  delete data.id;
  if (!existing.createdAt) data.createdAt = serverTimestamp();
  if (!data.source) data.source = "app";
  return data;
}
function openEntryEditor(e) {
  const form = entryForm(e);
  const body = h("div", {}, form, h("div", { class: "actions" },
    h("button", { class: "danger", onclick: async () => {
      if (!confirm("Delete this entry?")) return;
      deleteDoc(userDoc("entries", e.id)); closeModal(); toast("Deleted");
    } }, "Delete"),
    h("button", { class: "primary", onclick: () => {
      const v = form.getValue();
      setDoc(userDoc("entries", e.id), entryData(v, e)); closeModal(); toast("Saved");
    } }, "Save")));
  openModal("Edit entry", body);
}

// ───────────────────────────────────────────── 10. Capture → Gemini → review
function openCapture() {
  const ta = h("textarea", { placeholder: "Dictate or type what you did — e.g. \"This morning 2 hours on the ICCA handover sheet with Digital, then an hour on two complaint responses for governance.\"" },
    localStorage.getItem(DRAFT_KEY) || "");
  ta.style.minHeight = "11rem";
  ta.oninput = () => localStorage.setItem(DRAFT_KEY, ta.value);
  const status = h("p", { class: "muted small" }, "Don't include anything patient-identifiable — the text is sent to Gemini.");
  const aiBtn = h("button", { class: "primary", onclick: async () => {
    const txt = ta.value.trim(); if (!txt) return;
    const flags = igFlags(txt);
    if (flags.length && !confirm(`This text may contain ${flags.join(", ")}.\n\nSend to Gemini anyway?`)) return;
    aiBtn.disabled = true; status.replaceChildren(h("span", { class: "spinner" }), " Asking Gemini…");
    try {
      const res = await proposeEntries(txt);
      showReview(res, txt);
    } catch (err) { status.textContent = "Gemini error: " + err.message; status.className = "error"; aiBtn.disabled = false; }
  } }, "Suggest entries");
  const manual = h("button", { onclick: () => showReview({ entries: [{ date: todayISO(), title: "", description: ta.value.trim(), code: "S7" }] }, ta.value) }, "Enter manually");
  const clear = h("button", { onclick: () => { ta.value = ""; localStorage.removeItem(DRAFT_KEY); ta.focus(); } }, "Clear");
  openModal("New entry", h("div", {}, ta, status, h("div", { class: "actions" }, clear, manual, aiBtn)));
  setTimeout(() => ta.focus(), 50);
}
function showReview(res, source) {
  const known = new Set(Object.keys(state.settings.tags));
  const forms = (res.entries || []).map(p => entryForm({
    date: p.date, hours: p.hours, code: CODE_LABEL[p.code] ? p.code : "S7",
    tags: Object.fromEntries((p.tags || []).filter(t => known.has(t)).map(t => [t, true])),
    title: p.title, text: p.description, reflection: p.reflection,
    evidence: Object.fromEntries((p.evidence || []).filter(x => x.path).map(x => [uid(), x]))
  }, { review: true, newTagNames: (res.newTags || []).map(t => t.name || t).filter(Boolean) }));
  if (!forms.length) forms.push(entryForm({ text: source }, { review: true }));
  const body = h("div", {},
    res.notes ? h("p", { class: "muted small" }, res.notes) : null,
    ...forms,
    h("div", { class: "actions" },
      h("button", { onclick: () => openCapture() }, "Back"),
      h("button", { class: "primary", onclick: async () => {
        const vals = forms.map(f => f.getValue()).filter(v => v.include);
        if (!vals.length) return toast("Nothing ticked");
        await batchWrite(vals.map(v => ({ ref: userDoc("entries", uid()), data: entryData(v) })))
          .catch(err => toast("Save failed: " + err.message));
        localStorage.removeItem(DRAFT_KEY);
        closeModal(); toast(`Saved ${vals.length} entr${vals.length === 1 ? "y" : "ies"}`);
      } }, "Save")));
  openModal("Review", body);
}

// ───────────────────────────────────────────── 11. Gemini
async function gemini(prompt, { json = true, temperature = 0.2 } = {}) {
  const key = state.settings.geminiApiKey;
  if (!key) throw new Error("add your Gemini API key in Settings");
  const model = state.settings.geminiModel || DEFAULT_MODEL;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature, ...(json ? { responseMimeType: "application/json" } : {}) }
    })
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const txt = data.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  if (!json) return txt;
  try { return JSON.parse(txt); }
  catch { const m = txt.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error("couldn't read Gemini's reply"); }
}
async function proposeEntries(note) {
  const t = new Date();
  const recent = [...state.entries.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15)
    .map(e => ({ date: e.date, code: e.code, tags: tagsOf(e), title: e.title }));
  const prompt = `You turn a consultant anaesthetist's dictated note about his non-clinical work into structured diary entries for NHS appraisal (Allocate) and job planning.
Today is ${todayISO()} (${t.toLocaleDateString("en-GB", { weekday: "long" })}).

Activity codes (BMA job-planning diary):
${CODES.map(c => `${c.id}: ${c.label}`).join("\n")}
Use CX only for clinical work or extra paid sessions.

Role / project tags (use the ids; several allowed, or none):
${activeTags().map(x => `${x.id}: ${x.name}`).join("\n")}

Recent entries, for matching terminology:
${JSON.stringify(recent)}

Return JSON only, in this shape:
{"entries":[{"date":"YYYY-MM-DD","hours":number or null,"code":"S4","tags":["gov"],"title":"short title, max 80 characters","description":"tidied detail in Nick's own terms","reflection":"","evidence":[{"label":"","path":""}]}],"newTags":[{"name":""}],"notes":""}

Rules:
- Make one entry per distinct activity; resolve relative dates ("yesterday", "on Tuesday") against today.
- hours = time Nick spent. Use stated times; "morning" or "afternoon" = 3.5, "a couple of hours" = 2, "quick" = 0.5. Otherwise null.
- Do not invent facts, outcomes or people. Use British English.
- Remove anything patient-identifiable (patient names, NHS or hospital numbers, dates of birth, bed numbers). Never include mental-health detail.
- reflection only if Nick expressed learning or reflection; otherwise "".
- evidence only if he mentions a document, file or link; otherwise [].
- newTags only if an activity clearly belongs to an ongoing role or project not in the list.
- notes: one short sentence if anything was ambiguous, else "".

Note:
"""${note}"""`;
  return gemini(prompt);
}

// ───────────────────────────────────────────── 12. Report
function sectionsFor(st) {
  const out = [];
  for (const t of allTags()) if (st.byTag[t.id]) out.push({ key: "tag:" + t.id, name: t.name, list: st.byTag[t.id].list });
  for (const c of CODES) if (st.byCode[c.id]) out.push({ key: "code:" + c.id, name: `${c.id} ${c.label}`, list: st.byCode[c.id].list });
  return out;
}
function jobItems() {
  return Object.entries(state.settings?.jobPlan?.items || {}).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}
function itemOf(e, items) {
  if (NON_SPA.has(e.code)) return null;
  const text = `${e.title || ""} ${e.text || ""}`.toLowerCase();
  const tg = tagsOf(e);
  for (const it of items) {
    const kws = String(it.keywords || "").split(/[;,]/).map(k => k.trim().toLowerCase()).filter(Boolean);
    if (kws.some(k => text.includes(k))) return it.id;
    if (tg.some(t => it.tags?.[t])) return it.id;
  }
  if (!tg.length) { const core = items.find(i => i.core); if (core) return core.id; }
  return "_none";
}
// Unlogged time: hours/week the user estimates go on a job plan item without being itemised.
function unloggedHpw(itemId) { const v = state.settings?.jobPlan?.items?.[itemId]?.unlogged; return v == null || v === "" ? 0 : +v; }
function unloggedTotalHpw() { return jobItems().reduce((a, i) => a + unloggedHpw(i.id), 0); }
const COVERAGE_NOTE = "This is a log of specific roles and blocks of protected time, not a full timesheet. Email, ad-hoc queries, reading and short unscheduled tasks are mostly not itemised, so logged hours are a minimum.";

function planRows(st) {
  const f = x => x.toFixed(2);
  const rows = jobItems().map(it => {
    const v = st.byItem[it.id] || { n: 0, hours: 0 };
    const est = unloggedHpw(it.id) && st.unl.weeks ? st.unl.keyPaw(it.id) : 0;
    return { name: it.name, planned: it.pas == null || it.pas === "" ? "–" : f(+it.pas), n: v.n, hours: v.hours.toFixed(1),
      paw: f(st.paw(v.hours)), est: est ? f(est) : "–", total: f(st.paw(v.hours) + est) };
  });
  const none = st.byItem._none;
  if (none) rows.push({ name: "Not in job plan", planned: "–", n: none.n, hours: none.hours.toFixed(1),
    paw: f(st.paw(none.hours)), est: "–", total: f(st.paw(none.hours)) });
  const planned = jobItems().reduce((a, i) => a + (+i.pas || 0), 0);
  rows.push({ name: "Total non-clinical", planned: f(planned), n: st.list.filter(e => !NON_SPA.has(e.code)).length, hours: st.spaHours.toFixed(1),
    paw: f(st.paw(st.spaHours)), est: st.unl.paw ? f(st.unl.paw) : "–", total: f(st.paw(st.spaHours) + st.unl.paw), bold: true });
  return rows;
}
function tagRows(st) {
  return allTags().filter(t => st.byTag[t.id]).map(t => ({ name: t.name, n: st.byTag[t.id].n,
    hours: st.byTag[t.id].hours.toFixed(1), paw: st.paw(st.byTag[t.id].hours).toFixed(2) }));
}
function renderReport(resetSel) {
  if (!state.reportPeriod || !periods().some(p => p.key === state.reportPeriod)) state.reportPeriod = currentPeriodKey();
  periodOptions($("#report-period"), state.reportPeriod);
  const p = periodByKey(state.reportPeriod);
  const st = periodStats(p);
  const jp = state.settings.jobPlan;
  const body = $("#report-body"); body.replaceChildren();
  const unl = st.unl.hours > 0 ? st.unl.hpw : 0;
  body.append(h("p", { class: "muted small" },
    `${p.label}. ${st.list.length} entries · ${Math.round(st.spaHours)} h SPA logged · ${st.weeks.toFixed(1)} working weeks (${jp.weeksPerYear}/52). Hours are approximate; 4 hours = 1 PA.`),
    h("div", { class: "ig-warning", style: "background:var(--panel);border-color:var(--line);color:var(--text)" }, COVERAGE_NOTE,
      unl ? ` An estimate of ${unl} h/week of unlogged time from ${fmtDate(st.unl.from)} is shown separately (set in Settings → Job plan).` : " You can add an estimate of unlogged time per role in Settings → Job plan."));

  // By code
  const maxH = Math.max(1, ...Object.values(st.byCode).map(v => v.hours));
  body.append(h("div", { class: "card" }, h("h3", {}, "By activity code"), h("div", { class: "tablewrap" }, h("table", {},
    h("tr", {}, h("th", {}, "Code"), h("th", { class: "num" }, "Entries"), h("th", { class: "num" }, "Hours"), h("th", { class: "num" }, "PAs/wk")),
    ...CODES.filter(c => st.byCode[c.id]).map(c => {
      const v = st.byCode[c.id];
      return h("tr", {}, h("td", {}, `${c.id} ${c.label}`, h("div", { class: "bar", style: `width:${Math.round(v.hours / maxH * 100)}%` })),
        h("td", { class: "num" }, v.n), h("td", { class: "num" }, v.hours.toFixed(1)), h("td", { class: "num" }, st.paw(v.hours).toFixed(2)));
    }),
    h("tr", {}, h("th", {}, "Total SPA logged (excl. CX)"), h("th", {}), h("th", { class: "num" }, st.spaHours.toFixed(1)), h("th", { class: "num" }, st.paw(st.spaHours).toFixed(2))),
    unl ? h("tr", {}, h("td", {}, "Unlogged time, estimate (email, ad-hoc and role work not itemised)"), h("td", {}), h("td", { class: "num" }, st.unl.hours.toFixed(0)), h("td", { class: "num" }, st.unl.paw.toFixed(2))) : null,
    unl ? h("tr", {}, h("th", {}, "Total SPA including estimate"), h("th", {}), h("th", { class: "num" }, (st.spaHours + st.unl.hours).toFixed(0)), h("th", { class: "num" }, (st.paw(st.spaHours) + st.unl.paw).toFixed(2))) : null))));

  // Against job plan (each entry counted once)
  const pr = planRows(st);
  const cell = (r, v) => h(r.bold ? "th" : "td", { class: "num" }, v);
  body.append(h("div", { class: "card" }, h("h3", {}, "Against job plan"), h("div", { class: "tablewrap" }, h("table", {},
    h("tr", {}, h("th", {}, "Job plan item"), h("th", { class: "num" }, "Planned PAs/wk"), h("th", { class: "num" }, "Entries"), h("th", { class: "num" }, "Logged h"),
      h("th", { class: "num" }, "Logged PAs/wk"), unl ? h("th", { class: "num" }, "+ Unlogged est.") : null, unl ? h("th", { class: "num" }, "Total") : null),
    ...pr.map(r => h("tr", {}, r.bold ? h("th", {}, r.name) : h("td", {}, r.name), cell(r, r.planned), cell(r, r.n), cell(r, r.hours), cell(r, r.paw),
      unl ? cell(r, r.est) : null, unl ? cell(r, r.total) : null)))),
    h("p", { class: "muted small" }, `Job plan ${jp.totalPAs} PAs/week. Each entry counts once, towards the first item it matches (by keyword, then role tag); untagged entries count as core. Logged time is a minimum.`)));

  // By role tag
  body.append(h("div", { class: "card" }, h("h3", {}, "By role / project"), h("div", { class: "tablewrap" }, h("table", {},
    h("tr", {}, h("th", {}, "Role / project"), h("th", { class: "num" }, "Entries"), h("th", { class: "num" }, "Logged h"), h("th", { class: "num" }, "Logged PAs/wk")),
    ...tagRows(st).map(r => h("tr", {}, h("td", {}, r.name), h("td", { class: "num" }, r.n), h("td", { class: "num" }, r.hours), h("td", { class: "num" }, r.paw))))),
    h("p", { class: "muted small" }, "An entry with several tags counts towards each, so these don't add up to the total.")));

  // Year on year
  body.append(yoyCard());

  // AI summaries
  const rep = state.reports.get(p.key) || {};
  const secs = sectionsFor(st);
  const genBtn = h("button", { class: "primary", onclick: async () => {
    const flagged = st.list.filter(e => igFlags([e.title, e.text, e.reflection].join(" ")).length);
    if (flagged.length && !confirm(`${flagged.length} entries in this year contain something that may be patient-identifiable (shown with a warning when you open them). Send to Gemini anyway?`)) return;
    genBtn.disabled = true; genBtn.replaceChildren(h("span", { class: "spinner" }), " Drafting…");
    try {
      const res = await draftSummaries(p, secs);
      const sections = {};
      for (const s of secs) if (res.sections?.[s.key]) sections[s.key] = res.sections[s.key];
      await setDoc(userDoc("reports", p.key), { sections, generatedAt: serverTimestamp() }, { merge: true });
      toast("Summaries drafted — edit them before exporting");
    } catch (err) { toast("Gemini error: " + err.message, 5000); }
    genBtn.disabled = false; genBtn.textContent = "Redraft with AI";
  } }, Object.keys(rep.sections || {}).length ? "Redraft with AI" : "Draft summaries with AI");
  const sumCard = h("div", { class: "card" }, h("h3", {}, "Section summaries"),
    h("p", { class: "muted small" }, "Drafted from this year's entries for you to edit. These go into the PDF, and you can copy each one into Allocate."), genBtn);
  for (const s of secs) {
    const ta = h("textarea", {}, rep.sections?.[s.key] || "");
    ta.onchange = () => setDoc(userDoc("reports", p.key), { sections: { [s.key]: ta.value } }, { merge: true });
    sumCard.append(h("div", { class: "section-summary" },
      h("label", {}, `${s.name} (${s.list.length})`, ta),
      h("div", { class: "actions" }, h("button", { onclick: () => navigator.clipboard.writeText(ta.value).then(() => toast("Copied")) }, "Copy"))));
  }
  body.append(sumCard);

  // Entries by code
  const ent = h("div", { class: "card" }, h("h3", {}, "Entries by code"));
  for (const c of CODES) {
    const v = st.byCode[c.id]; if (!v) continue;
    ent.append(h("details", {}, h("summary", {}, `${c.id} ${c.label} — ${v.n} entries, ${v.hours.toFixed(1)} h`),
      ...v.list.sort((a, b) => a.date.localeCompare(b.date)).map(entryCard)));
  }
  body.append(ent);
}
function yoyRows() {
  const ps = periods().slice(-7);
  const stats = ps.map(p => periodStats(p));
  const codeRows = CODES.filter(c => stats.some(s => s.byCode[c.id])).map(c => ({ name: `${c.id} ${c.label}`, vals: stats.map(s => s.byCode[c.id] ? s.paw(s.byCode[c.id].hours) : 0) }));
  codeRows.push({ name: "Total SPA logged", vals: stats.map(s => s.paw(s.spaHours)), bold: true });
  const tagRows = allTags().filter(t => stats.some(s => s.byTag[t.id])).map(t => ({ name: t.name, vals: stats.map(s => s.byTag[t.id] ? s.paw(s.byTag[t.id].hours) : 0) }));
  return { ps, codeRows, tagRows };
}
function yoyCard() {
  const { ps, codeRows, tagRows: yoyTagRows } = yoyRows();
  const tbl = rows => h("div", { class: "tablewrap" }, h("table", {},
    h("tr", {}, h("th", {}, ""), ...ps.map(p => h("th", { class: "num" }, p.short))),
    ...rows.map(r => h("tr", {}, (r.bold ? h("th", {}, r.name) : h("td", {}, r.name)),
      ...r.vals.map(v => h(r.bold ? "th" : "td", { class: "num" }, v ? v.toFixed(2) : "–"))))));
  return h("div", { class: "card" }, h("h3", {}, "Year on year (PAs per week)"),
    h("p", { class: "muted small" }, "Columns are appraisal years, labelled by the appraisal they led up to. Logged time only, so these are minimums; how much was logged varies between years (the weekly diary was kept in full until mid-2026)."),
    tbl(codeRows), h("h3", { style: "margin-top:1rem" }, "By role"), tbl(yoyTagRows));
}
async function draftSummaries(p, secs) {
  const payload = secs.map(s => ({
    key: s.key, section: s.name,
    entries: s.list.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(0, 250).map(e => ({
      date: e.date, hours: e.hours, title: e.title, detail: (e.text || "").slice(0, 300), reflection: (e.reflection || "").slice(0, 300),
      tags: tagsOf(e).map(tagName)
    }))
  }));
  const prompt = `You are helping an NHS consultant anaesthetist (Nick) prepare supporting information for his annual appraisal on Allocate.
Below are his diary entries for the appraisal year ${p.label}, grouped into sections (role/project tags and BMA job-planning activity codes; one entry can appear in several sections).

The entries are a log of specific roles and blocks of protected time, not a full timesheet: email, ad-hoc queries and short unscheduled tasks are mostly not recorded. So never present logged hours as his total time on a role; if time is worth mentioning, describe regular commitments (for example "monthly governance meetings") or say "at least".

For each section write a draft summary in the first person, in British English, of 80–180 words: what he did, the main themes and responsibilities of each role, notable meetings, casework, projects or outputs. Mention reflection or learning only where the entries record it. Do not invent outcomes, numbers, people or achievements. Never include patient-identifiable information or mental-health detail. Plain prose, no headings or bullet points.

Return JSON only: {"sections":{"<key>":"<summary>"}} using exactly the keys given.

${JSON.stringify(payload)}`;
  return gemini(prompt, { temperature: 0.3 });
}

// PDF (jsPDF + autotable loaded on demand)
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = h("script", { src }); s.onload = res; s.onerror = () => rej(new Error("couldn't load " + src)); document.head.append(s);
  });
}
async function makePDF() {
  const btn = $("#btn-pdf"); btn.disabled = true; btn.textContent = "Building…";
  try {
    await loadScript("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js");
    await loadScript("https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js");
    const { jsPDF } = window.jspdf;
    const p = periodByKey(state.reportPeriod), st = periodStats(p), jp = state.settings.jobPlan;
    const rep = state.reports.get(p.key) || {};
    const pdf = new jsPDF({ unit: "mm", format: "a4" });
    const W = 210, M = 16; let y = 20;
    const teal = [47, 127, 120];
    const head = { fillColor: teal, textColor: 255, fontStyle: "bold" };
    const ensure = need => { if (y + need > 280) { pdf.addPage(); y = 20; } };
    const heading = (t, size = 13) => { ensure(14); pdf.setFont("helvetica", "bold"); pdf.setFontSize(size); pdf.setTextColor(30); pdf.text(t, M, y); y += size * 0.5 + 2; };
    const para = (t, size = 10) => {
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(size); pdf.setTextColor(40);
      for (const line of pdf.splitTextToSize(t, W - 2 * M)) { ensure(5); pdf.text(line, M, y); y += size * 0.45; }
      y += 2;
    };
    const table = (opts) => { pdf.autoTable({ startY: y, margin: { left: M, right: M }, styles: { fontSize: 8.5, cellPadding: 1.6 }, headStyles: head, ...opts }); y = pdf.lastAutoTable.finalY + 6; };

    pdf.setFont("helvetica", "bold"); pdf.setFontSize(18); pdf.setTextColor(20);
    pdf.text("Non-clinical activity record", M, y); y += 8;
    pdf.setFontSize(11); pdf.setFont("helvetica", "normal");
    pdf.text(state.settings.reportName || state.user.displayName || "", M, y); y += 6;
    const unl = st.unl.hours > 0 ? st.unl.hpw : 0;
    para(`${p.label}. Generated ${fmtDate(todayISO())}. ${st.list.length} entries logged contemporaneously; hours are approximate (4 hours = 1 PA; ${jp.weeksPerYear} working weeks per year). Job plan ${jp.totalPAs} PAs per week.`, 9.5);
    para(COVERAGE_NOTE + (unl ? ` My estimate of unlogged time (${unl} hours per week from ${fmtDate(st.unl.from)}) is shown separately and is not itemised.` : ""), 9.5);

    heading("Summary by activity code");
    table({ head: [["Code", "Activity", "Entries", "Hours", "PAs/wk"]],
      body: [...CODES.filter(c => st.byCode[c.id]).map(c => [c.id, c.label, st.byCode[c.id].n, st.byCode[c.id].hours.toFixed(1), st.paw(st.byCode[c.id].hours).toFixed(2)]),
        ["", "Total SPA logged (excluding clinical / extra)", "", st.spaHours.toFixed(1), st.paw(st.spaHours).toFixed(2)],
        ...(unl ? [["", "Unlogged time, estimate (email, ad-hoc and role work not itemised)", "", st.unl.hours.toFixed(0), st.unl.paw.toFixed(2)],
          ["", "Total SPA including estimate", "", (st.spaHours + st.unl.hours).toFixed(0), (st.paw(st.spaHours) + st.unl.paw).toFixed(2)]] : [])],
      columnStyles: { 2: { halign: "right" }, 3: { halign: "right" }, 4: { halign: "right" } } });

    heading("Against job plan");
    const rightCols = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, { halign: "right" }]));
    table({ head: [["Job plan item", "Planned PAs/wk", "Entries", "Logged h", "Logged PAs/wk", ...(unl ? ["+ Unlogged est.", "Total"] : [])]],
      body: planRows(st).map(r => [r.name, r.planned, r.n, r.hours, r.paw, ...(unl ? [r.est, r.total] : [])]),
      columnStyles: rightCols(unl ? 6 : 4),
      didParseCell: d => { if (d.section === "body" && d.row.index === planRows(st).length - 1) d.cell.styles.fontStyle = "bold"; } });
    para("Each entry counts once, towards the first job plan item it matches; untagged entries count as core SPA.", 8.5);
    heading("By role / project");
    table({ head: [["Role / project", "Entries", "Logged h", "Logged PAs/wk"]],
      body: tagRows(st).map(r => [r.name, r.n, r.hours, r.paw]), columnStyles: rightCols(3) });

    const { ps, codeRows, tagRows: yoyTagRows } = yoyRows();
    heading("Year on year (logged PAs per week)");
    const yoyBody = rows => rows.map(r => [r.name, ...r.vals.map(v => v ? v.toFixed(2) : "–")]);
    const right = Object.fromEntries(ps.map((_, i) => [i + 1, { halign: "right" }]));
    table({ head: [["Activity code", ...ps.map(x => x.short)]], body: yoyBody(codeRows), columnStyles: right });
    table({ head: [["Role / project", ...ps.map(x => x.short)]], body: yoyBody(yoyTagRows), columnStyles: right });

    const secs = sectionsFor(st).filter(s => (rep.sections?.[s.key] || "").trim());
    if (secs.length) {
      pdf.addPage(); y = 20; heading("Summaries", 15);
      for (const s of secs) { heading(s.name, 11.5); para(rep.sections[s.key].trim()); }
    }

    pdf.addPage(); y = 20; heading("Entries by activity code", 15);
    for (const c of CODES) {
      const v = st.byCode[c.id]; if (!v) continue;
      heading(`${c.id} ${c.label} (${v.n} entries, ${v.hours.toFixed(1)} h)`, 11);
      table({ head: [["Date", "Hours", "Activity", "Role / project"]],
        body: v.list.slice().sort((a, b) => a.date.localeCompare(b.date)).map(e => [
          fmtDate(e.date), e.hours ?? "", [e.title, e.text, e.reflection ? "Reflection: " + e.reflection : "",
            ...Object.values(e.evidence || {}).map(x => "Evidence: " + (x.label ? x.label + " — " : "") + x.path)].filter(Boolean).join("\n"),
          tagsOf(e).map(tagName).join(", ")]),
        columnStyles: { 0: { cellWidth: 24 }, 1: { cellWidth: 13, halign: "right" }, 3: { cellWidth: 38 } } });
    }

    const n = pdf.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      pdf.setPage(i); pdf.setFontSize(8); pdf.setTextColor(120);
      pdf.text(`${state.settings.reportName || ""} · Non-clinical activity record · ${p.short}`, M, 290);
      pdf.text(`Page ${i} of ${n}`, W - M, 290, { align: "right" });
    }
    pdf.save(`Non-clinical activity record ${p.short}.pdf`);
  } catch (err) { toast("PDF failed: " + err.message, 5000); }
  btn.disabled = false; btn.textContent = "Download PDF";
}
$("#report-period").onchange = ev => { state.reportPeriod = ev.target.value; renderReport(false); };
$("#btn-pdf").onclick = makePDF;

// ───────────────────────────────────────────── 13. Settings
function renderSettings() {
  const s = state.settings;
  // appraisal dates
  const dates = Object.entries(s.appraisalDates).sort((a, b) => a[1].date.localeCompare(b[1].date));
  $("#appraisal-dates").replaceChildren(...(dates.length ? dates.map(([id, d]) => h("div", { class: "list-item" },
    h("span", {}, fmtDate(d.date, { weekday: "short", day: "numeric", month: "long", year: "numeric" }) + (d.date > todayISO() ? " (booked)" : "")),
    h("button", { class: "iconbtn", title: "Remove", onclick: () => { if (confirm("Remove this appraisal date?")) saveSettings({ appraisalDates: { [id]: deleteField() } }); } }, "✕")))
    : [h("p", { class: "muted small" }, "No dates yet.")]));
  // job plan
  $("#jp-total").value = s.jobPlan.totalPAs; $("#jp-weeks").value = s.jobPlan.weeksPerYear;
  $("#jp-unlogged-from").value = s.jobPlan.unloggedFrom || "2026-07-01";
  if (!jpDraft || !jpDirty) jpDraft = JSON.parse(JSON.stringify(s.jobPlan.items || {}));
  drawJobItems();
  // tags
  $("#tag-list").replaceChildren(...allTags().map(t => {
    const inp = h("input", { value: t.name, onchange: ev => saveSettings({ tags: { [t.id]: { name: ev.target.value.trim() || t.name } } }) });
    const count = [...state.entries.values()].filter(e => e.tags?.[t.id]).length;
    return h("div", { class: "list-item" }, inp, h("span", { class: "muted small", style: "flex:0 0 auto" }, count),
      h("button", { onclick: () => saveSettings({ tags: { [t.id]: { archived: !t.archived } } }) }, t.archived ? "Restore" : "Archive"));
  }));
  $("#report-name").value = s.reportName; $("#evidence-base").value = s.evidenceBase;
  $("#gemini-key").value = s.geminiApiKey; $("#gemini-model").value = s.geminiModel;
  $("#signed-in-as").textContent = `Signed in as ${state.user.email}`;
  $("#version").textContent = `Appraisal Log v${APP_VERSION}`;
}
$("#btn-add-appraisal").onclick = () => {
  const d = $("#new-appraisal-date").value; if (!d) return;
  if (appraisalDates().includes(d)) return toast("Already added");
  saveSettings({ appraisalDates: { [uid()]: { date: d } } }); $("#new-appraisal-date").value = ""; toast("Added");
};
let jpDraft = null, jpDirty = false;
function drawJobItems() {
  const items = Object.entries(jpDraft).sort((a, b) => (a[1].order ?? 99) - (b[1].order ?? 99));
  const num = (v, step, on) => h("input", { type: "number", step, min: "0", value: v ?? "", oninput: ev => { on(ev.target.value === "" ? null : +ev.target.value); jpDirty = true; } });
  $("#jp-items").replaceChildren(...items.map(([id, it], idx) => {
    const chips = h("div", { class: "chips" }, ...activeTags().map(t => h("button", { type: "button", class: "chip" + (it.tags?.[t.id] ? " on" : ""),
      onclick: () => { it.tags ||= {}; if (it.tags[t.id]) delete it.tags[t.id]; else it.tags[t.id] = true; jpDirty = true; drawJobItems(); } }, t.name)));
    return h("div", { class: "card", style: "background:var(--panel-2)" },
      h("label", {}, "Item", h("input", { value: it.name || "", oninput: ev => { it.name = ev.target.value; jpDirty = true; } })),
      h("div", { class: "row" }, h("label", {}, "Planned PAs/wk", num(it.pas, "0.0001", v => (it.pas = v))),
        h("label", {}, "Unlogged h/wk (estimate)", num(it.unlogged, "0.5", v => (it.unlogged = v)))),
      h("label", {}, "Counts entries tagged"), chips,
      h("label", {}, "…or whose title contains (separate with ;)", h("input", { value: it.keywords || "", placeholder: "e.g. ICU forum", oninput: ev => { it.keywords = ev.target.value; jpDirty = true; } })),
      h("label", { class: "include" }, h("input", { type: "checkbox", checked: !!it.core, onchange: ev => {
        for (const x of Object.values(jpDraft)) x.core = false; it.core = ev.target.checked; jpDirty = true; drawJobItems(); } }),
        "Core SPA: also counts untagged entries"),
      h("div", { class: "actions" },
        idx > 0 ? h("button", { onclick: () => { items.forEach(([, x], i) => (x.order = i)); items[idx - 1][1].order = idx; it.order = idx - 1; jpDirty = true; drawJobItems(); } }, "Move up") : null,
        h("button", { class: "danger", onclick: () => { delete jpDraft[id]; jpDirty = true; drawJobItems(); } }, "Remove")));
  }));
}
$("#btn-add-jp-item").onclick = () => {
  jpDraft[uid().slice(0, 8)] = { name: "New item", pas: null, unlogged: null, tags: {}, keywords: "", core: false, order: Object.keys(jpDraft).length };
  jpDirty = true; drawJobItems();
};
$("#btn-save-jp").onclick = async () => {
  Object.entries(jpDraft).sort((a, b) => (a[1].order ?? 99) - (b[1].order ?? 99)).forEach(([, x], i) => (x.order = i));
  const items = { ...jpDraft };
  for (const id of Object.keys(state.settings.jobPlan.items || {})) if (!items[id]) items[id] = deleteField();
  // replace each item whole so removed tags don't linger in the merge
  for (const id of Object.keys(jpDraft)) await saveSettings({ jobPlan: { items: { [id]: deleteField() } } });
  await saveSettings({ jobPlan: { totalPAs: +$("#jp-total").value || 0, weeksPerYear: +$("#jp-weeks").value || 42, items, unloggedFrom: $("#jp-unlogged-from").value || "2026-07-01" } });
  jpDirty = false; toast("Job plan saved");
};
$("#btn-add-tag").onclick = () => {
  const name = $("#new-tag").value.trim(); if (!name) return;
  let id = slug(name); if (state.settings.tags[id]) id += "-" + uid().slice(0, 4);
  saveSettings({ tags: { [id]: { name, order: Object.keys(state.settings.tags).length } } }); $("#new-tag").value = "";
};
$("#btn-save-report-settings").onclick = () => { saveSettings({ reportName: $("#report-name").value.trim(), evidenceBase: $("#evidence-base").value.trim() }); toast("Saved"); };
$("#btn-save-gemini").onclick = () => { saveSettings({ geminiApiKey: $("#gemini-key").value.trim(), geminiModel: $("#gemini-model").value.trim() || DEFAULT_MODEL }); toast("Saved"); };

// History import
$("#import-file").onchange = async ev => {
  const f = ev.target.files[0]; if (!f) return;
  const box = $("#import-preview");
  let pkg;
  try { pkg = JSON.parse(await f.text()); } catch { box.replaceChildren(h("p", { class: "error" }, "That isn't a valid JSON file.")); return; }
  if (pkg.format !== "appraisal-log-import" || !Array.isArray(pkg.entries)) { box.replaceChildren(h("p", { class: "error" }, "That isn't an Appraisal Log import file.")); return; }
  const entries = pkg.entries.filter(e => e.id && e.date);
  const existing = entries.filter(e => state.entries.has(e.id)).length;
  const byCode = {}; for (const e of entries) byCode[e.code] = (byCode[e.code] || 0) + 1;
  const dates = entries.map(e => e.date).sort();
  const overwrite = h("input", { type: "checkbox" });
  const newDates = (pkg.appraisalDates || []).filter(d => !appraisalDates().includes(d));
  const newTags = (pkg.tags || []).filter(t => !state.settings.tags[t.id]);
  const go = h("button", { class: "primary", onclick: async () => {
    go.disabled = true; go.replaceChildren(h("span", { class: "spinner" }), " Importing…");
    try {
      const patch = {};
      if (newTags.length) patch.tags = Object.fromEntries(newTags.map((t, i) => [t.id, { name: t.name, order: 20 + i }]));
      if (newDates.length) patch.appraisalDates = Object.fromEntries(newDates.map(d => [uid(), { date: d }]));
      if (Object.keys(patch).length) await saveSettings(patch);
      const todo = entries.filter(e => overwrite.checked || !state.entries.has(e.id));
      await batchWrite(todo.map(e => ({ ref: userDoc("entries", e.id), data: {
        date: e.date, hours: e.hours ?? null, code: CODE_LABEL[e.code] ? e.code : "S8",
        tags: Object.fromEntries((e.tags || []).map(t => [t, true])), title: e.title || "", text: e.text || "",
        reflection: e.reflection || "",
        evidence: Object.fromEntries((e.evidence || []).filter(x => x && x.path).map(x => [uid(), { label: x.label || "", path: x.path }])),
        source: "import", importRef: e.importRef || "", origCode: e.origCode || null,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp() } })));
      box.replaceChildren(h("p", {}, `Imported ${todo.length} entries.`));
    } catch (err) { box.replaceChildren(h("p", { class: "error" }, "Import failed: " + err.message)); }
  } }, "Import");
  box.replaceChildren(...[
    h("p", {}, `${entries.length} entries, ${fmtDate(dates[0])} – ${fmtDate(dates.at(-1))}. ${existing ? existing + " already imported." : ""}`),
    h("p", { class: "small muted" }, Object.entries(byCode).map(([c, n]) => `${c}: ${n}`).join(" · ")),
    newDates.length ? h("p", { class: "small" }, `Adds appraisal dates: ${newDates.map(d => fmtDate(d)).join(", ")}`) : null,
    newTags.length ? h("p", { class: "small" }, `Adds tags: ${newTags.map(t => t.name).join(", ")}`) : null,
    existing ? h("label", { class: "include" }, overwrite, "Overwrite entries already imported (loses any edits to them)") : null,
    go].filter(Boolean));
  ev.target.value = "";
};

// Backup / restore
$("#btn-backup").onclick = () => {
  const { geminiApiKey, ...settings } = state.settings;
  const strip = o => JSON.parse(JSON.stringify(o, (k, v) => (v && typeof v === "object" && "seconds" in v && "nanoseconds" in v ? undefined : v)));
  download(`appraisal-log-backup-${todayISO()}.json`, JSON.stringify({
    format: "appraisal-log-backup", version: 1, exported: new Date().toISOString(), settings: strip(settings),
    entries: [...state.entries.values()].map(strip), reports: Object.fromEntries([...state.reports].map(([k, v]) => [k, strip(v)]))
  }, null, 1));
};
$("#restore-file").onchange = async ev => {
  const f = ev.target.files[0]; if (!f) return;
  try {
    const b = JSON.parse(await f.text());
    if (b.format !== "appraisal-log-backup") throw new Error("not an Appraisal Log backup");
    if (!confirm(`Restore ${b.entries.length} entries? Entries with the same id are overwritten; nothing is deleted.`)) return;
    await saveSettings(b.settings || {});
    await batchWrite([
      ...b.entries.map(({ id, ...e }) => ({ ref: userDoc("entries", id), data: { ...e, updatedAt: serverTimestamp() } })),
      ...Object.entries(b.reports || {}).map(([k, v]) => ({ ref: userDoc("reports", k), data: v }))
    ]);
    toast("Restored");
  } catch (err) { toast("Restore failed: " + err.message, 5000); }
  ev.target.value = "";
};

$("#btn-signout").onclick = async () => {
  if (!confirm("Sign out and remove the copy of your data on this device?")) return;
  stopListeners();
  localStorage.removeItem(DRAFT_KEY);
  await signOut(auth);
  try { await terminate(db); await clearIndexedDbPersistence(db); } catch (e) { console.warn(e); }
  location.replace(location.pathname);
};

// ───────────────────────────────────────────── 14. Boot
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(console.warn);

if (!configured) {
  $("#screen-setup").hidden = false;
} else {
  $("#btn-signin").onclick = doSignIn;
  getRedirectResult(auth).catch(err => { $("#signin-error").textContent = err.message; $("#signin-error").hidden = false; });
  onAuthStateChanged(auth, user => {
    state.user = user;
    if (!user) {
      stopListeners(); $("#topbar").hidden = true;
      for (const s of document.querySelectorAll(".screen")) s.hidden = true;
      $("#screen-signin").hidden = false;
      return;
    }
    $("#topbar").hidden = false; $("#screen-signin").hidden = true;
    startListeners();
    const params = new URLSearchParams(location.search);
    if (params.get("capture") === "1") {
      history.replaceState(null, "", location.pathname + location.hash);
      setTimeout(openCapture, 300);
    }
  });
}
