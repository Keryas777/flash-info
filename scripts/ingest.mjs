// scripts/ingest.mjs
// Node 20+ (fetch natif)
//
// Objectif :
// - Récupérer des flux RSS
// - Prendre quelques items récents
// - Appeler Gemini pour synthétiser en 1 flash par flux
// - Écrire data/home.json + data/{categorie}.json
//
// Env :
// - GEMINI_API_KEY (obligatoire)
// - GEMINI_API_VERSION (optionnel, défaut "v1")  // "v1" recommandé
// - GEMINI_MODEL (optionnel, force un modèle précis)

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Parser from "rss-parser";

const startedAt = new Date().toISOString();
console.log(`[ingest] start ${startedAt}`);

const DATA_DIR = path.resolve("data");

// Catégories (alignées avec ton app.js: tech/economie/sport/monde)
const FEEDS = [
  {
    id: "bbc-world",
    name: "BBC (monde)",
    category: "monde",
    country: "GB",
    url: "http://feeds.bbci.co.uk/news/world/rss.xml",
  },
  {
    id: "france24-world",
    name: "France24 (monde)",
    category: "monde",
    country: "FR",
    url: "https://www.france24.com/fr/rss",
  },
  {
    id: "theverge-tech",
    name: "The Verge (tech)",
    category: "tech",
    country: "US",
    url: "https://www.theverge.com/rss/index.xml",
  },
  {
    id: "lemonde-eco",
    name: "Le Monde (economie)",
    category: "economie",
    country: "FR",
    url: "https://www.lemonde.fr/economie/rss_full.xml",
  },
  {
    id: "lemonde-sport",
    name: "Le Monde (sport)",
    category: "sport",
    country: "FR",
    url: "https://www.lemonde.fr/sport/rss_full.xml",
  },
];

// ---------------------------
// Utils
// ---------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stableId(...parts) {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

function stripHtml(input = "") {
  return String(input)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toIsoDateMaybe(d) {
  if (!d) return null;
  const t = Date.parse(d);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function pickImageFromItem(item) {
  // rss-parser normalize souvent :
  // - enclosure.url
  // - itunes:image
  // - media:content (via item["media:content"] selon feed)
  const enc = item.enclosure?.url;
  if (enc) return enc;

  const itunesImg = item["itunes:image"]?.href || item["itunes:image"]?.url;
  if (itunesImg) return itunesImg;

  const media = item["media:content"] || item["media:thumbnail"];
  if (media) {
    if (Array.isArray(media)) {
      for (const m of media) {
        const u = m?.url || m?.href;
        if (u) return u;
      }
    } else {
      const u = media?.url || media?.href;
      if (u) return u;
    }
  }

  // Dernier recours : scrapper un <img> dans contentSnippet/content
  const html = item.content || item["content:encoded"] || "";
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m?.[1]) return m[1];

  return null;
}

// ---------------------------
// RSS parsing
// ---------------------------

const parser = new Parser({
  headers: {
    "User-Agent": "flash-info-bot/1.0 (+github actions)",
    Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7",
  },
  timeout: 20000,
});

async function loadFeed(feed) {
  const res = await parser.parseURL(feed.url);

  const items = (res.items || [])
    .map((it) => {
      const title = (it.title || "").trim();
      const url = (it.link || "").trim();
      const publishedAt =
        toIsoDateMaybe(it.isoDate) ||
        toIsoDateMaybe(it.pubDate) ||
        toIsoDateMaybe(it.published) ||
        null;

      const excerpt = stripHtml(it.contentSnippet || it.summary || it.content || "");
      const image = pickImageFromItem(it);

      return { title, url, publishedAt, excerpt, image };
    })
    .filter((x) => x.title && x.url)
    .sort((a, b) => (Date.parse(b.publishedAt || "") || 0) - (Date.parse(a.publishedAt || "") || 0));

  return {
    feedTitle: (res.title || feed.name || "").trim(),
    items,
  };
}

// ---------------------------
// Gemini API
// ---------------------------

function geminiBase(version) {
  return `https://generativelanguage.googleapis.com/${version}`;
}

async function geminiFetchJson(url, opts, { retries = 3 } = {}) {
  let attempt = 0;

  while (true) {
    attempt++;
    const res = await fetch(url, opts);
    const text = await res.text();

    if (res.ok) {
      return JSON.parse(text);
    }

    // Retry seulement sur erreurs “transitoires”
    if ((res.status === 503 || res.status === 429) && attempt < retries) {
      const wait = 1500 * attempt;
      console.warn(`[gemini] ${res.status} retry ${attempt}/${retries} in ${wait}ms`);
      await sleep(wait);
      continue;
    }

    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }
}

async function listModels(apiKey, version = "v1") {
  const url = `${geminiBase(version)}/models?key=${apiKey}`;
  const data = await geminiFetchJson(url, { method: "GET" }, { retries: 3 });
  return data.models || [];
}

function modelSupportsGenerateContent(model) {
  const methods = model.supportedGenerationMethods;
  if (!methods) return true;
  return methods.includes("generateContent");
}

function scoreModelName(name) {
  const n = name.toLowerCase();
  let s = 0;
  if (n.includes("gemini")) s += 100;
  if (n.includes("flash")) s += 50;
  if (n.includes("pro")) s += 30;
  if (n.includes("latest")) s += 10;
  if (n.includes("exp")) s -= 5;
  return s;
}

async function pickGeminiModel(apiKey, version = "v1") {
  const forced = process.env.GEMINI_MODEL?.trim();
  if (forced) {
    console.log(`[gemini] using forced model: ${forced}`);
    return forced;
  }

  // 1) Tentative ListModels (peut être down)
  try {
    const models = await listModels(apiKey, version);
    const usable = models
      .filter((m) => m?.name && modelSupportsGenerateContent(m))
      .map((m) => m.name);

    if (usable.length) {
      usable.sort((a, b) => scoreModelName(b) - scoreModelName(a));
      console.log(`[gemini] auto model: ${usable[0]}`);
      return usable[0];
    }
  } catch (e) {
    console.warn(`[gemini] ListModels failed, will fallback. reason: ${e.message}`);
  }

  // 2) Fallback “probables”
  const fallback = [
    "models/gemini-1.5-flash-latest",
    "models/gemini-1.5-pro-latest",
    "models/gemini-1.5-flash",
    "models/gemini-1.5-pro",
    "models/gemini-2.0-flash",
    "models/gemini-2.0-pro",
  ];

  console.log(`[gemini] fallback model candidate: ${fallback[0]}`);
  return fallback[0];
}

async function generateContent(apiKey, modelName, prompt, version = "v1") {
  const url = `${geminiBase(version)}/${modelName}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 450,
    },
  };

  const data = await geminiFetchJson(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { retries: 3 }
  );

  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("")?.trim() || "";

  return text;
}

function safeJsonExtract(text) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const slice = text.slice(first, last + 1);
    try {
      return JSON.parse(slice);
    } catch {
      return null;
    }
  }
  return null;
}

function buildPrompt({ category, feedName, country, items }) {
  const top = items.slice(0, 6);
  const sources = top
    .map((it, idx) => {
      const excerpt = it.excerpt ? it.excerpt.slice(0, 260) : "";
      return `${idx + 1}. ${it.title}\n   ${excerpt}\n   ${it.url}`;
    })
    .join("\n\n");

  return `
Tu es un rédacteur de flash info.
Tu dois produire UN seul flash synthétique, clair, court et utile.

Contexte:
- Catégorie: ${category}
- Source principale: ${feedName}
- Pays: ${country}

Contraintes:
- Titre court (max ~90 caractères)
- Résumé 2 à 3 phrases (pas plus)
- Style neutre, pas sensationnaliste
- Ne pas inventer de faits
- Si plusieurs items parlent du même sujet, fusionne-les ; sinon choisis le sujet dominant

Réponds STRICTEMENT en JSON avec EXACTEMENT ces clés :
{
  "title": "...",
  "summary": "..."
}

Items (titres + extraits + liens):
${sources}
`.trim();
}

async function synthesizeOne({ apiKey, version, baseModel, feed }) {
  const { feedTitle, items } = await loadFeed(feed);
  console.log(`[rss] ok ${feed.name}`);

  if (!items.length) {
    return {
      id: stableId(feed.id, "empty"),
      category: feed.category,
      country: feed.country,
      source: feed.name,
      sourcesCount: 0,
      title: `${feedTitle} : aucune actualité récupérée`,
      summary: "Le flux n'a pas renvoyé d'articles exploitables pour le moment.",
      url: feed.url,
      image: null,
      updatedAt: new Date().toISOString(),
      model: null,
    };
  }

  const prompt = buildPrompt({
    category: feed.category,
    feedName: feedTitle,
    country: feed.country,
    items,
  });

  // Chaîne de fallback modèles
  const candidates = [
    baseModel,
    "models/gemini-1.5-flash-latest",
    "models/gemini-1.5-pro-latest",
    "models/gemini-1.5-flash",
    "models/gemini-1.5-pro",
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  let usedModel = candidates[0];
  let text = "";

  for (const m of candidates) {
    try {
      usedModel = m;
      text = await generateContent(apiKey, m, prompt, version);
      if (text) break;
    } catch (e) {
      const msg = String(e.message || e);

      // Modèle introuvable / méthode non supportée => essayer suivant
      if (
        msg.includes("NOT_FOUND") ||
        msg.includes("not found") ||
        msg.includes("not supported") ||
        msg.includes("is not found")
      ) {
        console.warn(`[gemini] model failed (${m}), trying next…`);
        continue;
      }

      // Autre erreur => on remonte
      throw e;
    }
  }

  if (!text) {
    throw new Error("[gemini] empty response after trying model candidates");
  }

  const json = safeJsonExtract(text);
  const title = (json?.title && String(json.title).trim()) || items[0].title || `${feedTitle}: mise à jour`;
  const summary = (json?.summary && String(json.summary).trim()) || "Résumé indisponible.";

  const topImage = items.find((it) => it.image)?.image || null;
  const topUrl = items[0].url;

  return {
    id: stableId(feed.id, topUrl),
    category: feed.category,
    country: feed.country,
    source: feed.name,
    sourcesCount: Math.min(items.length, 6),
    title,
    summary,
    url: topUrl,
    image: topImage,
    updatedAt: new Date().toISOString(),
    model: usedModel,
  };
}

// ---------------------------
// Write JSON
// ---------------------------

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), "utf-8");
  await fs.rename(tmp, file);
}

function groupBy(arr, key) {
  const m = new Map();
  for (const it of arr) {
    const k = it[key] || "other";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

// ---------------------------
// Main
// ---------------------------

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY manquante (GitHub Secrets).");

  const version = (process.env.GEMINI_API_VERSION || "v1").trim();

  await ensureDir(DATA_DIR);

  // On choisit un modèle “base” une fois
  const baseModel = await pickGeminiModel(apiKey, version);

  const results = [];
  for (const feed of FEEDS) {
    try {
      const card = await synthesizeOne({ apiKey, version, baseModel, feed });
      results.push(card);
    } catch (e) {
      console.error(`[feed] failed ${feed.name}: ${e.message}`);
      results.push({
        id: stableId(feed.id, "error"),
        category: feed.category,
        country: feed.country,
        source: feed.name,
        sourcesCount: 0,
        title: `${feed.name}: erreur de génération`,
        summary: "Le flux a été récupéré mais la synthèse a échoué. Nouvelle tentative au prochain cycle.",
        url: feed.url,
        image: null,
        updatedAt: new Date().toISOString(),
        error: String(e.message || e),
        model: null,
      });
    }
  }

  results.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
  });

  await writeJson(path.join(DATA_DIR, "home.json"), {
    generatedAt: new Date().toISOString(),
    count: results.length,
    items: results,
  });

  const byCat = groupBy(results, "category");
  for (const [cat, items] of byCat.entries()) {
    await writeJson(path.join(DATA_DIR, `${cat}.json`), {
      generatedAt: new Date().toISOString(),
      category: cat,
      count: items.length,
      items,
    });
  }

  console.log(`[ingest] wrote data/home.json and ${byCat.size} category files`);
}

await main();