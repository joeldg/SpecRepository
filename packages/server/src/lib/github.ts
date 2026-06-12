import type { Spec } from "@specregistry/shared";
import type { Db } from "../db.js";
import { now, uuid } from "../db.js";

interface SubscriptionRow {
  id: string;
  project_type_id: string;
  repo: string;
  branch: string;
  base_path: string;
}

interface SyncJobRow {
  id: string;
  subscription_id: string;
  spec_id: string;
  version: string;
  status: "pending" | "done" | "error";
}

/**
 * Queue push-back jobs for every repo subscribed to this spec's project type.
 * Global-scope specs fan out to every subscription (they ship in every bundle).
 */
export function enqueueSyncJobs(db: Db, spec: Spec): number {
  const scope = db
    .prepare("SELECT scope FROM project_types WHERE id = ?")
    .get(spec.project_type_id) as { scope: string } | undefined;
  const subs =
    scope?.scope === "global"
      ? (db.prepare("SELECT * FROM repo_subscriptions").all() as SubscriptionRow[])
      : (db
          .prepare("SELECT * FROM repo_subscriptions WHERE project_type_id = ?")
          .all(spec.project_type_id) as SubscriptionRow[]);

  const ts = now();
  const insert = db.prepare(
    `INSERT INTO sync_jobs (id, subscription_id, spec_id, version, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  );
  for (const sub of subs) {
    insert.run(uuid(), sub.id, spec.id, spec.current_version, ts, ts);
  }
  return subs.length;
}

async function gh(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "specregistry",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}

async function pushSpecToRepo(token: string, sub: SubscriptionRow, spec: Spec): Promise<string> {
  const branchName = `specreg/${spec.filename.replace(/\.md$/i, "").toLowerCase()}-${spec.current_version}`;
  const filePath = `${sub.base_path.replace(/\/+$/, "")}/${spec.filename}`;

  const baseRef = await gh(token, "GET", `/repos/${sub.repo}/git/ref/heads/${sub.branch}`);
  if (!baseRef.ok) throw new Error(`Cannot resolve ${sub.repo}@${sub.branch}: ${baseRef.status}`);
  const baseSha = ((await baseRef.json()) as { object: { sha: string } }).object.sha;

  const createRef = await gh(token, "POST", `/repos/${sub.repo}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });
  if (!createRef.ok && createRef.status !== 422) {
    throw new Error(`Cannot create branch ${branchName}: ${createRef.status}`);
  }

  // Need the existing file's blob sha (if any) to update rather than create.
  const existing = await gh(
    token,
    "GET",
    `/repos/${sub.repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branchName)}`
  );
  const existingSha = existing.ok ? ((await existing.json()) as { sha: string }).sha : undefined;

  const put = await gh(token, "PUT", `/repos/${sub.repo}/contents/${encodeURIComponent(filePath)}`, {
    message: `chore(specs): update ${spec.filename} to v${spec.current_version} via SpecRegistry`,
    content: Buffer.from(spec.content, "utf8").toString("base64"),
    branch: branchName,
    ...(existingSha ? { sha: existingSha } : {}),
  });
  if (!put.ok) throw new Error(`Cannot write ${filePath}: ${put.status} ${await put.text()}`);

  const pr = await gh(token, "POST", `/repos/${sub.repo}/pulls`, {
    title: `Update ${spec.filename} to v${spec.current_version} (SpecRegistry)`,
    head: branchName,
    base: sub.branch,
    body: `Approved specification update distributed by SpecRegistry.\n\n- **File:** \`${filePath}\`\n- **Version:** ${spec.current_version}`,
  });
  if (pr.ok) {
    const prBody = (await pr.json()) as { html_url: string };
    return `PR opened: ${prBody.html_url}`;
  }
  if (pr.status === 422) return `Branch ${branchName} updated; PR already exists`;
  throw new Error(`Cannot open PR for ${branchName}: ${pr.status}`);
}

export interface SyncJobResult {
  job_id: string;
  status: "done" | "error";
  detail: string;
}

/** Process pending sync jobs. Requires GITHUB_TOKEN; without it jobs stay queued. */
export async function processSyncJobs(db: Db, token: string | undefined): Promise<SyncJobResult[]> {
  const pending = db
    .prepare("SELECT * FROM sync_jobs WHERE status = 'pending' ORDER BY created_at")
    .all() as SyncJobRow[];
  if (pending.length === 0) return [];
  if (!token) {
    return pending.map((job) => ({
      job_id: job.id,
      status: "error" as const,
      detail: "GITHUB_TOKEN is not configured on the server; jobs remain pending",
    }));
  }

  const results: SyncJobResult[] = [];
  for (const job of pending) {
    const sub = db
      .prepare("SELECT * FROM repo_subscriptions WHERE id = ?")
      .get(job.subscription_id) as SubscriptionRow | undefined;
    const spec = db.prepare("SELECT * FROM specs WHERE id = ?").get(job.spec_id) as Spec | undefined;
    let status: "done" | "error";
    let detail: string;
    try {
      if (!sub || !spec) throw new Error("Subscription or spec no longer exists");
      detail = await pushSpecToRepo(token, sub, spec);
      status = "done";
    } catch (err) {
      status = "error";
      detail = err instanceof Error ? err.message : String(err);
    }
    db.prepare("UPDATE sync_jobs SET status = ?, detail = ?, updated_at = ? WHERE id = ?").run(
      status,
      detail,
      now(),
      job.id
    );
    results.push({ job_id: job.id, status, detail });
  }
  return results;
}
