import fs from "node:fs";
import path from "node:path";
import type { StubPromptResponse } from "@specregistry/shared";
import { fetchJson, selectProjectType } from "./registry.js";
import { scanDirectory } from "./scan.js";

export interface GenerateOptions {
  server: string;
  type?: string;
  out: string;
}

export async function runGenerate(opts: GenerateOptions): Promise<void> {
  const root = process.cwd();
  console.log(`Scanning ${root} ...`);
  const scan = scanDirectory(root);
  console.log(
    `Found ${scan.fileCount} files. Detected languages: ${scan.languages.join(", ") || "(none)"}`
  );

  const projectType = await selectProjectType(opts.server, opts.type);
  const response = await fetchJson<StubPromptResponse>(`${opts.server}/api/v1/cli/stub-prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_type: projectType.name,
      detected_languages: scan.languages,
    }),
  });

  const outDir = path.resolve(root, opts.out);
  fs.mkdirSync(outDir, { recursive: true });

  const written: string[] = [];
  for (const stub of response.prompts) {
    // The server tailors [PROJECT_TYPE]/[LANGUAGES]; the local scan fills [TREE]/[CONTEXT].
    const prompt = stub.prompt.replaceAll("[TREE]", scan.tree).replaceAll("[CONTEXT]", scan.tree);
    const file = path.join(outDir, `${stub.target_filename}.prompt.txt`);
    fs.writeFileSync(file, prompt, "utf8");
    written.push(file);
  }

  console.log(`\nWrote ${written.length} generation prompt(s):`);
  for (const file of written) {
    console.log(`  - ${path.relative(root, file)}`);
  }
  console.log(
    `\nNext step: run each prompt through your AI agent to produce the corresponding spec file,\nthen submit it to the registry for review.`
  );
}
