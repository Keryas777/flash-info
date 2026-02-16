// scripts/ingest.mjs
import { mkdir, writeFile } from "node:fs/promises";

/**
 * Flash Info - Ingest RSS -> synthèse Gemini -> data/*.json
 * - Auto-select Gemini model via ListModels
 * - Works on GitHub Actions (Node 20+)
 */

const log = (...a) => console.log(...a);

const ISO = () => new Date().toISOString();
const now = new Date();

const DATA_DIR = "data";

// ---------------------------------------------
// 1) Config RSS (à adapter quand tu voudras)
// ---------------------------------------------
const FEEDS = [
  // Monde
  {
    name: "BBC",
    section: "monde",
    country: "GB",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    emoji: "🌍",
  },
  {
    name: "France24",
    section: "monde",
    country: "FR",
    url: "https://www.france24.com/fr/rss",
    emoji: "🌍",
  },

  // Tech
  {
    name: "The Verge",
    section: "tech",
    country: "US",
    url: "https://www.theverge.com/rss/index.xml",
    emoji: "💻",
  },

  // Économie / Sport (exemples)
  {
    name: "Le Monde (Éco)",
    section: "economie",
    country: "FR",
    url: "https://www.lemonde.fr/economie/rss_full.xml",
    emoji: "💼",
  },
  {
    name: "Le Monde (Sport)",
    section: "sport",
    country: "FR",
    url: "https://www.lemonde.fr/sport/rss_full.xml",
    emoji: "⚽️",
  },
];

// ---------------------------------------------
// 2) Gemini: listModels + pickModel + generate
// ---------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || "v1"; // IMPORTANT: v1 (pas v1beta)

if (!GEMINI_API_KEY) {
  throw new Error("Missing GEMINI_API_KEY (GitHub Secrets).");
}

async function listModels(apiKey, apiVersion) {
  const url = `https://generativelanguage.googleapis.com/${apiVersion}/models?key=${apiKey}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`ListModels error ${res.status}: ${JSON.stringify(json)}`);
  }
  return json.models || [];
}

function pickModel(models) {
  const usable = models.filter((m) =>
    (m.supportedGenerationMethods || []).includes("generateContent")
  );

  // Ordre de préférence (on prend le premier trouvé)
  const preferredKeys = [
    "gemini-2.0-flash",
    "gemini-2.0",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "flash",
    "pro",
  ];

  for (const key of preferredKeys) {
    const found = usable.find((m) => (m.name || "").includes(key));
    if (found?.name) return found.name; // ex: "models/gemini-1.5-flash"
  }

  if (usable[0]?.name) return usable[0].name;
  throw new Error("No Gemini model supports generateContent (ListModels empty).");
}

async function geminiGenerateContent({ apiKey, apiVersion, modelName, prompt }) {
  const url = `https://generativelanguage.googleapis.com/${apiVersion}/${modelName}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.4,
      topP: 0.9,
      maxOutputTokens: 900,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      `Gemini API error ${res.status}: ${JSON.stringify(json, null, 2)}`
    );
  }

  const text =
    json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

  return { raw: json, text };
}

function safeJsonFromText(text) {
  // Gemini peut renvoyer du texte autour d’un JSON.
  // On tente d’extraire le premier objet JSON.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  const slice = text.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

// ---------------------------------------------
// 3) RSS fetch + parse
// ---------------------------------------------
async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "flash-info-bot/1.0 (+github-actions)",
      "Accept": "application/rss+xml, application/xml, text/xml, */*",
    },
  });
  if (!res.ok) throw new Error(`Fetch ${url} failed: ${res.status}`);
  return await res.text();
}

async function parseRss(xml) {
  // Try fast-xml-parser if installed
  let FXP = null;
  try {
    const mod = await import("fast-xml-parser");
    FXP = mod?.XMLParser ? mod : null;
  } catch {
    FXP = null;
  }

  if (FXP?.XMLParser) {
    const parser = new FXP.XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
    });
    const obj = parser.parse(xml);

    // RSS2: rss.channel.item
    const channel = obj?.rss?.channel;
    if (channel?.item) {
      const items = Array.isArray(channel.item) ? channel.item : [channel.item];
      return items.map(normalizeRssItem);
    }

    // Atom: feed.entry
    const entries = obj?.feed?.entry;
    if (entries) {
      const arr = Array.isArray(entries) ? entries : [entries];
      return arr.map(normalizeAtomEntry);
    }
  }

  // Fallback ultra-simple (regex) : prend <item>...</item>
  const items = [];
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = pickTag(block, "title");
    const link = pickTag(block, "link");
    const pubDate = pickTag(block, "pubDate");
    const description = pickTag(block, "description") || pickTag(block, "content:encoded");
    items.push({
      title: cleanText(title),
      link: cleanText(link),
      pubDate: cleanText(pubDate),
      description: cleanText(description),
    });
  }
  return items;
}

function normalizeRssItem(it) {
  return {
    title: cleanText(it?.title),
    link: cleanText(it?.link),
    pubDate: cleanText(it?.pubDate),
    description: cleanText(it?.description || it?.["content:encoded"]),
  };
}

function normalizeAtomEntry(e) {
  const link =
    typeof e?.link === "string"
      ? e.link
      : Array.isArray(e?.link)
      ? e.link.find((l) => l.rel === "alternate")?.href || e.link[0]?.href
      : e?.link?.href;

  return {
    title: cleanText(e?.title),
    link: cleanText(link),
    pubDate: cleanText(e?.updated || e?.published),
    description: cleanText(e?.summary || e?.content),
  };
}

function pickTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1] : "";
}

function cleanText(s) {
  if (!s) return "";
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDateSafe(s) {
  const d = s ? new Date(s) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}

// ---------------------------------------------
// 4) Synthèse “article” par section
// ---------------------------------------------
function buildSynthesisPrompt(section, items) {
  // On donne titres + snippets + liens pour que Gemini regroupe
  const lines = items.slice(0, 8).map((it, i) => {
    return `${i + 1}. ${it.title}\n   Source: ${it.sourceName}\n   Lien: ${
      it.link
    }\n   Extrait: ${it.description || "(vide)"}\n`;
  });

  return `
Tu es un rédacteur en chef. Tu dois regrouper plusieurs brèves qui parlent du même sujet en UN article synthèse.

Contraintes:
- Langue: FR
- Ne pas inventer de faits.
- Si les sources sont trop différentes, fais plutôt une synthèse multi-points (2 à 4 points).
- Style: clair, mobile-first.
- Donne une sortie STRICTEMENT au format JSON, sans texte autour.

Format JSON attendu:
{
  "title": "Titre très court et impactant",
  "summary": "Résumé en 2 phrases max",
  "body": "Texte synthèse (5 à 12 lignes)",
  "key_points": ["...", "...", "..."],
  "sources": [
    {"name":"...", "url":"..."},
    {"name":"...", "url":"..."}
  ]
}

SECTION: ${section.toUpperCase()}

SOURCES:
${lines.join("\n")}
`.trim();
}

// ---------------------------------------------
// 5) Main
// ---------------------------------------------
async function main() {
  log(`[ingest] start ${ISO()}`);

  // Gemini model auto-select
  const models = await listModels(GEMINI_API_KEY, GEMINI_API_VERSION);
  const MODEL_NAME = pickModel(models);
  log(`[gemini] using ${MODEL_NAME} (${GEMINI_API_VERSION})`);

  // Fetch all feeds
  const allItems = [];
  for (const feed of FEEDS) {
    try {
      const xml = await fetchText(feed.url);
      const items = await parseRss(xml);

      // Normalize with feed metadata
      const normalized = items
        .map((it) => {
          const d = parseDateSafe(it.pubDate);
          return {
            id: stableId(feed.name, it.link || it.title),
            section: feed.section,
            country: feed.country,
            sourceName: feed.name,
            title: it.title,
            link: it.link,
            description: it.description,
            publishedAt: d ? d.toISOString() : null,
            // placeholder image: l’app affichera une photo plus tard;
            // si pas d'image, l’app peut fallback emoji
            imageUrl: null,
            emojiFallback: feed.emoji,
          };
        })
        .filter((x) => x.title && x.link);

      // Optional filter: recent (48h)
      const recent = normalized.filter((x) => {
        if (!x.publishedAt) return true;
        const d = new Date(x.publishedAt);
        return now - d < 48 * 3600 * 1000;
      });

      allItems.push(...recent);
      log(`[rss] ok ${feed.name} (${feed.section})`);
    } catch (e) {
      log(`[rss] fail ${feed.name} (${feed.section}) -> ${e.message}`);
    }
  }

  // Sort by date desc (null last)
  allItems.sort((a, b) => {
    const ad = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bd = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return bd - ad;
  });

  // Build flashes: simple headline list (top 25)
  const flashes = allItems.slice(0, 25).map((it) => ({
    id: it.id,
    section: it.section,
    country: it.country,
    title: it.title,
    sourceName: it.sourceName,
    link: it.link,
    publishedAt: it.publishedAt,
    emojiFallback: it.emojiFallback,
    imageUrl: it.imageUrl,
  }));

  // Build synthesized articles per section (top items per section)
  const sections = [...new Set(allItems.map((x) => x.section))];
  const synthesized = [];

  for (const section of sections) {
    const items = allItems.filter((x) => x.section === section).slice(0, 8);
    if (items.length < 2) continue;

    const prompt = buildSynthesisPrompt(section, items);
    const { text } = await geminiGenerateContent({
      apiKey: GEMINI_API_KEY,
      apiVersion: GEMINI_API_VERSION,
      modelName: MODEL_NAME,
      prompt,
    });

    const json = safeJsonFromText(text);
    if (!json?.title || !json?.body) {
      log(`[gemini] warn: bad json for section ${section}, fallback minimal`);
      synthesized.push({
        id: stableId("synth", section + ":" + ISO()),
        section,
        title: items[0]?.title || `Synthèse ${section}`,
        summary: items[0]?.description?.slice(0, 160) || "",
        body: items.map((x) => `• ${x.title}`).join("\n"),
        key_points: items.slice(0, 4).map((x) => x.title),
        sources: items.slice(0, 6).map((x) => ({ name: x.sourceName, url: x.link })),
        updatedAt: ISO(),
      });
      continue;
    }

    synthesized.push({
      id: stableId("synth", section + ":" + ISO()),
      section,
      title: String(json.title).trim(),
      summary: String(json.summary || "").trim(),
      body: String(json.body).trim(),
      key_points: Array.isArray(json.key_points) ? json.key_points.slice(0, 6) : [],
      sources: Array.isArray(json.sources) ? json.sources.slice(0, 8) : [],
      updatedAt: ISO(),
    });

    log(`[gemini] ok synth ${section}`);
  }

  // Write outputs
  await mkdir(DATA_DIR, { recursive: true });

  await writeFile(
    `${DATA_DIR}/flashes.json`,
    JSON.stringify(
      {
        updatedAt: ISO(),
        count: flashes.length,
        items: flashes,
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    `${DATA_DIR}/items.json`,
    JSON.stringify(
      {
        updatedAt: ISO(),
        count: allItems.length,
        items: allItems.slice(0, 200),
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    `${DATA_DIR}/articles.json`,
    JSON.stringify(
      {
        updatedAt: ISO(),
        count: synthesized.length,
        items: synthesized,
      },
      null,
      2
    ),
    "utf8"
  );

  log(`[ingest] done -> data/flashes.json, data/items.json, data/articles.json`);
}

function stableId(prefix, seed) {
  // hash léger sans dépendances
  const s = `${prefix}:${seed}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${prefix}_${(h >>> 0).toString(16)}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});