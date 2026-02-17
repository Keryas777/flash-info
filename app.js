/* =========================
   Flash Info – Web app
   - Load real data from /data/home.json (GitHub Pages)
   - Cards are clickable -> open internal Article modal
   - Keeps previous modal system (article + search + flash skeleton)
   - Cache-busting on fetch to avoid stale JSON
   ========================= */

const CATEGORY_LABELS = {
  tech: "Tech",
  economy: "Économie",
  sport: "Sport",
  entertainment: "Divertissement",
  local: "Pays",
  world: "Monde",
  home: "Accueil",
};

// Map backend categories -> UI categories
const CAT_MAP_FROM_DATA = {
  tech: "tech",
  economie: "economy",
  sport: "sport",
  monde: "world",
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
  if (Number.isNaN(d.getTime())) return "—";
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

let userPrefs = {
  country: "FR",
  language: "fr",
  // what "Accueil" shows
  homeCategories: ["local", "world", "economy", "sport", "tech", "entertainment"],
};

/* ========= Data ========= */
let SUBJECTS = [];      // real subjects loaded from JSON
let FLASH_ITEMS = [];   // optional (not used yet)

/* ========= DOM ========= */
const feedEl = document.getElementById("feed");

// Optional UI elements (if present in HTML, we use them)
const updateBanner = document.getElementById("updateBanner");
const updateBannerText = document.getElementById("updateBannerText");
const applyUpdatesBtn = document.getElementById("applyUpdatesBtn");
const backToTopBtn = document.getElementById("backToTopBtn");

// Flash panel (if exists)
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

// Search (if exists)
const openSearchBtn = document.getElementById("openSearchBtn");
const searchModal = document.getElementById("searchModal");
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const searchCloseBtn = document.getElementById("searchCloseBtn");
const searchCategorySelect = document.getElementById("searchCategorySelect");
const searchPeriodSelect = document.getElementById("searchPeriodSelect");

// Article modal
const articleModal = document.getElementById("articleModal");
const articleContainer = document.getElementById("articleContainer");
const articleBackBtn = document.getElementById("articleBackBtn");
const articleCategoryPill = document.getElementById("articleCategoryPill");
const articleUpdatedPill = document.getElementById("articleUpdatedPill");

// Tabs
const tabs = Array.from(document.querySelectorAll(".tab"));
const navBtns = Array.from(document.querySelectorAll(".nav-btn"));

/* ========= State ========= */
let currentTab = "home";
let pendingSubjects = [];
let isFlashOpen = false;

/* ========= Helpers ========= */
function categoryLabel(category) {
  if (category === "local") return userPrefs.country;
  return CATEGORY_LABELS[category] || category;
}

// Used by badges in cards
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
  const fallback = `<div class="media-fallback" aria-hidden="true">${escapeHTML(emojiForCategory(subject.category))}</div>`;

  if (!subject.image_url) {
    return `<div class="card-media">${fallback}</div>`;
  }

  const safeUrl = escapeHTML(subject.image_url);

  return `
    <div class="card-media" data-fallback="${escapeHTML(emojiForCategory(subject.category))}">
      <img
        src="${safeUrl}"
        alt=""
        loading="lazy"
        onerror="this.parentElement.innerHTML='<div class=&quot;media-fallback&quot; aria-hidden=&quot;true&quot;>'+this.parentElement.dataset.fallback+'</div>';"
      />
    </div>
  `;
}

/* ========= Data loading ========= */

async function fetchJsonWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: "no-store", // still cache-bust with querystring anyway
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function normalizeFromDataHomeJson(homeJson) {
  const items = Array.isArray(homeJson?.items) ? homeJson.items : [];
  const out = [];

  for (const it of items) {
    const uiCat = CAT_MAP_FROM_DATA[it.category] || it.category || "world";
    const updatedAt = it.updatedAt || it.updated_at || homeJson?.generatedAt || new Date().toISOString();

    out.push({
      id: it.id || `${uiCat}-${Math.random().toString(16).slice(2)}`,
      title: it.title || "—",
      category: uiCat,
      primary_country: it.country || null,

      // feed image/url
      image_url: it.image || null,
      url: it.url || null,

      summary: it.summary || "Résumé indisponible.",
      created_at: it.createdAt || it.created_at || updatedAt,
      last_updated_at: updatedAt,

      sources_count: Number(it.sourcesCount ?? it.sources_count ?? 0),
      source_name: it.source || it.source_name || "",

      // If later you enrich sections/updates, the UI will display them
      sections: it.sections || null,
      updates: it.updates || [],
    });
  }

  // Sort by last updated descending
  out.sort((a, b) => new Date(b.last_updated_at) - new Date(a.last_updated_at));
  return out;
}

async function loadHomeData() {
  // Cache bust because GH Pages can cache JSON aggressively
  const url = `data/home.json?t=${Date.now()}`;
  const json = await fetchJsonWithTimeout(url, 15000);
  SUBJECTS = normalizeFromDataHomeJson(json);
}

/* ========= Feed ========= */

function getVisibleSubjectsForTab(tab) {
  if (!SUBJECTS.length) return [];

  if (tab === "home") {
    const cats = userPrefs.homeCategories || ["world", "economy", "sport", "tech"];
    // "local" = items with primary_country == userPrefs.country
    return SUBJECTS.filter((s) => {
      if (cats.includes("local") && s.primary_country === userPrefs.country) return true;
      return cats.includes(s.category);
    });
  }

  if (tab === "local") {
    return SUBJECTS.filter((s) => s.primary_country === userPrefs.country);
  }

  // world / economy / sport / tech / entertainment (if someday)
  return SUBJECTS.filter((s) => s.category === tab);
}

function subjectCardHTML(s) {
  const updated = formatDateTime(s.last_updated_at);

  return `
    <div class="card" data-subject-id="${escapeHTML(s.id)}" role="button" tabindex="0">
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
        <span>MAJ ${updated}</span>
        <span>${Number(s.sources_count || 0)} sources</span>
      </div>
    </div>
  `;
}

function renderFeed() {
  const subjects = getVisibleSubjectsForTab(currentTab);
  if (!subjects.length) {
    // If your HTML has a placeholder card, you can keep it; else we render a message
    feedEl.innerHTML = `
      <div class="card">
        <div class="card-title">Aucune actu pour l’instant</div>
        <p class="card-summary">
          Soit le pipeline n’a pas encore généré <b>data/home.json</b>, soit il n’y a rien de récent.
        </p>
      </div>
    `;
    return;
  }
  feedEl.innerHTML = subjects.map(subjectCardHTML).join("");
}

/* ========= Flash (optional) ========= */
function renderFlash() {
  if (!flashListEl) return;
  const items = [...FLASH_ITEMS].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  flashListEl.innerHTML = items.map(f => `
    <div class="flash-item" data-flash-id="${escapeHTML(f.id)}" role="button" tabindex="0">
      <p class="flash-text">${escapeHTML(f.text_short)}</p>
      <div class="flash-meta">
        <span>${formatTime(f.timestamp)}</span>
        <span>${escapeHTML(categoryLabel(f.category))}</span>
      </div>
    </div>
  `).join("");
}

function openFlashPanel() {
  if (!flashPanelEl || !overlayEl) return;
  isFlashOpen = true;
  renderFlash();
  flashPanelEl.classList.add("open");
  flashPanelEl.setAttribute("aria-hidden", "false");
  overlayEl.hidden = false;
}

function closeFlashPanel() {
  if (!flashPanelEl || !overlayEl) return;
  isFlashOpen = false;
  flashPanelEl.classList.remove("open");
  flashPanelEl.setAttribute("aria-hidden", "true");
  overlayEl.hidden = true;
}

/* ========= Modals ========= */
function openModal(modalEl) {
  if (!modalEl) return;
  modalEl.classList.add("open");
  modalEl.setAttribute("aria-hidden", "false");
}

function closeModal(modalEl) {
  if (!modalEl) return;
  modalEl.classList.remove("open");
  modalEl.setAttribute("aria-hidden", "true");
}

/* ========= Article modal ========= */
function renderUpdates(updates = []) {
  if (!updates || !updates.length) return `<p class="small">Aucune mise à jour enregistrée.</p>`;
  const sorted = [...updates].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return sorted.map(u => `
    <div class="card">
      <div class="card-top">
        <div class="badges">
          <span class="badge">${escapeHTML(formatDateTime(u.timestamp))}</span>
          ${u.is_bump ? `<span class="badge accent">MAJ</span>` : `<span class="badge">mineur</span>`}
        </div>
      </div>
      <p class="card-summary">${escapeHTML(u.text || "—")}</p>
      <div class="card-meta">
        <span>${escapeHTML((u.sources || []).slice(0, 3).join(", "))}</span>
        <span></span>
      </div>
    </div>
  `).join("");
}

function openArticleById(id) {
  const s = SUBJECTS.find(x => x.id === id);
  if (!s) return;

  const catText = (s.category === "world" && s.primary_country)
    ? `${CATEGORY_LABELS.world} · ${worldCountryBadgeText(s)}`
    : categoryLabel(s.category);

  articleCategoryPill && (articleCategoryPill.textContent = catText);
  articleUpdatedPill && (articleUpdatedPill.textContent = `MAJ ${formatDateTime(s.last_updated_at)}`);

  // Sections are optional (for now Gemini gives summary only)
  const known = s.sections?.known || "—";
  const assumed = s.sections?.assumed || "—";
  const unknown = s.sections?.unknown || "—";
  const viewpoints = s.sections?.viewpoints || "";

  const sourceLine = [
    s.source_name ? `Source: ${escapeHTML(s.source_name)}` : "",
    s.url ? `<a href="${escapeHTML(s.url)}" target="_blank" rel="noopener noreferrer">Ouvrir la source</a>` : "",
  ].filter(Boolean).join(" · ");

  articleContainer.innerHTML = `
    <h1>${escapeHTML(s.title)}</h1>
    <p class="summary">${escapeHTML(s.summary)}</p>

    ${sourceLine ? `<p class="small">${sourceLine}</p>` : ""}

    <h2>Ce qu’on sait</h2>
    <p>${escapeHTML(known)}</p>

    <h2>Ce qu’on suppose</h2>
    <p>${escapeHTML(assumed)}</p>

    <h2>Ce qu’on ignore</h2>
    <p>${escapeHTML(unknown)}</p>

    ${viewpoints ? `
      <h2>Points de vue</h2>
      <p>${escapeHTML(viewpoints)}</p>
    ` : ""}

    <h2>Sources</h2>
    <p class="small">${Number(s.sources_count || 0)} sources (selon RSS + synthèse).</p>

    <h2>Mises à jour</h2>
    ${renderUpdates(s.updates)}
  `;

  openModal(articleModal);
}

/* ========= Search modal ========= */
function runSearch() {
  if (!searchResults) return;

  const q = (searchInput?.value || "").trim().toLowerCase();
  const cat = searchCategorySelect?.value || "all";
  const period = searchPeriodSelect?.value || "all";

  const cutoff = (() => {
    if (period === "all") return 0;
    return Date.now() - Number(period) * 24 * 60 * 60 * 1000;
  })();

  let list = SUBJECTS.slice();

  if (cat !== "all") list = list.filter(s => s.category === cat);
  if (cutoff) list = list.filter(s => new Date(s.last_updated_at).getTime() >= cutoff);

  if (q) {
    list = list.filter(s =>
      (s.title || "").toLowerCase().includes(q) ||
      (s.summary || "").toLowerCase().includes(q)
    );
  }

  list.sort((a, b) => new Date(b.last_updated_at) - new Date(a.last_updated_at));

  if (!list.length) {
    searchResults.innerHTML = `<div class="card"><p class="card-summary">Aucun résultat.</p></div>`;
    return;
  }
  searchResults.innerHTML = list.map(subjectCardHTML).join("");
}

function openSearch() {
  if (!searchModal) return;
  openModal(searchModal);
  setTimeout(() => searchInput?.focus(), 40);
  runSearch();
}

function closeSearch() {
  if (!searchModal) return;
  closeModal(searchModal);
  if (searchInput) searchInput.value = "";
  runSearch();
}

/* ========= Update banner (kept, but not used yet) ========= */
function showUpdateBanner() {
  if (!updateBanner || !updateBannerText) return;
  const count = pendingSubjects.length;
  if (count <= 0) return;
  updateBannerText.textContent = `${count} nouvelles mises à jour`;
  updateBanner.hidden = false;
}

function hideUpdateBanner() {
  if (!updateBanner) return;
  updateBanner.hidden = true;
}

function mergeDedupById(existing, incoming) {
  const map = new Map(existing.map(x => [x.id, x]));
  for (const it of incoming) map.set(it.id, it);
  return Array.from(map.values());
}

/* ========= Navigation ========= */
function setActiveTab(tab) {
  currentTab = tab;

  tabs.forEach(t => t.classList.toggle("is-active", t.dataset.tab === tab));

  navBtns.forEach(b => b.classList.remove("is-active"));
  const navKey = tab === "home" ? "home" : (["world", "local"].includes(tab) ? tab : "home");
  const btn = navBtns.find(x => x.dataset.nav === navKey);
  if (btn) btn.classList.add("is-active");

  pendingSubjects = [];
  hideUpdateBanner();
  renderFeed();
  scrollFeedToTop();
}

/* ========= Scroll ========= */
function scrollFeedToTop() {
  feedEl?.scrollTo?.({ top: 0, behavior: "smooth" });
}

if (feedEl && backToTopBtn) {
  feedEl.addEventListener("scroll", () => {
    const st = feedEl.scrollTop;
    backToTopBtn.hidden = !(st > 600);

    if (st < 20 && pendingSubjects.length) {
      // Future: applyPendingUpdates()
      pendingSubjects = [];
      hideUpdateBanner();
      renderFeed();
    }
  });

  backToTopBtn.addEventListener("click", scrollFeedToTop);
}

/* ========= Events ========= */
// Flash
openFlashBtn?.addEventListener("click", openFlashPanel);
closeFlashBtn?.addEventListener("click", closeFlashPanel);
overlayEl?.addEventListener("click", () => { if (isFlashOpen) closeFlashPanel(); });

// Search
openSearchBtn?.addEventListener("click", openSearch);
searchCloseBtn?.addEventListener("click", closeSearch);
searchModal?.addEventListener("click", (e) => { if (e.target === searchModal) closeSearch(); });

searchInput?.addEventListener("input", runSearch);
searchCategorySelect?.addEventListener("change", runSearch);
searchPeriodSelect?.addEventListener("change", runSearch);

// Article
articleBackBtn?.addEventListener("click", () => closeModal(articleModal));
articleModal?.addEventListener("click", (e) => { if (e.target === articleModal) closeModal(articleModal); });

// Tabs
tabs.forEach(t => t.addEventListener("click", () => setActiveTab(t.dataset.tab)));

navBtns.forEach(b => b.addEventListener("click", () => {
  const key = b.dataset.nav;
  if (key === "search") return openSearch();
  if (key === "settings") return openSearch(); // placeholder
  if (key === "home") return setActiveTab("home");
  if (key === "world") return setActiveTab("world");
  if (key === "local") return setActiveTab("local");
}));

// Cards click -> open internal article modal
document.addEventListener("click", (e) => {
  const card = e.target.closest?.(".card");
  if (card?.dataset?.subjectId) {
    openArticleById(card.dataset.subjectId);
    return;
  }

  const flashItem = e.target.closest?.(".flash-item");
  if (flashItem?.dataset?.flashId) {
    const f = FLASH_ITEMS.find(x => x.id === flashItem.dataset.flashId);
    if (f && flashModal) openModal(flashModal);
  }
});

// Keyboard: enter on focused card
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const el = document.activeElement;
  if (el?.classList?.contains("card") && el.dataset?.subjectId) {
    openArticleById(el.dataset.subjectId);
  }
});

/* ========= Init ========= */
(async function init() {
  try {
    await loadHomeData();
  } catch (e) {
    console.warn("[app] loadHomeData failed:", e?.message || e);
    SUBJECTS = [];
  }

  renderFeed();
  renderFlash();
})();