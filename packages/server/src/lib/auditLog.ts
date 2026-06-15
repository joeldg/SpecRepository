import type { FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { now, uuid } from "../db.js";

export interface AuditInput {
  actor?: string;
  action: string;
  target_type?: string;
  target_id?: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export function actorFrom(req: FastifyRequest, fallback = "anonymous"): string {
  return req.user?.username ?? fallback;
}

export function recordAudit(db: Db, input: AuditInput): void {
  db.prepare(
    `INSERT INTO audit_log (id, actor, action, target_type, target_id, summary, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuid(),
    input.actor ?? "system",
    input.action,
    input.target_type ?? null,
    input.target_id ?? null,
    input.summary,
    input.detail ? JSON.stringify(input.detail) : null,
    now()
  );
}
