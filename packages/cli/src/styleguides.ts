import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { GOOGLE_STYLE_GUIDES, styleGuidesForLanguages, type StyleGuideEntry } from "./styleguideCatalog.js";
import { scanDirectory } from "./scan.js";

export { GOOGLE_STYLE_GUIDES } from "./styleguideCatalog.js";

const ALL_LANGUAGES = [...new Set(GOOGLE_STYLE_GUIDES.flatMap((g) => g.languages))];

/** `specreg styleguide list [--language X]` — show the pullable catalog. */
export function runStyleguideList(opts: { language?: string }): void {
  const entries = opts.language ? styleGuidesForLanguages([opts.language]) : GOOGLE_STYLE_GUIDES;
  if (entries.length === 0) {
    console.log(`No styleguide available for "${opts.language}".`);
    console.log(`Covered languages: ${ALL_LANGUAGES.join(", ")}`);
    return;
  }
  console.log("Available styleguides (pull with `specreg styleguide add <id>`):\n");
  for (const g of entries) {
    console.log(`  ${g.id.padEnd(12)} ${g.languages.join(", ").padEnd(16)} ${g.title}`);
  }
}

/** `specreg styleguide add <id|language>` — pull one styleguide on demand. */
export async function runStyleguideAdd(token: string, opts: { dir: string; force?: boolean }): Promise<void> {
  const normalized = token.trim().toLowerCase();
  const entry = GOOGLE_STYLE_GUIDES.find((g) => g.id === normalized) ?? styleGuidesForLanguages([token])[0];
  if (!entry) {
    throw new Error(
      `No styleguide for "${token}". Available ids: ${GOOGLE_STYLE_GUIDES.map((g) => g.id).join(", ")} ` +
        `(or pass a covered language: ${ALL_LANGUAGES.join(", ")}).`
    );
  }
  await installGoogleStyleGuides({ selection: entry.id, dir: opts.dir, force: opts.force });
}

export interface StyleGuideInstallOptions {
  selection?: string;
  dir: string;
  force?: boolean;
  suggestedLanguages?: string[];
}

export interface InstalledStyleGuide {
  id: string;
  title: string;
  path: string;
  sources: string[];
}

export async function installGoogleStyleGuides(opts: StyleGuideInstallOptions): Promise<InstalledStyleGuide[]> {
  const scan = scanDirectory(process.cwd(), 5, 80);
  const detectedLanguages = [...new Set([...scan.languages, ...(opts.suggestedLanguages ?? [])])];
  const suggested = suggestedGuideIds(detectedLanguages);
  const selected = await resolveSelection(opts.selection, suggested);
  if (selected.length === 0) {
    console.log("\nNo Google style guides selected.");
    return [];
  }

  const outDir = path.resolve(process.cwd(), opts.dir);
  fs.mkdirSync(outDir, { recursive: true });

  const installed: InstalledStyleGuide[] = [];
  const fetchedAt = new Date().toISOString();
  for (const guide of selected) {
    const target = path.join(outDir, guide.filename);
    if (fs.existsSync(target) && !opts.force) {
      console.log(`Skipping ${guide.title}; ${path.relative(process.cwd(), target)} already exists. Use --force to refresh.`);
      installed.push({
        id: guide.id,
        title: guide.title,
        path: path.relative(process.cwd(), target),
        sources: guide.sources.map((source) => source.url),
      });
      continue;
    }

    const sections: string[] = [
      `# ${guide.title}`,
      "",
      "> Fetched from Google's public style guides during `specreg init`.",
      "> License: CC BY 3.0, as stated by Google Style Guides.",
      `> Fetched at: ${fetchedAt}`,
      "",
    ];
    for (const source of guide.sources) {
      const res = await fetch(source.url);
      if (!res.ok) throw new Error(`Could not fetch ${source.url}: ${res.status} ${res.statusText}`);
      const body = await res.text();
      const markdown = toMarkdown(body, res.headers.get("content-type") ?? "", source.url);
      sections.push(`## ${source.title}`, "", `Source: ${source.url}`, "", markdown.trim(), "");
    }
    fs.writeFileSync(target, sections.join("\n").replace(/\n{4,}/g, "\n\n\n") + "\n", "utf8");
    installed.push({
      id: guide.id,
      title: guide.title,
      path: path.relative(process.cwd(), target),
      sources: guide.sources.map((source) => source.url),
    });
  }

  const manifestPath = path.join(outDir, "google-styleguides.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        provider: "google-styleguide",
        fetched_at: fetchedAt,
        detected_languages: detectedLanguages,
        selected: installed,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`\nInstalled ${installed.length} Google style guide(s) to ${path.relative(process.cwd(), outDir) || "."}/:`);
  for (const guide of installed) console.log(`  - ${guide.path}`);
  console.log(`Manifest saved as ${path.relative(process.cwd(), manifestPath)}.`);
  return installed;
}

function suggestedGuideIds(languages: string[]): Set<string> {
  const langs = new Set(languages);
  const suggested = new Set<string>(["docguide"]);
  for (const guide of GOOGLE_STYLE_GUIDES) {
    if (guide.id === "docguide") continue;
    if (guide.languages.some((lang) => langs.has(lang))) suggested.add(guide.id);
  }
  return suggested;
}

async function resolveSelection(selection: string | undefined, suggested: Set<string>): Promise<StyleGuideEntry[]> {
  const normalized = selection?.trim().toLowerCase();
  if (normalized === "none" || normalized === "off" || normalized === "false") return [];
  if (normalized === "all") return GOOGLE_STYLE_GUIDES;
  if (normalized && normalized !== "suggested") return guidesFromTokens(normalized.split(","));
  if (normalized === "suggested" || !process.stdin.isTTY) {
    return GOOGLE_STYLE_GUIDES.filter((guide) => suggested.has(guide.id));
  }

  console.log("\nGoogle style guides for this project:\n");
  GOOGLE_STYLE_GUIDES.forEach((guide, index) => {
    const marker = suggested.has(guide.id) ? "*" : " ";
    const langs = guide.languages.length ? ` (${guide.languages.join(", ")})` : "";
    console.log(` ${marker} ${index + 1}. ${guide.id}${langs} - ${guide.title}`);
  });
  console.log("\nSuggested guides are marked with *.");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await rl.question(
        "Select Google style guides [Enter=suggested, comma numbers/ids, all, none]: "
      );
      const trimmed = answer.trim().toLowerCase();
      if (!trimmed) return GOOGLE_STYLE_GUIDES.filter((guide) => suggested.has(guide.id));
      if (trimmed === "none") return [];
      if (trimmed === "all") return GOOGLE_STYLE_GUIDES;
      try {
        return guidesFromTokens(trimmed.split(","));
      } catch (err) {
        console.log(err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    rl.close();
  }
}

function guidesFromTokens(tokens: string[]): StyleGuideEntry[] {
  const selected: StyleGuideEntry[] = [];
  for (const token of tokens.map((value) => value.trim()).filter(Boolean)) {
    const byIndex = Number(token);
    const guide = Number.isInteger(byIndex)
      ? GOOGLE_STYLE_GUIDES[byIndex - 1]
      : GOOGLE_STYLE_GUIDES.find((entry) => entry.id === token);
    if (!guide) throw new Error(`Unknown Google style guide "${token}". Use: ${GOOGLE_STYLE_GUIDES.map((entry) => entry.id).join(", ")}`);
    if (!selected.includes(guide)) selected.push(guide);
  }
  return selected;
}

function toMarkdown(body: string, contentType: string, sourceUrl: string): string {
  const lower = contentType.toLowerCase();
  if (!lower.includes("html") && !sourceUrl.endsWith(".html") && !sourceUrl.endsWith("/")) {
    if (sourceUrl.endsWith(".xml")) return xmlToMarkdown(body);
    return body;
  }
  return htmlToMarkdown(body);
}

function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(main|article|body)[^>]*>/gi, "\n")
    .replace(/<h1[^>]*>/gi, "\n# ")
    .replace(/<h2[^>]*>/gi, "\n## ")
    .replace(/<h3[^>]*>/gi, "\n### ")
    .replace(/<h4[^>]*>/gi, "\n#### ")
    .replace(/<h5[^>]*>/gi, "\n##### ")
    .replace(/<h6[^>]*>/gi, "\n###### ")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|tr|table|ul|ol|pre)>/gi, "\n\n")
    .replace(/<td[^>]*>/gi, " | ")
    .replace(/<th[^>]*>/gi, " | ")
    .replace(/<\/(td|th)>/gi, " ")
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, label) => `[${stripTags(label)}](${href})`)
    .replace(/<code[^>]*>/gi, "`")
    .replace(/<\/code>/gi, "`")
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function xmlToMarkdown(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]+>/g, " ")).replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "-",
    mdash: "-",
    rsquo: "'",
    lsquo: "'",
    rdquo: '"',
    ldquo: '"',
  };
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}
