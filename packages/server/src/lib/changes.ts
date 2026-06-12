import { createTwoFilesPatch } from "diff";
import type { ChangeRequest, Spec, VersionDelta } from "@specregistry/shared";
import type { Db } from "../db.js";
import { now, uuid } from "../db.js";
import { HttpError } from "../helpers.js";
import { analyzeCompatibility } from "./compat.js";
import { lintContent } from "./lint.js";

export interface CreateChangeRequestInput {
  spec: Spec;
  proposedContent: string;
  versionDelta: VersionDelta;
  proposedBy: string;
  summary?: string | null;
}

/**
 * Shared path for human-submitted and AI-drafted change requests: computes the
 * unified diff, the compatibility report, and the template lint, then moves the
 * spec into pending_review.
 */
export function createChangeRequest(db: Db, input: CreateChangeRequestInput): ChangeRequest {
  const { spec, proposedContent, versionDelta, proposedBy } = input;
  if (spec.status === "draft") {
    throw new HttpError(409, "Draft specs are edited directly (PUT /specs/:id), not reviewed");
  }
  if (proposedContent === spec.content) {
    throw new HttpError(400, "Proposed content is identical to the current published content");
  }

  const diff = createTwoFilesPatch(
    `${spec.filename}@${spec.current_version}`,
    `${spec.filename}@proposed`,
    spec.content,
    proposedContent
  );
  const compatibility = analyzeCompatibility(spec.content, proposedContent, versionDelta);
  const lint = lintContent(db, spec.filename, proposedContent);

  const id = uuid();
  const ts = now();
  const submit = db.transaction(() => {
    db.prepare(
      `INSERT INTO change_requests
         (id, spec_id, proposed_by, version_delta, diff, proposed_content, summary, status, compatibility, lint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(
      id,
      spec.id,
      proposedBy,
      versionDelta,
      diff,
      proposedContent,
      input.summary ?? null,
      JSON.stringify(compatibility),
      lint ? JSON.stringify(lint) : null,
      ts
    );
    db.prepare("UPDATE specs SET status = 'pending_review', updated_at = ? WHERE id = ?").run(ts, spec.id);
  });
  submit();
  return db.prepare("SELECT * FROM change_requests WHERE id = ?").get(id) as ChangeRequest;
}
