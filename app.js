/* =========================
   Données mock (MVP)
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

let userPrefs = {
  country: "FR",
  language: "fr",
  // Catégories affichées sur l'accueil:
  homeCategories: ["local", "world", "economy", "sport", "tech", "entertainment"],
};

const now = () => Date.now();
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

let SUBJECTS = [
  {
    id: "s1",
    title: "Crypto : volatilité sur le marché après une annonce réglementaire",
    category: "economy",
    primary_country: "US",
    summary: "Les marchés réagissent à une annonce réglementaire ; plusieurs scénarios restent possibles.",
    created_at: minutesAgo(250),
    last_updated_at: minutesAgo(12),
    sources_count: 6,
    sections: {
      known: "Une annonce réglementaire a été publiée et plusieurs acteurs du marché ont réagi.",
      assumed: "Les effets à court terme dépendront des interprétations et de l’application réelle.",
      unknown: "Le calendrier exact et le périmètre final restent flous à ce stade.",
      viewpoints: "Certains y voient une clarification positive ; d’autres craignent une contrainte accrue.",
    },
    updates: [
      { timestamp: minutesAgo(12), is_bump: true, text: "Nouveau communiqué : précisions sur le calendrier.", sources: ["Source A", "Source B"] },
    ],
  },
  {
    id: "s2",
    title: "Sport : résultat clé et impact sur le classement",
    category: "sport",
    primary_country: "FR",
    summary: "Un résultat important redistribue les cartes ; les prochains matchs deviennent décisifs.",
    created_at: minutesAgo(180),
    last_updated_at: minutesAgo(35),
    sources_count: 3,
    sections: {
      known: "Le match s’est terminé sur un score serré.",
      assumed: "La dynamique psychologique pourrait peser sur les prochaines rencontres.",
      unknown: "Les choix de composition et les blessures restent à confirmer.",
      viewpoints: "Les analystes divergent sur la stratégie qui a fait basculer le match.",
    },
    updates: [
      { timestamp: minutesAgo(35), is_bump: true, text: "Réactions d’après-match et premières analyses.", sources: ["Source C"] },
    ],
  },
  {
    id: "s3",
    title: "Tech : nouvelle faille signalée, correctifs en cours",
    category: "tech",
    primary_country: null,
    summary: "Une vulnérabilité est discutée ; des correctifs sont annoncés par plusieurs acteurs.",
    created_at: minutesAgo(90),
    last_updated_at: minutesAgo(90),
    sources_count: 4,
    sections: {
      known: "La faille concerne un composant largement utilisé.",
      assumed: "Les impacts dépendent des configurations et versions installées.",
      unknown: "L’exploitation réelle à grande échelle n’est pas confirmée.",
      viewpoints: "Certains appellent à patcher immédiatement ; d’autres attendent une clarification.",
    },
    updates: [],
  },
  {
    id: "s4",
    title: "Monde : tensions diplomatiques, discussions prévues",
    category: "world",
    primary_country: "GB",
    summary: "Les échanges se durcissent mais une réunion est annoncée ; l’issue reste incertaine.",
    created_at: minutesAgo(70),
    last_updated_at: minutesAgo(10),
    sources_count: 5,
    sections: {
      known: "Des déclarations officielles ont été publiées.",
      assumed: "Une phase de négociation pourrait s’ouvrir rapidement.",
      unknown: "Les concessions possibles ne sont pas connues.",
      viewpoints: "Les observateurs s’opposent sur les motivations réelles des acteurs.",
    },
    updates: [
      { timestamp: minutesAgo(10), is_bump: true, text: "Annonce d’une réunion à court terme.", sources: ["Source D", "Source E"] },
    ],
  },
];

let FLASH_ITEMS = [
  {
    id: "f1",
    timestamp: minutesAgo(2),
    category: "world",
    primary_country: "GB",
    importance_level: "high",
    text_short: "🔴 [GB] Réunion annoncée dans les prochaines heures.",
    text_full: "Une réunion est annoncée dans les prochaines heures. Les déclarations restent prudentes.",
    sources: ["BBC", "Reuters"],
    related_subject_id: "s4",
  },
  {
    id: "f2",
    timestamp: minutesAgo(6),
    category: "sport",
    primary_country: "FR",
    importance_level: "normal",
    text_short: "⚽ [FR] Réaction d’après-match : premières tendances.",
    text_full: "Les premières réactions tombent ; une conférence est attendue.",
    sources: ["L'Équipe"],
    related_subject_id: "s2",
  },
  {
    id: "f3",
    timestamp: minutesAgo(14),
    category: "tech",
    primary_country: null,
    importance_level: "normal",
    text_short: "⚡ [GLOBAL] Correctif en cours de déploiement.",
    text_full: "Un correctif est en cours de déploiement pour une vulnérabilité discutée depuis ce matin.",
    sources: ["Vendor Advisory"],
    related_subject_id: "s3",
  },
];

/* =========================
   Utilitaires
   ========================= */

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

function categoryBadge(category) {
  // label "Pays" devient le pays user si category=local
  if (category === "local") return userPrefs.country;
  return CATEGORY_LABELS[category] || category;
}

/* =========================
   Éléments DOM
   ========================= */

const feedEl = document.getElementById("feed");

const flashPanelEl = document.getElementById("flashPanel");
const flashListEl = document.getElementById("flashList");
const overlayEl = document.getElementById("overlay");

const openFlashBtn = document.getElementById("openFlashBtn");
const closeFlashBtn = document.getElementById("closeFlashBtn");

const flashModal = document.getElementById("flashModal");
const flashModalTitle = document.getElementById("flashModalTitle");
const flashModalMeta = document.getElementById("flashModalMeta");
const flashModalText = document.getElementById("flashModalText");
const flashModalSources = document.getElementById("flashModalSources");
const flashModalCloseBtn = document.getElementById("flashModalCloseBtn");
const flashModalGoToSubjectBtn = document.getElementById("flashModalGoToSubjectBtn");

const updateBanner = document.getElementById("updateBanner");
const updateBannerText = document.getElementById("updateBannerText");
const applyUpdatesBtn = document.getElementById("applyUpdatesBtn");

const backToTopBtn = document.getElementById("backToTopBtn");

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

/* =========================
   État UI
   ========================= */

let currentTab = "home";
let pendingSubjects = []; // nouveautés reçues pendant scroll
let isFlashOpen = false;
let lastFetchAt = now();

/* =========================
   Rendu Feed
   ========================= */

function getVisibleSubjectsForTab(tab) {
  let cats;
  if (tab === "home") cats = userPrefs.homeCategories;
  else cats = [tab];

  // Simple MVP : pas de filtrage pays/langue avancé ici
  const list = SUBJECTS.filter(s => cats.includes(s.category));

  // Tri = remonter à la date de MAJ
  list.sort((a, b) => new Date(b.last_updated_at) - new Date(a.last_updated_at));
  return list;
}

function subjectCardHTML(s) {
  const badge = categoryBadge(s.category);
  const updated = formatDateTime(s.last_updated_at);

  return `
    <div class="card" data-subject-id="${s.id}" role="button" tabindex="0">
      <div class="card-top">
        <div class="badges">
          <span class="badge accent">${badge}</span>
          ${s.primary_country ? `<span class="badge">${s.primary_country}</span>` : `<span class="badge">GLOBAL</span>`}
        </div>
        <span class="badge">Sources: ${s.sources_count}</span>
      </div>

      <div class="card-title">${escapeHTML(s.title)}</div>
      <p class="card-summary">${escapeHTML(s.summary)}</p>

      <div class="card-meta">
        <span>MAJ: ${updated}</span>
        <span>→</span>
      </div>
    </div>
  `;
}

function renderFeed() {
  const subjects = getVisibleSubjectsForTab(currentTab);
  feedEl.innerHTML = subjects.map(subjectCardHTML).join("");
}

function prependOrUpdateSubjects(items) {
  // Merge: si le sujet existe, mettre à jour + remonter
  const map = new Map(SUBJECTS.map(s => [s.id, s]));
  for (const it of items) {
    map.set(it.id, it);
  }
  SUBJECTS = Array.from(map.values());
  renderFeed();
}

/* =========================
   Flash panel + modal flash
   ========================= */

function renderFlash() {
  const items = [...FLASH_ITEMS].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
  flashListEl.innerHTML = items.map(f => `
    <div class="flash-item" data-flash-id="${f.id}" role="button" tabindex="0">
      <p class="flash-text">${escapeHTML(f.text_short)}</p>
      <div class="flash-meta">
        <span>${formatTime(f.timestamp)}</span>
        <span>${categoryBadge(f.category)}</span>
      </div>
    </div>
  `).join("");
}

function openFlashPanel() {
  isFlashOpen = true;
  flashPanelEl.classList.add("open");
  flashPanelEl.setAttribute("aria-hidden", "false");
  overlayEl.hidden = false;
  overlayEl.style.zIndex = 15;
  document.body.style.overflow = "hidden";
}

function closeFlashPanel() {
  isFlashOpen = false;
  flashPanelEl.classList.remove("open");
  flashPanelEl.setAttribute("aria-hidden", "true");
  overlayEl.hidden = true;
}

function openFlashModal(flash) {
  flashModalTitle.textContent = "Flash";
  flashModalMeta.textContent = `${formatDateTime(flash.timestamp)} · ${categoryBadge(flash.category)} ${flash.primary_country ? "· " + flash.primary_country : ""}`;
  flashModalText.textContent = flash.text_full || flash.text_short;

  flashModalSources.innerHTML = "";
  for (const s of flash.sources || []) {
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

function openModal(modalEl) {
  modalEl.classList.add("open");
  modalEl.setAttribute("aria-hidden", "false");
}
function closeModal(modalEl) {
  modalEl.classList.remove("open");
  modalEl.setAttribute("aria-hidden", "true");
}

/* =========================
   Article
   ========================= */

function openArticleById(id) {
  const s = SUBJECTS.find(x => x.id === id);
  if (!s) return;

  articleCategoryPill.textContent = categoryBadge(s.category);
  articleUpdatedPill.textContent = `MAJ ${formatDateTime(s.last_updated_at)}`;

  articleContainer.innerHTML = `
    <h1>${escapeHTML(s.title)}</h1>
    <p class="summary">${escapeHTML(s.summary)}</p>

    <h2>Ce qu’on sait</h2>
    <p>${escapeHTML(s.sections?.known || "—")}</p>

    <h2>Ce qu’on suppose</h2>
    <p>${escapeHTML(s.sections?.assumed || "—")}</p>

    <h2>Ce qu’on ignore</h2>
    <p>${escapeHTML(s.sections?.unknown || "—")}</p>

    ${s.sections?.viewpoints ? `
      <h2>Points de vue</h2>
      <p>${escapeHTML(s.sections.viewpoints)}</p>
    ` : ""}

    <h2>Sources</h2>
    <p class="small">${s.sources_count} sources (MVP mock).</p>

    <h2>Mises à jour</h2>
    ${renderUpdates(s.updates)}
  `;

  openModal(articleModal);
}

function renderUpdates(updates = []) {
  if (!updates.length) return `<p class="small">Aucune mise à jour enregistrée.</p>`;
  const sorted = [...updates].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
  return sorted.map(u => `
    <div class="card">
      <div class="card-top">
        <div class="badges">
          <span class="badge">${formatDateTime(u.timestamp)}</span>
          ${u.is_bump ? `<span class="badge accent">BUMP</span>` : `<span class="badge">minor</span>`}
        </div>
      </div>
      <p class="card-summary">${escapeHTML(u.text)}</p>
      <div class="card-meta">
        <span>${(u.sources || []).slice(0,3).join(", ")}</span>
        <span></span>
      </div>
    </div>
  `).join("");
}

/* =========================
   Recherche
   ========================= */

function openSearch() {
  openModal(searchModal);
  setTimeout(() => searchInput.focus(), 50);
  renderSearchResults([]);
}

function closeSearch() {
  closeModal(searchModal);
  searchInput.value = "";
}

function runSearch() {
  const q = (searchInput.value || "").trim().toLowerCase();
  const cat = searchCategorySelect.value;
  const period = searchPeriodSelect.value;

  const cutoff = (() => {
    if (period === "all") return 0;
    return Date.now() - Number(period) * 24 * 60 * 60 * 1000;
  })();

  let list = SUBJECTS;

  if (cat !== "all") list = list.filter(s => s.category === cat);
  if (cutoff) list = list.filter(s => new Date(s.last_updated_at).getTime() >= cutoff);

  if (q) {
    list = list.filter(s => (
      s.title.toLowerCase().includes(q) ||
      (s.summary || "").toLowerCase().includes(q)
    ));
  }

  // tri récent
  list.sort((a,b) => new Date(b.last_updated_at) - new Date(a.last_updated_at));
  renderSearchResults(list);
}

function renderSearchResults(list) {
  if (!list.length) {
    searchResults.innerHTML = `<div class="card"><p class="card-summary">Aucun résultat.</p></div>`;
    return;
  }
  searchResults.innerHTML = list.map(subjectCardHTML).join("");
}

/* =========================
   Bandeau "N nouvelles MAJ"
   ========================= */

function showUpdateBanner() {
  const newCount = pendingSubjects.length;
  if (newCount <= 0) return;
  updateBannerText.textContent = `${newCount} nouvelles mises à jour`;
  updateBanner.hidden = false;
}
function hideUpdateBanner() {
  updateBanner.hidden = true;
}

function applyPendingUpdates() {
  if (!pendingSubjects.length) return;
  prependOrUpdateSubjects(pendingSubjects);
  pendingSubjects = [];
  hideUpdateBanner();
  scrollFeedToTop();
}

/* =========================
   Navigation tabs + bottom nav
   ========================= */

function setActiveTab(tab) {
  currentTab = tab;

  for (const t of tabs) t.classList.toggle("is-active", t.dataset.tab === tab);

  // bottom nav : on n’active que les 5 boutons existants (home/world/local/search/settings)
  for (const b of navBtns) b.classList.remove("is-active");
  const navKey = tab === "home" ? "home" : (["world","local"].includes(tab) ? tab : null);
  if (navKey) {
    const btn = navBtns.find(x => x.dataset.nav === navKey);
    if (btn) btn.classList.add("is-active");
  } else {
    // si tab = economy/tech/sport/entertainment, on laisse Accueil actif
    const btn = navBtns.find(x => x.dataset.nav === "home");
    if (btn) btn.classList.add("is-active");
  }

  renderFeed();
  // reset banner
  pendingSubjects = [];
  hideUpdateBanner();
  scrollFeedToTop();
}

/* =========================
   Scroll handling
   ========================= */

function scrollFeedToTop() {
  feedEl.scrollTo({ top: 0, behavior: "smooth" });
}

feedEl.addEventListener("scroll", () => {
  const st = feedEl.scrollTop;

  // bouton remonter
  backToTopBtn.hidden = !(st > 600);

  // si on remonte en haut, on applique pending sans action
  if (st < 20 && pendingSubjects.length) {
    prependOrUpdateSubjects(pendingSubjects);
    pendingSubjects = [];
    hideUpdateBanner();
  }
});

backToTopBtn.addEventListener("click", scrollFeedToTop);

/* =========================
   Event listeners
   ========================= */

openFlashBtn.addEventListener("click", () => {
  renderFlash();
  openFlashPanel();
});
closeFlashBtn.addEventListener("click", closeFlashPanel);

overlayEl.addEventListener("click", () => {
  if (isFlashOpen) closeFlashPanel();
});

flashModalCloseBtn.addEventListener("click", () => closeModal(flashModal));
flashModal.addEventListener("click", (e) => {
  if (e.target === flashModal) closeModal(flashModal);
});

searchCloseBtn.addEventListener("click", closeSearch);
openSearchBtn.addEventListener("click", openSearch);
searchModal.addEventListener("click", (e) => {
  if (e.target === searchModal) closeSearch();
});

articleBackBtn.addEventListener("click", () => closeModal(articleModal));
articleModal.addEventListener("click", (e) => {
  if (e.target === articleModal) closeModal(articleModal);
});

applyUpdatesBtn.addEventListener("click", applyPendingUpdates);

// Tabs click
tabs.forEach(t => t.addEventListener("click", () => setActiveTab(t.dataset.tab)));

// Bottom nav click
navBtns.forEach(b => b.addEventListener("click", () => {
  const key = b.dataset.nav;
  if (key === "search") return openSearch();
  if (key === "settings") {
    // MVP: settings non implémenté, on ouvre juste la recherche pour l’instant
    return openSearch();
  }
  if (key === "home") return setActiveTab("home");
  if (key === "world") return setActiveTab("world");
  if (key === "local") return setActiveTab("local");
}));

// Click cards → article
document.addEventListener("click", (e) => {
  const card = e.target.closest?.(".card");
  if (card && card.dataset.subjectId) {
    openArticleById(card.dataset.subjectId);
  }

  const flashItem = e.target.closest?.(".flash-item");
  if (flashItem && flashItem.dataset.flashId) {
    const f = FLASH_ITEMS.find(x => x.id === flashItem.dataset.flashId);
    if (f) openFlashModal(f);
  }
});

// Search input events
searchInput.addEventListener("input", runSearch);
searchCategorySelect.addEventListener("change", runSearch);
searchPeriodSelect.addEventListener("change", runSearch);

/* =========================
   Simulation de nouvelles MAJ (MVP)
   =========================
   Toutes les 25s : simule une MAJ bump d’un sujet
*/
setInterval(() => {
  // Ne pas injecter si l’utilisateur est en recherche ou article
  if (searchModal.classList.contains("open") || articleModal.classList.contains("open")) return;

  // Simule une update bump sur un sujet random visible
  const visible = getVisibleSubjectsForTab(currentTab);
  if (!visible.length) return;

  const pick = visible[Math.floor(Math.random() * visible.length)];
  const updated = {
    ...pick,
    last_updated_at: new Date().toISOString(),
    updates: [
      { timestamp: new Date().toISOString(), is_bump: true, text: "Mise à jour simulée (MVP).", sources: ["Mock"] },
      ...(pick.updates || []),
    ],
  };

  lastFetchAt = now();

  const isAtTop = feedEl.scrollTop < 20;
  if (isAtTop) {
    prependOrUpdateSubjects([updated]);
  } else {
    // en pending
    pendingSubjects = mergeDedupById(pendingSubjects, [updated]);
    showUpdateBanner();
  }
}, 25_000);

/* =========================
   Service worker register
   ========================= */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  });
}

/* =========================
   Helpers
   ========================= */

function mergeDedupById(existing, incoming) {
  const map = new Map(existing.map(x => [x.id, x]));
  for (const it of incoming) map.set(it.id, it);
  return Array.from(map.values());
}

function escapeHTML(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* Init */
renderFeed();
renderFlash();
