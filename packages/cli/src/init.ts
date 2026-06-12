import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { selectProjectType } from "./registry.js";

export interface InitOptions {
  server: string;
  type?: string;
  dir: string;
}

export async function runInit(opts: InitOptions): Promise<void> {
  const projectType = await selectProjectType(opts.server, opts.type);
  console.log(`\nFetching latest approved specs for "${projectType.name}"...`);

  const url = `${opts.server}/api/v1/specs/${encodeURIComponent(projectType.name)}/download`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));

  const outDir = path.resolve(process.cwd(), opts.dir);
  fs.mkdirSync(outDir, { recursive: true });
  zip.extractAllTo(outDir, true);

  const entries = zip.getEntries().filter((e) => e.entryName !== ".specregistry.json");
  console.log(`\nWrote ${entries.length} spec file(s) to ${path.relative(process.cwd(), outDir) || "."}/:`);
  for (const entry of entries) {
    console.log(`  - ${entry.entryName}`);
  }
  console.log(`\nManifest saved as ${opts.dir}/.specregistry.json (records versions for future syncs).`);
}
