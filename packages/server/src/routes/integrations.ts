import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ChangeRequest, Spec } from "@specregistry/shared";
import { HttpError } from "../helpers.js";
import { analyzeCompatibility } from "../lib/compat.js";
import { createChangeRequest } from "../lib/changes.js";
import { dispatchWebhooks } from "../lib/events.js";
import { getAppKeyConfig } from "../lib/appKeys.js";

interface PushEvent {
  ref: string;
  repository: { full_name: string };
  pusher?: { name?: string };
  head_commit?: { id: string };
  commits?: Array<{ added: string[]; modified: string[] }>;
}

interface SubscriptionRow {
  id: string;
  project_type_id: string;
  repo: string;
  branch: string;
  base_path: string;
}

function timingEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

async function fetchRepoFile(token: string, repo: string, path: string, ref: string): Promise<string | undefined> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    {
      headers: {
        accept: "application/vnd.github.raw+json",
        "user-agent": "specregistry",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!res.ok) return undefined;
  return res.text();
}

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  // Raw-body capture for HMAC verification — parsers registered here are scoped
  // to this plugin's routes only, so the rest of the API keeps JSON parsing.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
    done(null, body)
  );
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  /**
   * Two-way git sync (inbound): a GitHub push webhook. When a subscribed repo edits
   * files under its spec path on the subscribed branch, open a matching change
   * request in the registry instead of letting the copies fork.
   * Configure GITHUB_WEBHOOK_SECRET; payload signature is verified (sha256 HMAC).
   */
  app.post("/integrations/github/webhook", async (req, reply) => {
    const appKeys = getAppKeyConfig(app.db);
    const secret = appKeys.github_webhook_secret;
    if (!secret) throw new HttpError(503, "GitHub webhook is not configured (set GITHUB_WEBHOOK_SECRET)");

    const signature = req.headers["x-hub-signature-256"];
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    if (typeof signature !== "string" || !timingEqual(signature, expected)) {
      throw new HttpError(401, "Invalid webhook signature");
    }

    if (req.headers["x-github-event"] !== "push") {
      return { handled: false, reason: "not a push event" };
    }
    const event = JSON.parse(rawBody) as PushEvent;
    const branch = event.ref?.replace("refs/heads/", "");
    const subs = app.db
      .prepare("SELECT * FROM repo_subscriptions WHERE repo = ? AND branch = ?")
      .all(event.repository?.full_name ?? "", branch ?? "") as SubscriptionRow[];
    if (subs.length === 0) return { handled: false, reason: "no matching subscription" };

    const changed = new Set<string>();
    for (const commit of event.commits ?? []) {
      for (const file of [...(commit.added ?? []), ...(commit.modified ?? [])]) changed.add(file);
    }

    const opened: string[] = [];
    const skipped: string[] = [];
    for (const sub of subs) {
      const prefix = `${sub.base_path.replace(/\/+$/, "")}/`;
      for (const filePath of changed) {
        if (!filePath.startsWith(prefix) || !filePath.toLowerCase().endsWith(".md")) continue;
        const filename = filePath.slice(prefix.length);
        if (filename.includes("/")) continue;

        // Match within the subscribed project type first, then global.
        const spec = app.db
          .prepare(
            `SELECT s.* FROM specs s JOIN project_types pt ON pt.id = s.project_type_id
             WHERE s.filename = ? AND s.status != 'draft' AND s.deleted_at IS NULL AND (pt.id = ? OR pt.scope = 'global')
             ORDER BY pt.id = ? DESC LIMIT 1`
          )
          .get(filename, sub.project_type_id, sub.project_type_id) as Spec | undefined;
        if (!spec) {
          skipped.push(`${filename}: no matching spec`);
          continue;
        }
        if (spec.status === "pending_review") {
          skipped.push(`${filename}: already pending review`);
          continue;
        }
        const content = await fetchRepoFile(appKeys.github_token, sub.repo, filePath, event.head_commit?.id ?? branch!);
        if (content === undefined) {
          skipped.push(`${filename}: could not fetch content (GITHUB_TOKEN missing or file gone)`);
          continue;
        }
        if (content === spec.content) {
          skipped.push(`${filename}: identical to registry head`);
          continue;
        }

        const suggested = analyzeCompatibility(spec.content, content, "patch").suggested_delta;
        const cr = createChangeRequest(app.db, {
          spec,
          proposedContent: content,
          versionDelta: suggested,
          proposedBy: `${event.pusher?.name ?? "unknown"} (via ${sub.repo})`,
          summary: `Inbound git sync from ${sub.repo}@${branch}: ${filePath}`,
        });
        await dispatchWebhooks(app.db, "review.submitted", `${filename}: inbound change from ${sub.repo}`, {
          change_request_id: cr.id,
          spec_id: spec.id,
          filename,
        });
        opened.push(cr.id);
      }
    }
    reply.code(200);
    return { handled: true, change_requests: opened, skipped };
  });

  /**
   * Slack interactivity endpoint: approve/reject buttons on review.submitted
   * notifications post here. Configure SLACK_SIGNING_SECRET and point the Slack
   * app's interactivity URL at this route.
   */
  app.post("/integrations/slack/actions", async (req) => {
    const secret = getAppKeyConfig(app.db).slack_signing_secret;
    if (!secret) throw new HttpError(503, "Slack interactivity is not configured (set SLACK_SIGNING_SECRET)");

    const timestamp = req.headers["x-slack-request-timestamp"];
    const signature = req.headers["x-slack-signature"];
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (typeof timestamp !== "string" || typeof signature !== "string") {
      throw new HttpError(401, "Missing Slack signature headers");
    }
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
      throw new HttpError(401, "Stale Slack request");
    }
    const expected =
      "v0=" + crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
    if (!timingEqual(signature, expected)) throw new HttpError(401, "Invalid Slack signature");

    const params = new URLSearchParams(rawBody);
    const payload = JSON.parse(params.get("payload") ?? "{}") as {
      actions?: Array<{ value?: string }>;
      user?: { username?: string; name?: string };
    };
    const value = payload.actions?.[0]?.value ?? "";
    const [action, crId] = value.split(":");
    if (!crId || (action !== "approve" && action !== "reject")) {
      throw new HttpError(400, `Unrecognized action value: ${value}`);
    }
    const reviewer = `${payload.user?.username ?? payload.user?.name ?? "slack-user"} (via Slack)`;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/reviews/${crId}/${action}`,
      payload: { reviewed_by: reviewer },
    });
    if (res.statusCode >= 400) {
      return { response_type: "ephemeral", text: `Could not ${action}: ${res.json().message ?? res.statusCode}` };
    }
    const cr = res.json() as ChangeRequest;
    return {
      response_type: "in_channel",
      replace_original: false,
      text:
        action === "approve"
          ? `:white_check_mark: Change request approved by ${reviewer}${cr.resulting_version ? ` → v${cr.resulting_version}` : ""}`
          : `:x: Change request rejected by ${reviewer}`,
    };
  });
}
