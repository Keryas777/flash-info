/**
 * Flash Info - RSS ingest + Gemini synth
 * - RSS via rss-parser (parseString)
 * - Gemini via REST (v1) WITHOUT ListModels (to avoid 503)
 * - Auto model selection by trying a list (fallback on 404/403)
 * - Writes data/*.json for the webapp
 */

import fs from "node:fs/promises";
import path from "node:path";
import Parser from "rss-parser";

const DATA_DIR = "data";

// ---------- CONFIG ----------
const FEEDS = [
  // Monde
  {
    name: "BBC",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    category: "monde",
    country: "GB",
  },
  {
    name: "France24",
    url: "https://www.france24.com/fr/rss",
    category: "monde",
    country: "FR",
  },

  // Tech
  {
    name: "The Verge",
    url: "https://www.theverge.com/rss/index.xml",
    category: "tech",
    country: "US",
  },

  // Economie & Sport (Le Monde)
  {
    name: "Le Monde",
    url: "https://www.lemonde.fr/economie/rss_full.xml",
    category: "economie",
    country: "FR",
  },
  {
    name: "Le Monde",
    url: "https://www.lemonde.fr/sport/rss_full.xml",
    category: "sport",
    country: "FR",
  },
];

const CATEGORY_LABELS = {
  accueil: "Accueil",
  pays: "Pays",
  monde: "Monde",
  economie: "Économie",
  tech: "Tech",
  sport: "Sport",
};

// combien d’items RSS on donne à Gemini par catégorie
const MAX_ITEMS_PER_CATEGORY = 8;
// on ignore les articles trop vieux
const MAX_AGE_HOURS = 36;

// Gemini
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || "v1"; // "v1" conseillé
const GEMINI_MODEL_CANDIDATES = (process.env.GEMINI_MODEL_CANDIDATES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Liste par défaut (on essaie, et on fallback si 404/403)
const DEFAULT_MODEL_CANDIDATES = [
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
];

const MODELS_TO_TRY =
  GEMINI_MODEL_CANDIDATES.length > 0
    ? GEMINI_MODEL_CANDIDATES
    : DEFAULT_MODEL_CANDIDATES;

// ---------- UTILS ----------
function log(msg) {
  console.log(msg);
}

function nowISO() {
  return new Date().toISOString();
}

function safeDate(d) {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isFinite(t) ? new Date(t) : null;
}

function hoursBetween(a, b) {
  return Math.abs(a.getTime() - b.getTime()) / 36e5;
}

function makeId(str) {
  // stable-ish id from string
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `id_${(h >>> 0).toString(16)}`;
}

function pickImageUrl(item) {
  // rss-parser fields vary by feed; try a few common spots
  const enclosure = item.enclosure?.url;
  if (enclosure && typeof enclosure === "string") return enclosure;

  const itunes = item.itunes?.image;
  if (itunes && typeof itunes === "string") return itunes;

  const mediaContent =
    item["media:content"]?.url ||
    item["media:content"]?.[0]?.url ||
    item["media:thumbnail"]?.url ||
    item["media:thumbnail"]?.[0]?.url;
  if (mediaContent && typeof mediaContent === "string") return mediaContent;

  return null;
}

function normalizeText(s) {
  if (!s) return "";
  return String(s)
    .replace(/\s+/g, " ")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function stripHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countryFlagEmoji(code) {
  if (!code || typeof code !== "string" || code.length !== 2) return "";
  const A = 0x1f1e6;
  const c1 = code.toUpperCase().charCodeAt(0) - 65 + A;
  const c2 = code.toUpperCase().charCodeAt(1) - 65 + A;
  return String.fromCodePoint(c1, c2);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJSON(filepath, data) {
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(filepath, json, "utf-8");
}

// ---------- RSS ----------
const parser = new Parser({
  // on garde ça large, certains flux ont des champs custom
  customFields: {
    item: [
      ["media:content", "media:content"],
      ["media:thumbnail", "media:thumbnail"],
    ],
  },
});

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "flash-info-bot/1.0 (+github actions)",
      accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function readFeed(feed) {
  const xml = await fetchText(feed.url);
  const parsed = await parser.parseString(xml);

  const items = (parsed.items || []).map((it) => {
    const title = normalizeText(it.title);
    const link = it.link || it.guid || "";
    const pub = safeDate(it.isoDate || it.pubDate) || new Date();

    const content =
      stripHtml(it.contentSnippet) ||
      stripHtml(it.content) ||
      stripHtml(it.summary) ||
      "";

    const imageUrl = pickImageUrl(it);

    return {
      id: makeId(`${feed.name}|${feed.url}|${link}|${title}`),
      category: feed.category,
      sourceName: feed.name,
      sourceUrl: feed.url,
      country: feed.country || null,
      countryFlag: feed.country ? countryFlagEmoji(feed.country) : "",
      title,
      link,
      publishedAt: pub.toISOString(),
      snippet: content.slice(0, 400),
      imageUrl,
    };
  });

  return items;
}

// ---------- GEMINI REST ----------
async function geminiGenerateWithModel({ model, prompt, temperature = 0.4, maxOutputTokens = 800 }) {
  const endpoint = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${model}:generateContent?key=${encodeURIComponent(
    GEMINI_API_KEY
  )}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature,
      maxOutputTokens,
    },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Gemini renvoie normalement du JSON, mais on garde la trace
    throw new Error(`Gemini API non-JSON response (${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    const msg = json?.error?.message || `Gemini API error ${res.status}`;
    const code = json?.error?.code || res.status;
    const err = new Error(`${msg}`);
    err.status = res.status;
    err.code = code;
    err.raw = json;
    throw err;
  }

  const out =
    json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
    "";

  return out.trim();
}

async function geminiGenerateAuto({ prompt, temperature, maxOutputTokens }) {
  if (!GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY (GitHub secret).");
  }

  let lastErr = null;

  for (const model of MODELS_TO_TRY) {
    try {
      const out = await geminiGenerateWithModel({
        model,
        prompt,
        temperature,
        maxOutputTokens,
      });
      return { model, text: out };
    } catch (e) {
      lastErr = e;

      // 404/403 -> modèle pas dispo pour ton projet / région / méthode => on essaye le suivant
      if (e.status === 404 || e.status === 403) {
        log(`[gemini] model not usable: ${model} (${e.status}) -> try next`);
        continue;
      }

      // 429/503 -> temporaire : on tente une mini-retry puis on continue
      if (e.status === 429 || e.status === 503) {
        log(`[gemini] temporary error ${e.status} on ${model} -> retry once`);
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const out = await geminiGenerateWithModel({
            model,
            prompt,
            temperature,
            maxOutputTokens,
          });
          return { model, text: out };
        } catch (e2) {
          lastErr = e2;
          log(`[gemini] retry failed on ${model} (${e2.status || "?"}) -> try next`);
          continue;
        }
      }

      // autre erreur => on garde mais on tente quand même le suivant
      log(`[gemini] error on ${model}: ${e.message} -> try next`);
    }
  }

  throw lastErr || new Error("Gemini failed (no usable model).");
}

// ---------- SYNTHESIS ----------
function buildPrompt(category, items) {
  const label = CATEGORY_LABELS[category] || category;

  // On donne à Gemini de la matière structurée + contraintes de sortie JSON
  const sourcesBlock = items
    .map((it, idx) => {
      const src = it.sourceName + (it.country ? ` (${it.country})` : "");
      return `#${idx + 1} [${src}] ${it.title}\nLien: ${it.link}\nExtrait: ${it.snippet}\n`;
    })
    .join("\n");

  return `
Tu es un rédacteur "Flash Info" en français.
Tu reçois plusieurs articles (titres + extraits) sur le thème: ${label}.

Objectif:
- Produire UNE synthèse claire et utile.
- Ne pas inventer des faits non présents dans les sources.
- Si des sources se contredisent: le dire ("selon X... selon Y...").

Sortie OBLIGATOIRE: un JSON strict (pas de markdown, pas de texte autour), au format:

{
  "title": "Titre court et accrocheur",
  "summary": "2-3 phrases maximum",
  "body": "Texte 6 à 12 phrases, paragraphes courts, style mobile.",
  "keyPoints": ["point 1", "point 2", "point 3"],
  "countries": ["FR", "US"] // optionnel, seulement si pertinent
}

Sources:
${sourcesBlock}
`.trim();
}

function fallbackSynthesis(category, items) {
  const label = CATEGORY_LABELS[category] || category;
  const top = items.slice(0, 3);
  const title = top[0]?.title ? `${label} : ${top[0].title}` : `${label} : point de situation`;
  const summary = top
    .map((x) => x.title)
    .filter(Boolean)
    .slice(0, 2)
    .join(" • ")
    .slice(0, 180);

  const body =
    top
      .map((x) => `- ${x.title}${x.sourceName ? ` (${x.sourceName})` : ""}`)
      .join("\n") || "Aucune donnée disponible.";

  return {
    title,
    summary: summary || "Synthèse temporairement indisponible.",
    body,
    keyPoints: top.map((x) => x.title).filter(Boolean).slice(0, 3),
    countries: Array.from(new Set(items.map((x) => x.country).filter(Boolean))).slice(0, 6),
  };
}

function safeParseJSON(text) {
  // Gemini peut parfois ajouter des ```json ...```
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  return JSON.parse(cleaned);
}

// ---------- MAIN ----------
async function main() {
  log(`[ingest] start ${nowISO()}`);

  await ensureDir(DATA_DIR);

  // 1) Fetch RSS
  const allItems = [];
  for (const feed of FEEDS) {
    try {
      const items = await readFeed(feed);
      log(`[rss] ok ${feed.name} (${feed.category})`);
      allItems.push(...items);
    } catch (e) {
      log(`[rss] fail ${feed.name} (${feed.category}): ${e.message}`);
    }
  }

  // 2) Filter age + sort
  const now = new Date();
  const recentItems = allItems
    .filter((it) => {
      const d = safeDate(it.publishedAt);
      if (!d) return false;
      return hoursBetween(now, d) <= MAX_AGE_HOURS;
    })
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // 3) Group by category
  const categories = Array.from(new Set(FEEDS.map((f) => f.category)));
  const byCat = {};
  for (const c of categories) byCat[c] = [];

  for (const it of recentItems) {
    if (!byCat[it.category]) byCat[it.category] = [];
    if (byCat[it.category].length < MAX_ITEMS_PER_CATEGORY) byCat[it.category].push(it);
  }

  // 4) For each category, synthesize with Gemini (or fallback)
  const synth = [];
  for (const [category, items] of Object.entries(byCat)) {
    if (!items || items.length === 0) continue;

    let synthesis = null;
    let usedModel = null;

    try {
      const prompt = buildPrompt(category, items);
      const { model, text } = await geminiGenerateAuto({
        prompt,
        temperature: 0.35,
        maxOutputTokens: 900,
      });
      usedModel = model;

      const parsed = safeParseJSON(text);

      // Validation minimale
      if (!parsed?.title || !parsed?.summary || !parsed?.body) {
        throw new Error("Gemini JSON missing required fields.");
      }

      synthesis = {
        title: normalizeText(parsed.title).slice(0, 140),
        summary: normalizeText(parsed.summary).slice(0, 260),
        body: String(parsed.body || "").trim(),
        keyPoints: Array.isArray(parsed.keyPoints)
          ? parsed.keyPoints.map((x) => normalizeText(x)).filter(Boolean).slice(0, 5)
          : [],
        countries: Array.isArray(parsed.countries)
          ? parsed.countries.map((c) => String(c).toUpperCase()).slice(0, 8)
          : [],
      };
    } catch (e) {
      log(`[gemini] fail (${category}): ${e.message}`);
      synthesis = fallbackSynthesis(category, items);
    }

    // Choix image: première image trouvée dans les items (sinon null -> UI fallback emoji)
    const imageUrl = items.map((x) => x.imageUrl).find(Boolean) || null;

    // Countries utiles pour Monde (badges + drapeaux)
    const countriesFromFeeds = Array.from(
      new Set(items.map((x) => x.country).filter(Boolean))
    ).slice(0, 8);

    const entry = {
      id: makeId(`synth|${category}|${items[0]?.id || ""}|${nowISO()}`),
      category,
      categoryLabel: CATEGORY_LABELS[category] || category,
      updatedAt: nowISO(),
      model: usedModel || null,

      // visuel
      imageUrl,
      // fallback emoji côté front (si imageUrl null/404)
      emojiFallback:
        category === "monde"
          ? "🌍"
          : category === "economie"
          ? "💼"
          : category === "tech"
          ? "🔧"
          : category === "sport"
          ? "⚽"
          : "📰",

      // contenu
      title: synthesis.title,
      summary: synthesis.summary,
      body: synthesis.body,
      keyPoints: synthesis.keyPoints || [],

      // badges simplifiés
      countries:
        synthesis.countries && synthesis.countries.length
          ? synthesis.countries
          : countriesFromFeeds,

      // sources (pour afficher "X sources" + liens éventuels)
      sources: items.map((x) => ({
        name: x.sourceName,
        country: x.country,
        flag: x.countryFlag,
        title: x.title,
        link: x.link,
        publishedAt: x.publishedAt,
      })),
      sourcesCount: items.length,
    };

    synth.push(entry);
  }

  // 5) Sort synth by category order (optional)
  const order = ["monde", "economie", "sport", "tech"];
  synth.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));

  // 6) Write outputs
  const payload = {
    updatedAt: nowISO(),
    items: synth,
  };

  await writeJSON(path.join(DATA_DIR, "feeds.json"), payload);

  // Optionnel: fichiers par catégorie (pratique si tu veux charger à la demande)
  for (const item of synth) {
    await writeJSON(path.join(DATA_DIR, `${item.category}.json`), item);
  }

  log(`[ingest] wrote ${synth.length} synth items -> data/feeds.json`);
  log(`[ingest] done ${nowISO()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});