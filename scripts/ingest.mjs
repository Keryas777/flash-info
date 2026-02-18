// scripts/ingest.mjs
// Node 20+ (fetch natif)
// Dépendance: rss-parser
//
// Objectif :
// - Fetch RSS/Atom via fetch natif
// - Parse via rss-parser.parseString(xml) (pas de fetch interne -> pas de undici)
// - Synthèse via Gemini -> FR
// - Écrit data/home.json + data/{categorie}.json
//
// Env :
// - GEMINI_API_KEY (obligatoire)
// - GEMINI_API_VERSION (optionnel, défaut "v1")
// - GEMINI_MODEL (optionnel, ex "models/gemini-2.5-flash")

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Parser from "rss-parser";

const startedAt = new Date().toISOString();
console.log(`[ingest] start ${startedAt}`);

const DATA_DIR = path.resolve("data");

// ⚠️ Catégories JSON actuelles côté repo (d'après tes fichiers data/)
// home.json + monde/economie/sport/tech
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

function toIsoDateMaybe(d) {
  if (!d) return null;
  const t = Date.parse(d);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function pickStr(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return String(v);
}

function clampText(s, n) {
  const t = pickStr(s).trim();
  if (!t) return "";
  return t.length <= n ? t : t.slice(0, n).trimEnd() + "…";
}

function extractImageFromItem(item) {
  // rss-parser expose souvent:
  // - item.enclosure.url
  // - item["media:content"] / ["media:thumbnail"] si customFields
  if (item?.enclosure?.url) return item.enclosure.url;

  const mediaContent = item?.["media:content"];
  if (mediaContent && typeof mediaContent === "object") {
    if (mediaContent.url) return mediaContent.url;
    if (mediaContent.$?.url) return mediaContent.$.url;
  }

  const mediaThumb = item?.["media:thumbnail"];
  if (mediaThumb && typeof mediaThumb === "object") {
    if (mediaThumb.url) return mediaThumb.url;
    if (mediaThumb.$?.url) return mediaThumb.$.url;
  }

  const html =
    item?.["content:encoded"] ||
    item?.content ||
    item?.summary ||
    item?.contentSnippet ||
    "";
  const m = pickStr(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m?.[1]) return m[1];

  return null;
}

// ---------------------------
// Fetch RSS (via fetch natif) + parseString
// ---------------------------

async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "flash-info-bot/1.0 (+github actions)",
        Accept:
          "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7",
      },
    });
    if (!res.ok) throw new Error(`RSS fetch failed ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

const parser = new Parser({
  timeout: 15000,
  customFields: {
    item: ["content:encoded", "media:content", "media:thumbnail", "dc:creator", "creator"],
  },
});

async function loadFeed(feed) {
  const xml = await fetchText(feed.url, 15000);
  const parsed = await parser.parseString(xml);

  const items = (parsed.items || [])
    .map((it) => {
      const title = pickStr(it.title).trim();
      const url = pickStr(it.link).trim();
      const publishedAt =
        toIsoDateMaybe(it.isoDate) ||
        toIsoDateMaybe(it.pubDate) ||
        toIsoDateMaybe(it.published) ||
        null;

      const excerpt =
        stripHtml(it.contentSnippet) ||
        stripHtml(it.summary) ||
        stripHtml(it.content) ||
        stripHtml(it["content:encoded"]) ||
        "";

      const image = extractImageFromItem(it);

      if (!title || !url) return null;

      return { title, url, publishedAt, excerpt, image };
    })
    .filter(Boolean);

  items.sort(
    (a, b) =>
      (Date.parse(b.publishedAt || "") || 0) - (Date.parse(a.publishedAt || "") || 0)
  );

  return { feedTitle: pickStr(parsed.title || feed.name), items };
}

// ---------------------------
// Gemini
// ---------------------------

function geminiBase(version) {
  return `https://generativelanguage.googleapis.com/${version}`;
}

function parseRetryAfterSeconds(headers) {
  // Gemini/Google peut renvoyer Retry-After (secondes)
  const ra = headers?.get?.("retry-after");
  if (!ra) return null;
  const n = Number(ra);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function geminiFetchJson(url, opts, { retries = 3 } = {}) {
  let attempt = 0;

  while (true) {
    attempt++;
    const res = await fetch(url, opts);
    const text = await res.text();

    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Gemini API returned non-JSON: ${text.slice(0, 300)}`);
      }
    }

    // Retry 429 / 503 avec backoff + Retry-After si présent
    if ((res.status === 429 || res.status === 503) && attempt <= retries) {
      const retryAfter = parseRetryAfterSeconds(res.headers);
      const waitMs =
        (retryAfter ? retryAfter * 1000 : 0) ||
        (res.status === 429 ? 2500 * attempt : 2000 * attempt);

      console.warn(`[gemini] ${res.status} retry ${attempt}/${retries} (wait ${Math.round(waitMs)}ms)`);
      await sleep(waitMs);
      continue;
    }

    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }
}

async function generateContent(apiKey, version, modelName, prompt, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const url = `${geminiBase(version)}/${modelName}:generateContent?key=${apiKey}`;

    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 420,
      },
    };

    const data = await geminiFetchJson(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      },
      { retries: 3 }
    );

    const text =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("")?.trim() || "";

    return text;
  } finally {
    clearTimeout(t);
  }
}

// Extraction JSON robuste (balancement d'accolades)
function extractFirstJsonObject(text) {
  const s = pickStr(text);
  const start = s.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;

    if (depth === 0) {
      const candidate = s.slice(start, i + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function buildPrompt({ language, category, feedName, country, items }) {
  const top = items.slice(0, 5);

  const sources = top
    .map((it, idx) => {
      const title = clampText(it.title, 130);
      const excerpt = clampText(it.excerpt, 260);
      return `${idx + 1}. ${title}\n   ${excerpt}\n   ${it.url}`;
    })
    .join("\n\n");

  return `
Tu es un rédacteur de flash info.
Ta mission : synthétiser ces articles en UN sujet principal.

Langue OBLIGATOIRE : ${language} (tout doit être écrit en ${language}, même si les sources sont en anglais).

Contraintes :
- Style neutre, factuel, sans sensationnalisme.
- Ne pas inventer de faits.
- Si les items ne parlent pas du même événement, choisis le sujet dominant.
- Titre court (max ~90 caractères).
- Résumé en 2-3 phrases.
- Remplis aussi 3 sections courtes: "known", "assumed", "unknown" (1-2 phrases chacune).

Réponds STRICTEMENT en JSON valide, avec exactement ces clés :
{
  "title": "...",
  "summary": "...",
  "sections": {
    "known": "...",
    "assumed": "...",
    "unknown": "..."
  }
}

Contexte :
- Catégorie: ${category}
- Source: ${feedName}
- Pays: ${country}

Items :
${sources}
`.trim();
}

function buildRepairPrompt(language, raw) {
  return `
Convertis la réponse ci-dessous en JSON VALIDE (sans texte autour), en ${language}.

Contraintes :
- JSON strict (guillemets doubles, pas de trailing commas)
- Clés EXACTES : title, summary, sections{known,assumed,unknown}
- Pas d'autre clé

Réponse à corriger :
<<<
${raw}
>>>
`.trim();
}

async function runGeminiWithFallback({ apiKey, version, prompt, language }) {
  // Important: ne pas multiplier les modèles en boucle si 429 (ça empire).
  // On garde une liste courte.
  const candidates = [
    (process.env.GEMINI_MODEL || "").trim(),
    "models/gemini-2.5-flash",
    "models/gemini-2.0-flash",
    "models/gemini-1.5-flash-latest",
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  let lastErr = null;

  for (const m of candidates) {
    try {
      let text = await generateContent(apiKey, version, m, prompt, 25000);
      let json = extractFirstJsonObject(text);

      // Repair pass (1 seule fois)
      if (!json) {
        const repairPrompt = buildRepairPrompt(language, text);
        const repaired = await generateContent(apiKey, version, m, repairPrompt, 25000);
        json = extractFirstJsonObject(repaired);
      }

      if (!json) throw new Error("Gemini did not return valid JSON after repair.");

      // Validation minimaliste
      const title = pickStr(json.title).trim();
      const summary = pickStr(json.summary).trim();
      const sections =
        json.sections && typeof json.sections === "object" ? json.sections : {};
      const known = pickStr(sections.known).trim();
      const assumed = pickStr(sections.assumed).trim();
      const unknown = pickStr(sections.unknown).trim();

      if (!title && !summary) throw new Error("Gemini JSON missing title/summary.");

      return {
        usedModel: m,
        title,
        summary,
        sections: {
          known: known || "—",
          assumed: assumed || "—",
          unknown: unknown || "—",
        },
      };
    } catch (e) {
      const msg = String(e?.message || e);
      lastErr = e;

      // Modèle non trouvé/unsupported -> next
      if (
        msg.includes("NOT_FOUND") ||
        msg.toLowerCase().includes("not found") ||
        msg.toLowerCase().includes("not supported")
      ) {
        console.warn(`[gemini] model failed (${m}), trying next.`);
        continue;
      }

      // 429/503/timeout -> on essaie next modèle, mais avec pause pour éviter la rafale
      if (
        msg.includes("429") ||
        msg.includes("503") ||
        msg.toLowerCase().includes("aborted")
      ) {
        console.warn(`[gemini] transient error with (${m}), trying next.`);
        await sleep(2500);
        continue;
      }

      // Autre erreur -> stop
      throw e;
    }
  }

  throw lastErr || new Error("Gemini failed on all fallback models.");
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
// Concurrency limiter
// ---------------------------

function pLimit(limit) {
  const queue = [];
  let active = 0;

  const next = () => {
    active--;
    if (queue.length) queue.shift()();
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      const run = async () => {
        active++;
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        } finally {
          next();
        }
      };
      if (active < limit) run();
      else queue.push(run);
    });
}

// ---------------------------
// Main synth
// ---------------------------

async function synthesizeOne({ apiKey, version, language, feed }) {
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
      sections: { known: "—", assumed: "—", unknown: "—" },
      url: feed.url,
      image: null,
      updatedAt: new Date().toISOString(),
      model: null,
    };
  }

  const prompt = buildPrompt({
    language,
    category: feed.category,
    feedName: feedTitle,
    country: feed.country,
    items,
  });

  const out = await runGeminiWithFallback({
    apiKey,
    version,
    prompt,
    language,
  });

  const title = out.title || items[0].title;
  const summary = out.summary || "Résumé indisponible.";

  const topImage = items.find((it) => it.image)?.image || null;
  const topUrl = items[0].url;

  // Petite pause entre feeds -> évite 429 (crucial)
  await sleep(1500);

  return {
    id: stableId(feed.id, topUrl),
    category: feed.category,
    country: feed.country,
    source: feed.name,
    sourcesCount: Math.min(items.length, 6),
    title,
    summary,
    sections: out.sections || { known: "—", assumed: "—", unknown: "—" },
    url: topUrl,
    image: topImage,
    updatedAt: new Date().toISOString(),
    model: out.usedModel,
  };
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY manquante (GitHub Secrets).");

  const version = (process.env.GEMINI_API_VERSION || "v1").trim();
  const language = "fr";

  await ensureDir(DATA_DIR);

  // ✅ IMPORTANT: Concurrency = 1 pour éviter les 429
  const limit = pLimit(1);

  const tasks = FEEDS.map((feed) =>
    limit(async () => {
      try {
        return await synthesizeOne({ apiKey, version, language, feed });
      } catch (e) {
        console.error(`[feed] failed ${feed.name} (${feed.category}): ${e.message}`);
        return {
          id: stableId(feed.id, "error"),
          category: feed.category,
          country: feed.country,
          source: feed.name,
          sourcesCount: 0,
          title: `${feed.name}: erreur de génération`,
          summary:
            "Le flux a été récupéré mais la synthèse a échoué. Nouvelle tentative au prochain cycle.",
          sections: { known: "—", assumed: "—", unknown: "—" },
          url: feed.url,
          image: null,
          updatedAt: new Date().toISOString(),
          error: String(e.message || e),
          model: null,
        };
      }
    })
  );

  const results = await Promise.all(tasks);

  // tri par date desc
  results.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));

  // home.json
  await writeJson(path.join(DATA_DIR, "home.json"), {
    generatedAt: new Date().toISOString(),
    count: results.length,
    items: results,
  });

  // fichiers par catégorie
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