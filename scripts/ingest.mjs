// scripts/ingest.mjs
// Node 20+
//
// Objectif :
// - Récupérer des flux RSS
// - Pour chaque flux : prendre quelques items récents
// - Appeler Gemini pour synthétiser en 1 "flash"
// - Écrire data/home.json + data/{categorie}.json
//
// Env attendues :
// - GEMINI_API_KEY (obligatoire)
// - GEMINI_API_VERSION (optionnel, défaut "v1")
// - GEMINI_MODEL (optionnel, force un modèle précis)

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { setGlobalDispatcher, Agent } from "undici";

// ✅ Evite que des connexions HTTP keep-alive gardent Node en vie
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
  })
);

let XMLParser;
try {
  const mod = await import("fast-xml-parser");
  XMLParser = mod.XMLParser;
} catch (e) {
  throw new Error(
    "Dépendance manquante: fast-xml-parser. Installe-la avec: npm i fast-xml-parser"
  );
}

const startedAt = new Date().toISOString();
console.log(`[ingest] start ${startedAt}`);

const DATA_DIR = path.resolve("data");

const FEEDS = [
  {
    id: "bbc-world",
    name: "BBC",
    category: "monde",
    country: "GB",
    url: "http://feeds.bbci.co.uk/news/world/rss.xml",
  },
  {
    id: "france24-world",
    name: "France24",
    category: "monde",
    country: "FR",
    url: "https://www.france24.com/fr/rss",
  },
  {
    id: "theverge-tech",
    name: "The Verge",
    category: "tech",
    country: "US",
    url: "https://www.theverge.com/rss/index.xml",
  },
  {
    id: "lemonde-eco",
    name: "Le Monde",
    category: "economie",
    country: "FR",
    url: "https://www.lemonde.fr/economie/rss_full.xml",
  },
  {
    id: "lemonde-sport",
    name: "Le Monde",
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
  return crypto
    .createHash("sha1")
    .update(parts.join("|"))
    .digest("hex")
    .slice(0, 12);
}

function stripHtml(input = "") {
  return String(input)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickFirstText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return pickFirstText(v[0]);
  if (typeof v === "object") {
    if (typeof v["#text"] === "string") return v["#text"];
  }
  return "";
}

function toIsoDateMaybe(d) {
  if (!d) return null;
  const t = Date.parse(d);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function extractImage(item) {
  const media = item["media:content"] || item["media:thumbnail"];
  if (media) {
    const arr = Array.isArray(media) ? media : [media];
    for (const m of arr) {
      const u = m?.["@_url"] || m?.url || m?._url;
      if (u && typeof u === "string") return u;
    }
  }

  const enc = item.enclosure;
  if (enc) {
    const u = enc?.["@_url"] || enc?._url;
    if (u && typeof u === "string") return u;
  }

  const img = item.image?.url || item.image?.href;
  if (img && typeof img === "string") return img;

  const content = pickFirstText(item.description) || pickFirstText(item.content);
  const m = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m?.[1]) return m[1];

  return null;
}

// ---------------------------
// RSS fetch & parse
// ---------------------------

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "flash-info-bot/1.0 (+github actions)",
      Accept:
        "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7",
      Connection: "close",
    },
  });
  if (!res.ok) {
    throw new Error(`RSS fetch failed ${res.status} for ${url}`);
  }
  return await res.text();
}

function parseFeed(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    allowBooleanAttributes: true,
    parseTagValue: true,
    trimValues: true,
  });

  const doc = parser.parse(xml);

  if (doc?.rss?.channel) {
    const channel = doc.rss.channel;
    const items = channel.item
      ? Array.isArray(channel.item)
        ? channel.item
        : [channel.item]
      : [];
    return {
      title: pickFirstText(channel.title),
      items,
      type: "rss",
    };
  }

  if (doc?.feed) {
    const feed = doc.feed;
    const entries = feed.entry
      ? Array.isArray(feed.entry)
        ? feed.entry
        : [feed.entry]
      : [];
    return {
      title: pickFirstText(feed.title),
      items: entries,
      type: "atom",
    };
  }

  return { title: "", items: [], type: "unknown" };
}

function normalizeItems(rawItems, type) {
  const out = [];

  for (const it of rawItems) {
    if (type === "rss") {
      const title = pickFirstText(it.title);
      const link = pickFirstText(it.link);
      const pubDate =
        toIsoDateMaybe(pickFirstText(it.pubDate)) ||
        toIsoDateMaybe(pickFirstText(it["dc:date"]));
      const description = stripHtml(pickFirstText(it.description));
      const image = extractImage(it);

      if (!title || !link) continue;

      out.push({
        title,
        url: link,
        publishedAt: pubDate,
        excerpt: description,
        image,
      });
      continue;
    }

    if (type === "atom") {
      const title = pickFirstText(it.title);
      let link = "";
      if (it.link) {
        const links = Array.isArray(it.link) ? it.link : [it.link];
        const alt =
          links.find((l) => (l?.["@_rel"] || "alternate") === "alternate") ||
          links[0];
        link = alt?.["@_href"] || alt?.href || "";
      }
      const pubDate =
        toIsoDateMaybe(pickFirstText(it.published)) ||
        toIsoDateMaybe(pickFirstText(it.updated));
      const summary = stripHtml(pickFirstText(it.summary));
      const content = stripHtml(pickFirstText(it.content));
      const image = extractImage(it);

      if (!title || !link) continue;

      out.push({
        title,
        url: link,
        publishedAt: pubDate,
        excerpt: summary || content,
        image,
      });
      continue;
    }
  }

  out.sort(
    (a, b) =>
      (Date.parse(b.publishedAt || "") || 0) -
      (Date.parse(a.publishedAt || "") || 0)
  );

  return out;
}

async function loadFeed(feed) {
  const xml = await fetchText(feed.url);
  const parsed = parseFeed(xml);
  const items = normalizeItems(parsed.items, parsed.type);

  return {
    feedTitle: parsed.title || feed.name,
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
    const res = await fetch(url, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        Connection: "close",
      },
    });

    const text = await res.text();

    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Gemini JSON parse error: ${text}`);
      }
    }

    if (res.status === 503 && attempt < retries) {
      console.warn(`[gemini] 503 unavailable, retry ${attempt}/${retries}`);
      await sleep(3000);
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
    console.warn(
      `[gemini] listModels failed, fallback to known models. reason: ${e.message}`
    );
  }

  const fallback = [
    "models/gemini-2.5-flash",
    "models/gemini-2.0-flash",
    "models/gemini-1.5-flash-latest",
    "models/gemini-1.5-pro-latest",
    "models/gemini-1.5-flash",
    "models/gemini-1.5-pro",
  ];

  console.log(`[gemini] fallback model candidate: ${fallback[0]}`);
  return fallback[0];
}

async function generateContent(apiKey, modelName, prompt, version = "v1") {
  const url = `${geminiBase(version)}/${modelName}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
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
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text)
      .join("")
      ?.trim() || "";

  return text;
}

function safeJsonExtract(text) {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const slice = text.slice(firstBrace, lastBrace + 1);
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
      const title = it.title;
      const excerpt = it.excerpt ? it.excerpt.slice(0, 260) : "";
      const url = it.url;
      return `${idx + 1}. ${title}\n   ${excerpt}\n   ${url}`;
    })
    .join("\n\n");

  return `
Tu es un rédacteur de flash info.
Tu dois produire UN seul "flash" synthétique, clair, court et utile.

Contexte:
- Catégorie: ${category}
- Source principale: ${feedName}
- Pays: ${country}

Contraintes:
- Le titre doit être court et percutant (max ~90 caractères).
- Le résumé doit faire 2 à 3 phrases (pas plus).
- Style neutre, pas sensationnaliste.
- Ne pas inventer des faits.
- Si les items semblent parler d'un même sujet, fusionne-les. Sinon, choisis le sujet dominant.

Tu dois répondre STRICTEMENT en JSON, avec exactement ces clés :
{
  "title": "...",
  "summary": "..."
}

Voici les items (titres + extraits + liens):
${sources}
`.trim();
}

async function synthesizeOne({ apiKey, version, modelName, feed }) {
  const { feedTitle, items } = await loadFeed(feed);

  console.log(`[rss] ok ${feed.name} (${feed.category})`);

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
    };
  }

  const prompt = buildPrompt({
    category: feed.category,
    feedName: feedTitle,
    country: feed.country,
    items,
  });

  const fallbackModels = [
    modelName,
    "models/gemini-2.5-flash",
    "models/gemini-2.0-flash",
    "models/gemini-1.5-flash-latest",
    "models/gemini-1.5-pro-latest",
    "models/gemini-1.5-flash",
    "models/gemini-1.5-pro",
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  let text = "";
  let usedModel = fallbackModels[0];

  for (const m of fallbackModels) {
    try {
      usedModel = m;
      text = await generateContent(apiKey, m, prompt, version);
      if (text) break;
    } catch (e) {
      const msg = String(e.message || e);

      if (
        msg.includes("NOT_FOUND") ||
        msg.includes("not found") ||
        msg.includes("not supported")
      ) {
        console.warn(
          `[gemini] model failed (${m}), trying next. reason: ${msg.slice(0, 180)}`
        );
        continue;
      }

      throw e;
    }
  }

  if (!text) {
    throw new Error("[gemini] empty response after trying fallback models");
  }

  const json = safeJsonExtract(text);
  const title =
    (json?.title && String(json.title).trim()) ||
    items[0].title ||
    `${feedTitle}: mise à jour`;
  const summary =
    (json?.summary && String(json.summary).trim()) || "Résumé indisponible.";

  const topImage = items.find((it) => it.image)?.image || null;
  const topUrl = items[0].url;

  return {
    id: stableId(feed.id, items[0].url),
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

  const modelName = await pickGeminiModel(apiKey, version);

  const results = [];

  for (const feed of FEEDS) {
    try {
      const card = await synthesizeOne({ apiKey, version, modelName, feed });
      results.push(card);
    } catch (e) {
      console.error(`[feed] failed ${feed.name} (${feed.category}): ${e.message}`);

      results.push({
        id: stableId(feed.id, "error"),
        category: feed.category,
        country: feed.country,
        source: feed.name,
        sourcesCount: 0,
        title: `${feed.name}: erreur de génération`,
        summary:
          "Le flux a été récupéré mais la synthèse a échoué. Nouvelle tentative au prochain cycle.",
        url: feed.url,
        image: null,
        updatedAt: new Date().toISOString(),
        error: String(e.message || e),
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

// ✅ Exit propre + évite les runs qui “tournent dans le vide”
process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandledRejection:", err);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
  process.exit(1);
});

try {
  await main();
  setTimeout(() => process.exit(0), 50);
} catch (err) {
  console.error("[fatal] main failed:", err);
  process.exit(1);
}