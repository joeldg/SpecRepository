import fs from "node:fs";
import path from "node:path";
import type { ChangeRequest, Spec } from "@specregistry/shared";
import { fetchJson, selectProjectType, specsForProjectType } from "./registry.js";

export interface SubmitDraftsOptions {
  server: string;
  token?: string;
  type?: string;
  dir: string;
  author: string;
  delta: "major" | "minor" | "patch";
  publish: boolean;
  force: boolean;
}

export async function runSubmitDrafts(opts: SubmitDraftsOptions): Promise<void> {
  const root = process.cwd();
  const draftDir = path.resolve(root, opts.dir);
  if (!fs.existsSync(draftDir)) {
    throw new Error(`No draft directory at ${path.relative(root, draftDir)}. Run specreg generate --write first.`);
  }
  const files = fs.readdirSync(draftDir).filter((file) => file.toLowerCase().endsWith(".md")).sort();
  if (files.length === 0) throw new Error(`No Markdown drafts found in ${path.relative(root, draftDir)}.`);

  const projectType = await selectProjectType(opts.server, opts.type, opts.token);
  const governed = await specsForProjectType(opts.server, projectType.id, opts.token);
  const byFilename = new Map(governed.map((spec) => [spec.filename, spec]));

  const created: string[] = [];
  const reviews: string[] = [];
  const skipped: string[] = [];

  for (const filename of files) {
    const content = fs.readFileSync(path.join(draftDir, filename), "utf8");
    const existing = byFilename.get(filename);
    if (!existing) {
      const spec = await fetchJson<Spec>(`${opts.server}/api/v1/specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_type_id: projectType.id,
          filename,
          content,
          updated_by: opts.author,
        }),
      }, opts.token);
      created.push(`${filename} -> draft ${spec.id}`);
      if (opts.publish) {
        await fetchJson(`${opts.server}/api/v1/specs/${encodeURIComponent(spec.id)}/publish`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ published_by: opts.author }),
        }, opts.token);
        created[created.length - 1] += " (published 1.0.0)";
      }
      continue;
    }

    if (existing.project_type_scope === "global" && !opts.force) {
      skipped.push(`${filename} is global; re-run with --force to submit a change against the global spec`);
      continue;
    }
    if (existing.status === "draft") {
      if (!opts.force) {
        skipped.push(`${filename} already exists as a registry draft; re-run with --force to update it`);
        continue;
      }
      await fetchJson(`${opts.server}/api/v1/specs/${encodeURIComponent(existing.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, updated_by: opts.author }),
      }, opts.token);
      created.push(`${filename} -> updated draft ${existing.id}`);
      continue;
    }
    if (existing.status === "pending_review" && !opts.force) {
      skipped.push(`${filename} already has a pending review; review or reject it first`);
      continue;
    }

    const cr = await fetchJson<ChangeRequest>(`${opts.server}/api/v1/specs/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        spec_id: existing.id,
        proposed_content: content,
        version_delta: opts.delta,
        proposed_by: opts.author,
        summary: `Submitted from ${path.relative(root, draftDir)}/${filename}`,
      }),
    }, opts.token);
    reviews.push(`${filename} -> change request ${cr.id}`);
  }

  console.log(`Submitted drafts from ${path.relative(root, draftDir) || "."}:`);
  for (const item of created) console.log(`  CREATED: ${item}`);
  for (const item of reviews) console.log(`  REVIEW:  ${item}`);
  for (const item of skipped) console.log(`  SKIPPED: ${item}`);
  if (created.length === 0 && reviews.length === 0 && skipped.length === 0) console.log("  No drafts processed.");
  console.log("\nOpen the registry Reviews and Specs pages to finish review, approval, and publication.");
}
