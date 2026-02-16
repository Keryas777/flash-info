import fs from "node:fs/promises";
import path from "node:path";
import Parser from "rss-parser";

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY (GitHub secret).");
  process.exit(1);
}

const OUT_DIR = "data";
const OUT_SUBJECTS = path.join(OUT_DIR, "subjects.json");
const OUT_FLASH = path.join(OUT_DIR, "flash.json");

// --- Config de base (tu pourras enrichir ensuite)
const CATEGORIES = [
  { key: "tech", name: "Tech", countryHint: null },
  { key: "economie", name: "Économie", countryHint: null },
  { key: "sport", name: "Sport", countryHint: null },
  { key: "divertissement", name: "Divertissement", countryHint: null },
  { key: "pays", name: "Pays", countryHint: "FR" },
  { key: "monde", name: "Monde", countryHint: null }
];

// RSS gratuits (à ajuster selon tes choix / licences)
const RSS_FEEDS = [
  // Monde / général
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", category: "monde", country: "GB", source: "BBC" },
  { url: "https://www.france24.com/fr/rss", category: "monde", country: "FR", source: "France24" },

  // Tech
  { url: "https://www.theverge.com/rss/index.xml", category: "tech", country: "US", source: "The Verge" },

  // Économie
  { url: "https://www.lemonde.fr/economie/rss_full.xml", category: "economie", country: "FR", source: "Le Monde" },

  // Sport
  { url: "https://www.lemonde.fr/sport/rss_full.xml", category: "sport", country: "FR", source: "Le Monde" }
];

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "flash-info-bot/1.0"
  }
});

function nowIso() {
  return new Date().toISOString();
}

function safeText(s) {
  return (s || "").toString().replace(/\s+/g, " ").trim();
}

function pickPublished(item) {
  const d = item.isoDate || item.pubDate || item.published || item.date;
  const dt = d ? new Date(d) : new Date();
  return isNaN(dt.getTime()) ? new Date() : dt;
}

function buildFlash(items) {
  // Micro-infos basées sur les titres récents (placeholder V1)
  // (ensuite on peut demander à Gemini de condenser aussi)
  const top = items
    .slice()
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, 10)
    .map((x) => ({
      id: x.id,
      title: x.title,
      category: x.category,
      country: x.country,
      source: x.source,
      url: x.url,
      at: x.publishedAt.toISOString()
    }));

  return {
    updatedAt: nowIso(),
    items: top
  };
}

async function geminiGenerateSubject({ categoryName, country, sources, articles }) {
  // On envoie uniquement des extraits courts pour limiter tokens/coût.
  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
`Tu es un rédacteur de presse.
À partir de plusieurs articles sur le même sujet, écris UNE synthèse originale en français.

Contraintes :
- Pas de copier-coller, pas de phrases trop proches des sources.
- Structure obligatoire : 
  1) Titre court
  2) Résumé (1-2 phrases)
  3) Ce qu’on sait (3-6 puces)
  4) Ce qu’on suppose (1-3 puces)
  5) Ce qu’on ignore (1-3 puces)
  6) Mises à jour (vide pour l’instant, mais garde la section)
- Ton neutre, pas putaclic.
- Indique le nombre de sources.
- Catégorie = ${categoryName}
- Pays (si pertinent) = ${country || "N/A"}
- Sources = ${sources.join(", ")}

Données (extraits) :
${articles.map((a, i) => `#${i + 1} ${a.source} | ${a.title}\n${a.snippet}\n${a.url}`).join("\n\n")}
`
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.4,
      topP: 0.9
    }
  };

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(API_KEY)}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const json = await res.json();
  const text =
    json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("")?.trim() ||
    "";
  if (!text) throw new Error("Gemini returned empty content.");

  return text;
}

function parseGeminiTextToParts(text) {
  // V1: on stocke brut + on tente une extraction légère
  // (ensuite on passera sur une sortie JSON stricte)
  const lines = text.split("\n").map((l) => l.trim());
  const title = lines.find((l) => l && !l.startsWith("-") && l.length < 120) || "Synthèse";
  const summaryIdx = lines.findIndex((l) => /^résumé/i.test(l));
  const summary = summaryIdx >= 0 ? safeText(lines[summaryIdx + 1] || "") : "";

  return { title: safeText(title), summary, body: text };
}

async function main() {
  console.log(`[ingest] start ${nowIso()}`);

  // 1) Récup RSS
  const allItems = [];
  for (const feed of RSS_FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      const items = (parsed.items || []).slice(0, 12);

      for (const it of items) {
        const title = safeText(it.title);
        const url = it.link || it.guid || "";
        if (!title || !url) continue;

        const publishedAt = pickPublished(it);
        const snippet =
          safeText(it.contentSnippet) ||
          safeText(it.content) ||
          safeText(it.summary) ||
          "";

        allItems.push({
          id: `${feed.source}:${Buffer.from(url).toString("base64url").slice(0, 16)}`,
          title,
          url,
          snippet: snippet.slice(0, 400),
          publishedAt,
          category: feed.category,
          country: feed.country || null,
          source: feed.source
        });
      }

      console.log(`[rss] ok ${feed.source} (${feed.category})`);
    } catch (e) {
      console.warn(`[rss] fail ${feed.url}: ${e?.message || e}`);
    }
  }

  if (allItems.length === 0) {
    console.error("No RSS items fetched. Check feeds / network.");
    process.exit(1);
  }

  // 2) Regroupement simple V1 : par catégorie + proximité de titre (très léger)
  // (ensuite on fera clustering plus malin)
  const byCategory = new Map();
  for (const it of allItems) {
    if (!byCategory.has(it.category)) byCategory.set(it.category, []);
    byCategory.get(it.category).push(it);
  }

  const subjects = [];
  for (const cat of CATEGORIES) {
    const items = (byCategory.get(cat.key) || []).sort((a, b) => b.publishedAt - a.publishedAt);
    if (items.length === 0) continue;

    // V1: on fabrique 1 sujet par catégorie avec les 3-6 articles les plus récents
    const pack = items.slice(0, 6);
    const sources = [...new Set(pack.map((p) => p.source))];
    const country = cat.countryHint || pack.find((p) => p.country)?.country || null;

    const geminiText = await geminiGenerateSubject({
      categoryName: cat.name,
      country,
      sources,
      articles: pack
    });

    const parsed = parseGeminiTextToParts(geminiText);

    subjects.push({
      id: `${cat.key}-${Date.now()}`,
      category: cat.key,
      categoryLabel: cat.name,
      country,
      sourcesCount: sources.length,
      sources,
      title: parsed.title,
      summary: parsed.summary,
      body: parsed.body,
      updatedAt: nowIso(),
      // utile pour “remonter” un article si update :
      sortDate: nowIso(),
      // liens sources pour transparence
      sourceLinks: pack.map((p) => ({ source: p.source, url: p.url, title: p.title }))
    });

    console.log(`[gemini] ok ${cat.key} sources=${sources.length}`);
  }

  // 3) Flash info (placeholder)
  const flash = buildFlash(allItems);

  // 4) Écriture fichiers
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(OUT_SUBJECTS, JSON.stringify({ updatedAt: nowIso(), subjects }, null, 2), "utf8");
  await fs.writeFile(OUT_FLASH, JSON.stringify(flash, null, 2), "utf8");

  console.log(`[ingest] wrote ${OUT_SUBJECTS} & ${OUT_FLASH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
