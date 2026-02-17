/* =========================
   Flash Info – MVP (data-driven)
   - Loads data from /data/feeds.json (+ optional /data/flashes.json)
   - Photo support (imageUrl) + fallback emoji
   - Simplified badges
   - Flag next to country code for "Monde"
   - Update banner when remote updatedAt changes
   ========================= */

/* ---------- CATEGORY MAP (backend -> frontend) ---------- */
const BACKEND_TO_FRONT = {
  monde: "world",
  economie: "economy",
  tech: "tech",
  sport: "sport",
  divertissement: "entertainment",
  pays: "local",
};

const FRONT_TO_BACKEND = {
  world: "monde",
  economy: "economie",
  tech: "tech",
  sport: "sport",
  entertainment: "divertissement",
  local: "pays",
};

const CATEGORY_LABELS = {
  tech: "Tech",
  economy: "Économie",
  sport: "Sport",
  entertainment: "Divertissement",
  local: "Pays",
  world: "Monde",
  home: "Accueil",
};

function emojiForCategory(cat) {
  return {
    tech: "💻",
    economy: "💼",
    sport: "⚽",
    entertainment: "🎬",
    local: "🏳️",
    world: "🌍",
  }[cat] || "📰";
}

function escapeHTML(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function truncate(text, max = 130) {
  const t = String(text ?? "");
  return t.length <= max ? t : t.slice(0, max).trimEnd() + "…";
}

function formatTime(iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatDateTime(iso) {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mo} ${hh}:${mm}`;
}

/* "US" => "🇺🇸" */
function flagEmojiFromCC(cc) {
  const code = String(cc || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  const A = 0x1F1E6;
  const base = "A".charCodeAt(0);
  return String.fromCodePoint(
    A + (code.charCodeAt(0) - base),
    A + (code.charCodeAt(1) - base)
  );
}

/* ---------- Prefs (à brancher plus tard sur Settings) ---------- */
let userPrefs = {
  country: "FR",
  language: "fr",
  homeCategories: ["local", "world", "economy", "sport", "tech", "entertainment"],
};

/* ---------- DATA STATE ---------- */
let SUBJECTS = [];     // articles (synthèses)
let FLASH_ITEMS = [];  // flash infos (optionnel)
let remoteUpdatedAt = null;

let currentTab = "home";
let pendingSubjects = [];
let isFlashOpen = false;

/* ---------- DOM ---------- */
const feedEl = document.getElementById("feed");
const updateBanner = document.getElementById("updateBanner");
const updateBannerText = document.getElementById("updateBannerText");
const applyUpdatesBtn = document.getElementById("applyUpdatesBtn");
const backToTopBtn = document.getElementById("backToTopBtn");

const flashPanelEl = document.getElementById("flashPanel");
const flashListEl = document.getElementById("flashList");
const overlayEl = document.getElementById("overlay");
const openFlashBtn = document.getElementById("openFlashBtn");
const closeFlashBtn = document.getElementById("closeFlashBtn");

const flashModal = document.getElementById("flashModal");
const flashModalMeta = document.getElementById("flashModalMeta");
const flashModalText = document.getElementById("flashModalText");
const flashModalSources = document.getElementById("flashModalSources");
const flashModalCloseBtn = document.getElementById("flashModalCloseBtn");
const flashModalGoToSubjectBtn = document.getElementById("flashModalGoToSubjectBtn");

const openSearchBtn = document.getElementById("openSearchBtn");
const searchModal = document.getElementById("searchModal");
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const searchCloseBtn = document.getElementById("searchCloseBtn");
const searchCategorySelect = document.getElementById("searchCategorySelect");
const searchPeriodSelect = document.getElementById("searchPeriodSelect");

const articleModal = document.getElementById("articleModal");
const articleContainer = document.getElementById("articleContainer");
const articleBackBtn = document.getElementById("articleBackBtn");
const articleCategoryPill = document.getElementById("articleCategoryPill");
const articleUpdatedPill = document.getElementById("articleUpdatedPill");

const tabs = Array.from(document.querySelectorAll(".tab"));
const navBtns = Array.from(document.querySelectorAll(".nav-btn"));

/* ---------- Helpers ---------- */
function categoryLabel(category) {
  if (category === "local") return userPrefs.country;
  return CATEGORY_LABELS[category] || category;
}

function worldCountryBadgeText(subject) {
  const cc = subject.primary_country;
  if (!cc) return "GLOBAL";
  const flag = flagEmojiFromCC(cc);
  return subject.category === "world" && flag ? `${cc} ${flag}` : cc;
}

/* Media HTML:
   - If image_url provided: render <img> with onerror -> swap to emoji fallback
   - Else: render fallback emoji immediately
*/
function mediaHTML(subject) {
  const fallbackEmoji = emojiForCategory(subject.category);
  const fallback = `<div class="media-fallback" aria-hidden="true">${escapeHTML(
    fallbackEmoji
  )}</div>`;

  if (!subject.image_url) {
    return `<div class="card-media">${fallback}</div>`;
  }

  const safeUrl = escapeHTML(subject.image_url);

  return `
    <div class="card-media" data-fallback="${escapeHTML(fallbackEmoji)}">
      <img
        src="${safeUrl}"
        alt=""
        loading="lazy"
        onerror="this.parentElement.innerHTML='<div class=&quot;media-fallback&quot; aria-hidden=&quot;true&quot;>'+this.parentElement.dataset.fallback+'</div>';"
      />
    </div>
  `;
}

/* ---------- Rendering Feed ---------- */
function getVisibleSubjectsForTab(tab) {
  const cats = tab === "home" ? userPrefs.homeCategories : [tab];
  const list = SUBJECTS.filter((s) => cats.includes(s.category));
  list.sort((a, b) => new Date(b.last_updated_at) - new Date(a.last_updated_at));
  return list;
}

function subjectCardHTML(s) {
  const updated = formatDateTime(s.last_updated_at);

  return `
    <div class="card" data-subject-id="${s.id}" role="button" tabindex="0">
      ${mediaHTML(s)}
      <div class="card-top">
        <div class="badges">
          <span class="badge accent">${escapeHTML(categoryLabel(s.category))}</span>
          <span class="badge">${escapeHTML(worldCountryBadgeText(s))}</span>
        </div>
      </div>

      <div class="card-title">${escapeHTML(s.title)}</div>
      <p class="card-summary">${escapeHTML(truncate(s.summary, 130))}</p>

      <div class="card-meta">
        <span>MAJ: ${updated}</span>
        <span>${Number(s.sources_count || 0)} sources</span>
      </div>
    </div>
  `;
}

function renderFeed() {
  const subjects = getVisibleSubjectsForTab(currentTab);

  if (!subjects.length) {
    feedEl.innerHTML = `
      <div class="card">
        <div class="card-title">Aucune actu pour l’instant</div>
        <p class="card-summary">Soit le pipeline n’a pas encore généré <b>data/feeds.json</b>, soit il n’y a rien de récent.</p>
      </div>
    `;
    return;
  }

  feedEl.innerHTML = subjects.map(subjectCardHTML).join("");
}

function upsertSubjects(items) {
  const map = new Map(SUBJECTS.map((s) => [s.id, s]));
  for (const it of items) map.set(it.id, it);
  SUBJECTS = Array.from(map.values());
}

/* ---------- Flash ---------- */
function renderFlash() {
  const items = [...FLASH_ITEMS].sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  );

  if (!items.length) {
    flashListEl.innerHTML = `
      <div class="flash-item">
        <p class="flash-text">Aucun Flash Info pour l’instant.</p>
        <div class="flash-meta"><span></span><span></span></div>
      </div>
    `;
    return;
  }

  flashListEl.innerHTML = items
    .map(
      (f) => `
    <div class="flash-item" data-flash-id="${f.id}" role="button" tabindex="0">
      <p class="flash-text">${escapeHTML(f.text_short)}</p>
      <div class="flash-meta">
        <span>${formatTime(f.timestamp)}</span>
        <span>${escapeHTML(categoryLabel(f.category))}</span>
      </div>
    </div>
  `
    )
    .join("");
}

function openFlashPanel() {
  isFlashOpen = true;
  renderFlash();
  flashPanelEl.classList.add("open");
  flashPanelEl.setAttribute("aria-hidden", "false");
  overlayEl.hidden = false;
}

function closeFlashPanel() {
  isFlashOpen = false;
  flashPanelEl.classList.remove("open");
  flashPanelEl.setAttribute("aria-hidden", "true");
  overlayEl.hidden = true;
}

function openModal(modalEl) {
  modalEl.classList.add("open");
  modalEl.setAttribute("aria-hidden", "false");
}

function closeModal(modalEl) {
  modalEl.classList.remove("open");
  modalEl.setAttribute("aria-hidden", "true");
}

function openFlashModal(flash) {
  const cc = flash.primary_country;
  const flag = flash.category === "world" ? flagEmojiFromCC(cc) : "";
  const ccText = cc ? (flag ? `${cc} ${flag}` : cc) : "GLOBAL";

  flashModalMeta.textContent = `${formatDateTime(
    flash.timestamp
  )} · ${categoryLabel(flash.category)} · ${ccText}`;

  flashModalText.textContent = flash.text_full || flash.text_short;

  flashModalSources.innerHTML = "";
  for (const s of (flash.sources || []).slice(0, 6)) {
    const div = document.createElement("div");
    div.className = "source";
    div.textContent = s;
    flashModalSources.appendChild(div);
  }

  if (flash.related_subject_id) {
    flashModalGoToSubjectBtn.hidden = false;
    flashModalGoToSubjectBtn.onclick = () => {
      closeModal(flashModal);
      openArticleById(flash.related_subject_id);
    };
  } else {
    flashModalGoToSubjectBtn.hidden = true;
    flashModalGoToSubjectBtn.onclick = null;
  }

  openModal(flashModal);
}

/* ---------- Article ---------- */
function renderUpdates(updates = []) {
  if (!updates.length)
    return `<p class="small">Aucune mise à jour enregistrée.</p>`;

  const sorted = [...updates].sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  );

  return sorted
    .map(
      (u) => `
    <div class="card">
      <div class="card-top">
        <div class="badges">
          <span class="badge">${escapeHTML(formatDateTime(u.timestamp))}</span>
          ${
            u.is_bump
              ? `<span class="badge accent">MAJ</span>`
              : `<span class="badge">mineur</span>`
          }
        </div>
      </div>
      <p class="card-summary">${escapeHTML(u.text)}</p>
      <div class="card-meta">
        <span>${escapeHTML((u.sources || []).slice(0, 3).join(", "))}</span>
        <span></span>
      </div>
    </div>
  `
    )
    .join("");
}

function openArticleById(id) {
  const s = SUBJECTS.find((x) => x.id === id);
  if (!s) return;

  const catText =
    s.category === "world" && s.primary_country
      ? `${CATEGORY_LABELS.world} · ${worldCountryBadgeText(s)}`
      : categoryLabel(s.category);

  articleCategoryPill.textContent = catText;
  articleUpdatedPill.textContent = `MAJ ${formatDateTime(s.last_updated_at)}`;

  // Adaptation: nos synthèses réelles ont body + keyPoints,
  // mais pas forcément les sections connues/supposées/ignorées.
  // Donc on affiche:
  // - summary
  // - key points
  // - body
  // - sources list
  const keyPointsHTML =
    (s.key_points || []).length > 0
      ? `<ul>${s.key_points
          .map((kp) => `<li>${escapeHTML(kp)}</li>`)
          .join("")}</ul>`
      : `<p class="small">—</p>`;

  const sourcesHTML =
    (s.sources || []).length > 0
      ? `<ul class="small">${s.sources
          .slice(0, 12)
          .map(
            (src) =>
              `<li>${escapeHTML(src.name || "Source")} — <a href="${escapeHTML(
                src.link || "#"
              )}" target="_blank" rel="noopener noreferrer">${escapeHTML(
                truncate(src.title || src.link || "", 60)
              )}</a></li>`
          )
          .join("")}</ul>`
      : `<p class="small">${Number(s.sources_count || 0)} sources</p>`;

  articleContainer.innerHTML = `
    <h1>${escapeHTML(s.title)}</h1>
    <p class="summary">${escapeHTML(s.summary)}</p>

    <h2>Points clés</h2>
    ${keyPointsHTML}

    <h2>Synthèse</h2>
    <p>${escapeHTML(s.body || "—")}</p>

    <h2>Sources</h2>
    ${sourcesHTML}

    <h2>Mises à jour</h2>
    ${renderUpdates(s.updates)}
  `;

  openModal(articleModal);
}

/* ---------- Search ---------- */
function openSearch() {
  openModal(searchModal);
  setTimeout(() => searchInput.focus(), 40);
  runSearch();
}

function closeSearch() {
  closeModal(searchModal);
  searchInput.value = "";
  runSearch();
}

function runSearch() {
  const q = (searchInput.value || "").trim().toLowerCase();
  const cat = searchCategorySelect.value;
  const period = searchPeriodSelect.value;

  const cutoff = (() => {
    if (period === "all") return 0;
    return Date.now() - Number(period) * 24 * 60 * 60 * 1000;
  })();

  let list = SUBJECTS.slice();

  if (cat !== "all") list = list.filter((s) => s.category === cat);
  if (cutoff) list = list.filter((s) => new Date(s.last_updated_at).getTime() >= cutoff);

  if (q) {
    list = list.filter(
      (s) =>
        (s.title || "").toLowerCase().includes(q) ||
        (s.summary || "").toLowerCase().includes(q) ||
        (s.body || "").toLowerCase().includes(q)
    );
  }

  list.sort((a, b) => new Date(b.last_updated_at) - new Date(a.last_updated_at));

  if (!list.length) {
    searchResults.innerHTML = `<div class="card"><p class="card-summary">Aucun résultat.</p></div>`;
    return;
  }
  searchResults.innerHTML = list.map(subjectCardHTML).join("");
}

/* ---------- Update banner ---------- */
function showUpdateBanner() {
  const count = pendingSubjects.length;
  if (count <= 0) return;
  updateBannerText.textContent = `${count} nouvelles mises à jour`;
  updateBanner.hidden = false;
}

function hideUpdateBanner() {
  updateBanner.hidden = true;
}

function mergeDedupById(existing, incoming) {
  const map = new Map(existing.map((x) => [x.id, x]));
  for (const it of incoming) map.set(it.id, it);
  return Array.from(map.values());
}

function applyPendingUpdates() {
  if (!pendingSubjects.length) return;
  upsertSubjects(pendingSubjects);
  pendingSubjects = [];
  hideUpdateBanner();
  renderFeed();
  scrollFeedToTop();
}

/* ---------- Navigation ---------- */
function setActiveTab(tab) {
  currentTab = tab;

  tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.tab === tab));

  navBtns.forEach((b) => b.classList.remove("is-active"));
  const navKey = tab === "home" ? "home" : ["world", "local"].includes(tab) ? tab : "home";
  const btn = navBtns.find((x) => x.dataset.nav === navKey);
  if (btn) btn.classList.add("is-active");

  pendingSubjects = [];
  hideUpdateBanner();
  renderFeed();
  scrollFeedToTop();
}

/* ---------- Scroll ---------- */
function scrollFeedToTop() {
  feedEl.scrollTo({ top: 0, behavior: "smooth" });
}

feedEl.addEventListener("scroll", () => {
  const st = feedEl.scrollTop;
  backToTopBtn.hidden = !(st > 600);

  if (st < 20 && pendingSubjects.length) {
    applyPendingUpdates();
  }
});

backToTopBtn.addEventListener("click", scrollFeedToTop);

/* ---------- Events ---------- */
openFlashBtn.addEventListener("click", openFlashPanel);
closeFlashBtn.addEventListener("click", closeFlashPanel);
overlayEl.addEventListener("click", () => {
  if (isFlashOpen) closeFlashPanel();
});

flashModalCloseBtn.addEventListener("click", () => closeModal(flashModal));
flashModal.addEventListener("click", (e) => {
  if (e.target === flashModal) closeModal(flashModal);
});

openSearchBtn.addEventListener("click", openSearch);
searchCloseBtn.addEventListener("click", closeSearch);
searchModal.addEventListener("click", (e) => {
  if (e.target === searchModal) closeSearch();
});

searchInput.addEventListener("input", runSearch);
searchCategorySelect.addEventListener("change", runSearch);
searchPeriodSelect.addEventListener("change", runSearch);

articleBackBtn.addEventListener("click", () => closeModal(articleModal));
articleModal.addEventListener("click", (e) => {
  if (e.target === articleModal) closeModal(articleModal);
});

applyUpdatesBtn.addEventListener("click", applyPendingUpdates);

tabs.forEach((t) => t.addEventListener("click", () => setActiveTab(t.dataset.tab)));

navBtns.forEach((b) =>
  b.addEventListener("click", () => {
    const key = b.dataset.nav;
    if (key === "search") return openSearch();
    if (key === "settings") return openSearch(); // placeholder
    if (key === "home") return setActiveTab("home");
    if (key === "world") return setActiveTab("world");
    if (key === "local") return setActiveTab("local");
  })
);

document.addEventListener("click", (e) => {
  const card = e.target.closest?.(".card");
  if (card?.dataset?.subjectId) {
    openArticleById(card.dataset.subjectId);
    return;
  }

  const flashItem = e.target.closest?.(".flash-item");
  if (flashItem?.dataset?.flashId) {
    const f = FLASH_ITEMS.find((x) => x.id === flashItem.dataset.flashId);
    if (f) openFlashModal(f);
  }
});

/* ---------- Data loading (real) ---------- */
function mapBackendItemToSubject(item) {
  // item vient de data/feeds.json généré par ingest
  // attendus: id, category (monde/economie/tech/sport), updatedAt, imageUrl, emojiFallback,
  // title, summary, body, keyPoints, sources[], countries[]
  const catFront = BACKEND_TO_FRONT[item.category] || item.category || "world";

  // pays principal: si monde -> 1er code pays pertinent; sinon pays user ou GLOBAL
  const primaryCountry =
    (Array.isArray(item.countries) && item.countries[0]) ||
    (Array.isArray(item.sources) && item.sources.find((s) => s.country)?.country) ||
    (catFront === "local" ? userPrefs.country : null);

  const sources = Array.isArray(item.sources) ? item.sources : [];
  const sources_count = sources.length || item.sourcesCount || 0;

  return {
    id: item.id,
    title: item.title || "Sans titre",
    category: catFront,
    primary_country: primaryCountry,
    image_url: item.imageUrl || null,
    summary: item.summary || "",
    body: item.body || "",
    key_points: Array.isArray(item.keyPoints) ? item.keyPoints : [],
    created_at: item.updatedAt || new Date().toISOString(),
    last_updated_at: item.updatedAt || new Date().toISOString(),
    sources_count,
    sources,
    sections: null,
    updates: [], // pas géré en V1
  };
}

function buildFallbackFlashFromSubjects(subjects) {
  // Si tu n’as pas encore data/flashes.json,
  // on fabrique une colonne flash basique depuis les sujets.
  const sorted = [...subjects].sort(
    (a, b) => new Date(b.last_updated_at) - new Date(a.last_updated_at)
  );

  return sorted.slice(0, 12).map((s, idx) => {
    const cc = s.primary_country || null;
    const prefix = s.category === "world" ? "🔴" : "⚡";
    const ccTxt = cc ? `[${cc}] ` : "[GLOBAL] ";
    return {
      id: `auto_${s.id}_${idx}`,
      timestamp: s.last_updated_at,
      category: s.category,
      primary_country: cc,
      importance_level: idx < 2 ? "high" : "normal",
      text_short: `${prefix} ${ccTxt}${truncate(s.title, 70)}`,
      text_full: s.summary || s.title,
      sources: (s.sources || []).slice(0, 3).map((x) => x.name).filter(Boolean),
      related_subject_id: s.id,
    };
  });
}

async function fetchJSON(url) {
  // cache-bust pour éviter que iOS garde une vieille version
  const bust = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${bust}ts=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

async function loadInitialData() {
  try {
    const data = await fetchJSON("data/feeds.json");
    remoteUpdatedAt = data.updatedAt || null;

    const items = Array.isArray(data.items) ? data.items : [];
    SUBJECTS = items.map(mapBackendItemToSubject);

    // Optional flashes.json (si tu le génères plus tard)
    try {
      const flashes = await fetchJSON("data/flashes.json");
      const fl = Array.isArray(flashes.items) ? flashes.items : [];
      FLASH_ITEMS = fl;
    } catch {
      FLASH_ITEMS = buildFallbackFlashFromSubjects(SUBJECTS);
    }

    renderFeed();
    renderFlash();
  } catch (e) {
    // fallback UI vide + message
    SUBJECTS = [];
    FLASH_ITEMS = [];
    renderFeed();
    renderFlash();
    console.warn("Data load failed:", e?.message || e);
  }
}

async function pollUpdates() {
  // Si un modal est ouvert, on évite de bouleverser l’UI
  if (searchModal.classList.contains("open") || articleModal.classList.contains("open")) return;

  try {
    const data = await fetchJSON("data/feeds.json");
    const newUpdatedAt = data.updatedAt || null;

    if (!remoteUpdatedAt) {
      remoteUpdatedAt = newUpdatedAt;
      return;
    }

    if (newUpdatedAt && newUpdatedAt !== remoteUpdatedAt) {
      // on a une nouvelle version
      remoteUpdatedAt = newUpdatedAt;

      const items = Array.isArray(data.items) ? data.items : [];
      const incoming = items.map(mapBackendItemToSubject);

      // calc diff simple (id + last_updated_at)
      const currentMap = new Map(SUBJECTS.map((s) => [s.id, s.last_updated_at]));
      const changed = incoming.filter((s) => currentMap.get(s.id) !== s.last_updated_at);

      const isAtTop = feedEl.scrollTop < 20;

      if (isAtTop) {
        upsertSubjects(changed);
        renderFeed();
        FLASH_ITEMS = buildFallbackFlashFromSubjects(SUBJECTS);
        renderFlash();
      } else {
        pendingSubjects = mergeDedupById(pendingSubjects, changed);
        showUpdateBanner();
      }
    }
  } catch (e) {
    // silencieux : le polling ne doit pas casser l’app
    console.warn("Poll failed:", e?.message || e);
  }
}

/* ---------- Init ---------- */
loadInitialData();
renderFlash(); // au cas où (vide)
setInterval(pollUpdates, 60_000); // check toutes les 60s (ajuste si tu veux)