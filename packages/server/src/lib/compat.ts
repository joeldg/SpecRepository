import type { VersionDelta } from "@specregistry/shared";

export interface CompatReport {
  removed_sections: string[];
  added_sections: string[];
  suggested_delta: VersionDelta;
  requested_delta: VersionDelta;
  agrees_with_requested: boolean;
}

function headings(markdown: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (inFence) continue;
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (match) out.push(match[2]);
  }
  return out;
}

/**
 * Heuristic cross-version compatibility: removed sections are treated as breaking
 * guidance (major), new sections as additive guidance (minor), and pure wording
 * changes as clarifications (patch).
 */
export function analyzeCompatibility(
  oldContent: string,
  newContent: string,
  requestedDelta: VersionDelta
): CompatReport {
  const oldHeadings = headings(oldContent);
  const newHeadings = new Set(headings(newContent));
  const oldSet = new Set(oldHeadings);

  const removed = oldHeadings.filter((h) => !newHeadings.has(h));
  const added = [...newHeadings].filter((h) => !oldSet.has(h));

  const suggested: VersionDelta = removed.length > 0 ? "major" : added.length > 0 ? "minor" : "patch";
  const rank: Record<VersionDelta, number> = { patch: 0, minor: 1, major: 2 };
  return {
    removed_sections: removed,
    added_sections: added,
    suggested_delta: suggested,
    requested_delta: requestedDelta,
    // A bigger-than-suggested bump is fine; smaller means guidance may silently break.
    agrees_with_requested: rank[requestedDelta] >= rank[suggested],
  };
}
