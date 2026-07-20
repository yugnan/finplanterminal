// Fetch RSS dari media non-pemerintah, resume tiap artikel, lalu tulis ke
// data/media-news.json. Dijalankan harian lewat GitHub Actions
// (lihat .github/workflows/daily-news.yml) — bisa juga dijalankan manual:
//   ANTHROPIC_API_KEY=sk-... node scripts/fetch-news.mjs
// Tanpa ANTHROPIC_API_KEY, resume jatuh ke cuplikan RSS apa adanya (dipotong).

import Parser from "rss-parser";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "..", "data", "media-news.json");

// Sumber RSS non-pemerintah. Cek ulang URL secara berkala — media Indonesia
// sering mengubah struktur feed. Tambah/hapus sumber di sini saja.
const SOURCES = [
  { name: "Kontan", url: "https://www.kontan.co.id/rss" },
  { name: "Bisnis.com", url: "https://www.bisnis.com/rss" },
  { name: "CNBC Indonesia", url: "https://www.cnbcindonesia.com/rss" },
  { name: "Detik Finance", url: "https://finance.detik.com/rss" },
  { name: "Kompas Ekonomi", url: "https://ekonomi.kompas.com/rss" },
  { name: "Katadata", url: "https://katadata.co.id/feed" },
  { name: "Liputan6 Bisnis", url: "https://www.liputan6.com/bisnis/rss" },
];

// Sinkron manual dengan `sectorEmiten` di terminal/index.html.
const SECTOR_KEYWORDS = {
  perbankan: ["bank", "perbankan", "kredit", "kpr", "bunga acuan", "bi rate", "bbca", "bbri", "bmri", "bbni", "ojk"],
  properti: ["properti", "rumah", "apartemen", "ctra", "pwon", "bsde", "smra"],
  energi: ["batu bara", "minyak", "gas", "energi", "tambang", "pgas", "ptba", "adro", "medc", "itmg"],
  "consumer goods": ["consumer goods", "fmcg", "makanan", "minuman", "ritel", "icbp", "unvr", "indf", "myor", "inflasi", "daya beli"],
  otomotif: ["mobil", "otomotif", "kendaraan", "gaikindo", "asii", "auto", "imas"],
  infrastruktur: ["infrastruktur", "tol", "konstruksi", "jsmr", "wika", "wskt"],
};

const FRESHNESS_HOURS = 48; // hanya ambil artikel dalam N jam terakhir
const MAX_PER_SOURCE = 6;
const MAX_TOTAL = 25;
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function detectSectors(text) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    const matched = keywords.some((kw) =>
      kw.length <= 5 ? new RegExp(`\\b${kw}\\b`, "i").test(text) : lower.includes(kw.toLowerCase())
    );
    if (matched) hits.push(sector);
  }
  return hits;
}

function fallbackBody(snippet, title) {
  const base = snippet || title;
  return base.length > 220 ? base.slice(0, 217).trimEnd() + "..." : base;
}

function toDateOnly(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

async function summarizeWithClaude(title, snippet) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content:
            `Ringkas berita finansial berikut jadi 1-2 kalimat bahasa Indonesia yang jelas dan netral, ` +
            `tanpa markdown, tanpa mengulang judul persis kata demi kata.\n\n` +
            `Judul: "${title}"\nCuplikan: "${snippet}"`,
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || null;
}

function dedupeByLink(items) {
  const seen = new Set();
  return items.filter((it) => {
    if (seen.has(it.sourceUrl)) return false;
    seen.add(it.sourceUrl);
    return true;
  });
}

async function main() {
  const parser = new Parser({ timeout: 15000 });
  const cutoff = Date.now() - FRESHNESS_HOURS * 3600 * 1000;
  const results = [];

  for (const src of SOURCES) {
    try {
      const feed = await parser.parseURL(src.url);
      const items = (feed.items || [])
        .filter((it) => {
          const raw = it.isoDate || it.pubDate;
          const t = raw ? Date.parse(raw) : NaN;
          return !Number.isNaN(t) && t >= cutoff;
        })
        .slice(0, MAX_PER_SOURCE);

      for (const it of items) {
        const title = (it.title || "").trim();
        if (!title || !it.link) continue;
        const snippet = stripHtml(it.contentSnippet || it.content || it.summary || "");

        let body;
        try {
          body = (await summarizeWithClaude(title, snippet)) || fallbackBody(snippet, title);
        } catch (err) {
          console.warn(`  Gagal resume via Claude (${src.name}): ${err.message}`);
          body = fallbackBody(snippet, title);
        }

        results.push({
          date: toDateOnly(it.isoDate || it.pubDate),
          source: src.name,
          sourceUrl: it.link,
          headline: title,
          body,
          sectors: detectSectors(`${title} ${snippet}`),
        });
      }
      console.log(`${src.name}: ${items.length} artikel dalam ${FRESHNESS_HOURS} jam terakhir`);
    } catch (err) {
      console.warn(`Gagal fetch RSS ${src.name} (${src.url}): ${err.message}`);
    }
  }

  const capped = dedupeByLink(results.sort((a, b) => new Date(b.date) - new Date(a.date))).slice(0, MAX_TOTAL);

  const output = { updated_at: new Date().toISOString(), items: capped };
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");
  console.log(`\nSelesai. ${capped.length} artikel ditulis ke ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

main().catch((err) => {
  console.error("Fetch news gagal total:", err);
  process.exit(1);
});
