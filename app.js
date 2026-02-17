/* =========================
   Flash Info – Live Version
   ========================= */

const DATA_URL = "data/home.json";

/* ========= Utils ========= */

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

function formatDateTime(iso) {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mo} ${hh}:${mm}`;
}

function emojiForCategory(cat) {
  return {
    tech: "💻",
    economie: "💼",
    sport: "⚽",
    monde: "🌍",
  }[cat] || "📰";
}

/* ========= State ========= */

let SUBJECTS = [];

/* ========= DOM ========= */

const feedEl = document.getElementById("feed");

/* ========= Media ========= */

function mediaHTML(subject) {
  const fallback = `<div class="media-fallback">${emojiForCategory(subject.category)}</div>`;

  if (!subject.image) {
    return `<div class="card-media">${fallback}</div>`;
  }

  return `
    <div class="card-media" data-fallback="${emojiForCategory(subject.category)}">
      <img
        src="${escapeHTML(subject.image)}"
        loading="lazy"
        onerror="this.parentElement.innerHTML='<div class=&quot;media-fallback&quot;>'+this.parentElement.dataset.fallback+'</div>';"
      />
    </div>
  `;
}

/* ========= Card ========= */

function subjectCardHTML(s) {
  return `
    <div class="card">
      ${mediaHTML(s)}

      <div class="card-top">
        <div class="badges">
          <span class="badge accent">${escapeHTML(s.category)}</span>
          <span class="badge">${escapeHTML(s.country || "GLOBAL")}</span>
        </div>
      </div>

      <div class="card-title">${escapeHTML(s.title)}</div>
      <p class="card-summary">${escapeHTML(truncate(s.summary, 130))}</p>

      <div class="card-meta">
        <span>MAJ ${formatDateTime(s.updatedAt)}</span>
        <span>${Number(s.sourcesCount || 0)} sources</span>
      </div>
    </div>
  `;
}

/* ========= Render ========= */

function renderFeed() {
  if (!SUBJECTS.length) {
    feedEl.innerHTML = `
      <div class="card">
        <div class="card-title">Aucune actu pour l’instant</div>
        <p class="card-summary">
          Le pipeline n’a pas encore généré data/home.json
          ou aucune donnée récente n’est disponible.
        </p>
      </div>
    `;
    return;
  }

  feedEl.innerHTML = SUBJECTS.map(subjectCardHTML).join("");
}

/* ========= Fetch ========= */

async function loadData() {
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("Fetch failed");

    const data = await res.json();

    if (!data?.items?.length) {
      SUBJECTS = [];
      renderFeed();
      return;
    }

    SUBJECTS = data.items
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    renderFeed();
  } catch (err) {
    console.error("Data load error:", err);
    SUBJECTS = [];
    renderFeed();
  }
}

/* ========= Init ========= */

loadData();