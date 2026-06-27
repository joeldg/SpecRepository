import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { now, uuid } from "../db.js";
import { HttpError } from "../helpers.js";

export type Role = "admin" | "reviewer" | "author" | "agent";
export const ROLES = ["admin", "reviewer", "author", "agent"] as const satisfies readonly Role[];

export interface User {
  id: string;
  username: string;
  display_name: string | null;
  role: Role;
  password_hash: string | null;
  source: "local" | "ldap";
  created_at: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
  }
}

// --- Password hashing (scrypt) ---

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

// --- API tokens (stored hashed; the raw token is shown once) ---

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function issueToken(db: Db, userId: string, name?: string): string {
  const token = `sreg_${crypto.randomBytes(24).toString("hex")}`;
  db.prepare("INSERT INTO tokens (id, token_hash, user_id, name, created_at) VALUES (?, ?, ?, ?, ?)").run(
    uuid(),
    tokenHash(token),
    userId,
    name ?? null,
    now()
  );
  return token;
}

export function lookupToken(db: Db, token: string): User | undefined {
  const row = db
    .prepare(
      `SELECT u.* FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`
    )
    .get(tokenHash(token)) as User | undefined;
  if (row) {
    db.prepare("UPDATE tokens SET last_used_at = ? WHERE token_hash = ?").run(now(), tokenHash(token));
  }
  return row;
}

export function findUser(db: Db, username: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) as
    | User
    | undefined;
}

export function createUser(
  db: Db,
  input: { username: string; role: Role; password?: string; display_name?: string; source?: "local" | "ldap" }
): User {
  const id = uuid();
  db.prepare(
    `INSERT INTO users (id, username, display_name, role, password_hash, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.username,
    input.display_name ?? null,
    input.role,
    input.password ? hashPassword(input.password) : null,
    input.source ?? "local",
    now()
  );
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User;
}

// --- Optional LDAP (active when LDAP_URL is configured) ---

export interface LdapConfig {
  url: string;
  bind_dn_template: string;
  bind_user: string;
  bind_password: string;
  search_base: string;
  search_filter: string;
  admin_group: string;
  reviewer_group: string;
  default_role: Role;
}

const LDAP_SETTING_KEYS = {
  url: "ldap.url",
  bind_dn_template: "ldap.bind_dn_template",
  bind_user: "ldap.bind_user",
  bind_password: "ldap.bind_password",
  search_base: "ldap.search_base",
  search_filter: "ldap.search_filter",
  admin_group: "ldap.admin_group",
  reviewer_group: "ldap.reviewer_group",
  default_role: "ldap.default_role",
} as const;

function envConfig(): LdapConfig {
  return {
    url: process.env.LDAP_URL ?? "",
    bind_dn_template: process.env.LDAP_BIND_DN_TEMPLATE ?? "",
    bind_user: process.env.LDAP_BIND_USER ?? "",
    bind_password: process.env.LDAP_BIND_PASSWORD ?? "",
    search_base: process.env.LDAP_SEARCH_BASE ?? "",
    search_filter: process.env.LDAP_SEARCH_FILTER ?? "(uid={username})",
    admin_group: process.env.LDAP_ADMIN_GROUP ?? "",
    reviewer_group: process.env.LDAP_REVIEWER_GROUP ?? "",
    default_role: (process.env.LDAP_DEFAULT_ROLE as Role | undefined) ?? "author",
  };
}

export function getLdapConfig(db: Db): LdapConfig {
  const base = envConfig();
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ldap.%'").all() as Array<{
    key: string;
    value: string;
  }>;
  const settings = new Map(rows.map((r) => [r.key, r.value]));
  const role = settings.get(LDAP_SETTING_KEYS.default_role) ?? base.default_role;
  return {
    url: settings.get(LDAP_SETTING_KEYS.url) ?? base.url,
    bind_dn_template: settings.get(LDAP_SETTING_KEYS.bind_dn_template) ?? base.bind_dn_template,
    bind_user: settings.get(LDAP_SETTING_KEYS.bind_user) ?? base.bind_user,
    bind_password: settings.get(LDAP_SETTING_KEYS.bind_password) ?? base.bind_password,
    search_base: settings.get(LDAP_SETTING_KEYS.search_base) ?? base.search_base,
    search_filter: settings.get(LDAP_SETTING_KEYS.search_filter) ?? base.search_filter,
    admin_group: settings.get(LDAP_SETTING_KEYS.admin_group) ?? base.admin_group,
    reviewer_group: settings.get(LDAP_SETTING_KEYS.reviewer_group) ?? base.reviewer_group,
    default_role: ROLES.includes(role as Role) ? (role as Role) : "author",
  };
}

export function saveLdapConfig(db: Db, input: Partial<LdapConfig> & { clear_bind_password?: boolean }): LdapConfig {
  const current = getLdapConfig(db);
  const next: LdapConfig = {
    ...current,
    ...Object.fromEntries(
      Object.entries(input).filter(([key, value]) => key !== "clear_bind_password" && value !== undefined)
    ),
  } as LdapConfig;
  if (input.clear_bind_password) next.bind_password = "";
  if (!ROLES.includes(next.default_role)) next.default_role = "author";

  const upsert = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  for (const [field, key] of Object.entries(LDAP_SETTING_KEYS) as Array<[keyof LdapConfig, string]>) {
    upsert.run(key, next[field] ?? "");
  }
  return getLdapConfig(db);
}

export function publicLdapConfig(db: Db, input = getLdapConfig(db)) {
  const { bind_password, ...config } = input;
  return { ...config, enabled: Boolean(config.url), has_bind_password: Boolean(bind_password) };
}

export function ldapEnabled(db: Db): boolean {
  return Boolean(getLdapConfig(db).url);
}

/**
 * Authenticate against LDAP. Two modes:
 *  - Direct bind:  LDAP_BIND_DN_TEMPLATE="uid={username},ou=people,dc=example,dc=com"
 *  - Search+bind:  LDAP_BIND_USER/LDAP_BIND_PASSWORD service account +
 *                  LDAP_SEARCH_BASE + LDAP_SEARCH_FILTER="(uid={username})"
 * Role mapping: membership of LDAP_ADMIN_GROUP / LDAP_REVIEWER_GROUP DNs; default author.
 */
export async function ldapAuthenticate(
  db: Db,
  username: string,
  password: string
): Promise<{ role: Role; displayName?: string; groups: string[]; dn: string }> {
  const config = getLdapConfig(db);
  if (!config.url) throw new HttpError(503, "LDAP is not configured");
  const { Client } = await import("ldapts");
  const client = new Client({ url: config.url });
  try {
    let userDn: string;
    let groups: string[] = [];
    let displayName: string | undefined;

    if (config.bind_dn_template) {
      userDn = config.bind_dn_template.replaceAll("{username}", username);
    } else {
      if (!config.search_base) {
        throw new HttpError(503, "LDAP misconfigured: set LDAP_BIND_DN_TEMPLATE or LDAP_SEARCH_BASE");
      }
      if (config.bind_user) {
        await client.bind(config.bind_user, config.bind_password);
      }
      const filter = (config.search_filter || "(uid={username})").replaceAll("{username}", username);
      const { searchEntries } = await client.search(config.search_base, {
        filter,
        attributes: ["dn", "cn", "memberOf"],
      });
      if (searchEntries.length !== 1) throw new HttpError(401, "Invalid credentials");
      userDn = searchEntries[0].dn;
      displayName = String(searchEntries[0].cn ?? "") || undefined;
      const memberOf = searchEntries[0].memberOf;
      groups = Array.isArray(memberOf) ? memberOf.map(String) : memberOf ? [String(memberOf)] : [];
    }

    await client.bind(userDn, password); // throws on bad credentials

    if (groups.length === 0) {
      // Direct-bind mode: read memberOf as the user
      try {
        const { searchEntries } = await client.search(userDn, { scope: "base", attributes: ["cn", "memberOf"] });
        const memberOf = searchEntries[0]?.memberOf;
        groups = Array.isArray(memberOf) ? memberOf.map(String) : memberOf ? [String(memberOf)] : [];
        displayName = displayName ?? (String(searchEntries[0]?.cn ?? "") || undefined);
      } catch {
        // group lookup is best-effort
      }
    }

    return { role: mapLdapGroupsToRole(groups, config), displayName, groups, dn: userDn };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(401, "Invalid credentials");
  } finally {
    await client.unbind().catch(() => {});
  }
}

export function mapLdapGroupsToRole(groups: string[], config = envConfig()): Role {
  const normalized = groups.map((g) => g.toLowerCase());
  const admin = config.admin_group?.toLowerCase();
  const reviewer = config.reviewer_group?.toLowerCase();
  if (admin && normalized.includes(admin)) return "admin";
  if (reviewer && normalized.includes(reviewer)) return "reviewer";
  return config.default_role;
}

// --- Request authentication + role policy ---

const ROLE_RANK: Record<Role, number> = { agent: 0, author: 1, reviewer: 2, admin: 3 };

/** Paths reachable without a token even when auth is required. */
const PUBLIC_PATHS = [
  "/api/v1/health",
  "/metrics",
  "/api/v1/auth/login",
  "/api/v1/meta/public-key",
  "/api/v1/integrations/", // verified by their own HMAC secrets
];

/** Minimum role per route pattern, enforced only for authenticated identities. */
const POLICIES: Array<{ method: RegExp; path: RegExp; min: Role }> = [
  { method: /POST/, path: /^\/api\/v1\/reviews\/[^/]+\/(approve|reject)$/, min: "reviewer" },
  { method: /POST/, path: /^\/api\/v1\/specs\/[^/]+\/promote$/, min: "reviewer" },
  { method: /POST/, path: /^\/api\/v1\/specs\/[^/]+\/restore$/, min: "admin" },
  { method: /GET/, path: /^\/api\/v1\/specs\/deleted$/, min: "admin" },
  { method: /POST/, path: /^\/api\/v1\/specs\/purge$/, min: "admin" },
  { method: /DELETE/, path: /^\/api\/v1\/specs\//, min: "admin" },
  { method: /GET|POST|PUT|DELETE/, path: /^\/api\/v1\/(ldap|llm|embeddings|app-keys|features)(\/|$)/, min: "admin" },
  { method: /GET/, path: /^\/api\/v1\/audit-log$/, min: "admin" },
  { method: /GET/, path: /^\/api\/v1\/cli\/consumers$/, min: "admin" },
  { method: /POST/, path: /^\/api\/v1\/cli\/(manifest-report|code-trace-report)$/, min: "agent" },
  { method: /POST|PUT|DELETE/, path: /^\/api\/v1\/(templates|webhooks|subscriptions|approval-policies|skills)(\/|$)/, min: "admin" },
  { method: /POST/, path: /^\/api\/v1\/spec-generation\/draft$/, min: "author" },
  { method: /POST/, path: /^\/api\/v1\/spec-generation\/preview$/, min: "author" },
  { method: /POST/, path: /^\/api\/v1\/automation\//, min: "author" },
  { method: /POST/, path: /^\/api\/v1\/sync-jobs\/run$/, min: "admin" },
  { method: /PUT/, path: /^\/api\/v1\/auth\/users\/[^/]+\/password$/, min: "agent" },
  { method: /GET|POST|DELETE/, path: /^\/api\/v1\/auth\/users(\/|$)/, min: "admin" },
  { method: /GET|POST|DELETE/, path: /^\/api\/v1\/auth\/api-keys(\/|$)/, min: "admin" },
  { method: /POST|PUT/, path: /^\/api\/v1\/specs(\/|$)/, min: "author" },
  { method: /POST|PUT/, path: /^\/api\/v1\/project-types(\/|$)/, min: "author" },
];

export function registerAuth(app: FastifyInstance, opts: { authRequired: boolean }): void {
  app.addHook("onRequest", async (req) => {
    const header = req.headers.authorization;
    const raw =
      (typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined) ??
      (req.headers["x-api-key"] as string | undefined);
    if (raw) {
      req.user = lookupToken(app.db, raw);
      if (!req.user) throw new HttpError(401, "Invalid or revoked token");
    }

    const path = req.url.split("?")[0];
    if (PUBLIC_PATHS.some((p) => path === p || path.startsWith(p))) return;

    if (opts.authRequired && !req.user) {
      throw new HttpError(401, "Authentication required (Bearer token or x-api-key)");
    }
    // Enforce role-based policies. If a matching policy exists and the user
    // is not authenticated, reject — even when authRequired is false.
    for (const policy of POLICIES) {
      if (policy.method.test(req.method) && policy.path.test(path)) {
        if (!req.user) {
          throw new HttpError(401, "Authentication required for this action");
        }
        if (ROLE_RANK[req.user.role] < ROLE_RANK[policy.min]) {
          throw new HttpError(403, `Requires role ${policy.min} or higher (you are ${req.user.role})`);
        }
        break;
      }
    }
  });
}

/** Review routing: per-project-type required reviewers (admins bypass). */
export function enforceRequiredReviewers(
  db: Db,
  projectTypeId: string,
  reviewerName: string,
  req: FastifyRequest
): void {
  const row = db.prepare("SELECT required_reviewers FROM project_types WHERE id = ?").get(projectTypeId) as
    | { required_reviewers: string }
    | undefined;
  const required: string[] = JSON.parse(row?.required_reviewers ?? "[]");
  if (required.length === 0) return;
  if (req.user?.role === "admin") return;
  const identity = req.user?.username ?? reviewerName;
  if (!required.some((r) => r.toLowerCase() === identity.toLowerCase())) {
    throw new HttpError(403, `This project type requires review by one of: ${required.join(", ")}`);
  }
}
