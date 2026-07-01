# Security Model: Keeping Agents Inside the Fence

SpecRegistry lets AI agents read governed specs, submit changes, and mark their own
work "done." That is exactly the kind of workflow that goes wrong if an agent can also
approve its own submission, escalate to admin, or wander outside the documented API.
This document explains, concretely, which of those failure modes are **enforced by the
server** (an agent cannot do them no matter what it tries) versus **advisory**
(governed by spec text and cooperative tooling, not by a network-level block), and how
to verify the difference yourself.

If you only read one section, read [Enforced vs. advisory](#enforced-vs-advisory).

## Threat model

The agent is assumed to be capable but not necessarily well-behaved: it might
hallucinate a shortcut, follow a prompt-injected instruction from spec content it
loaded, or simply decide the fastest path to "done" is to skip a step. The controls
below assume an agent will try the shortcut, not that it wouldn't think to.

What we are specifically defending against:

1. An agent approving or publishing its own proposed change to a shared spec
   (self-approval / no independent review).
2. An agent escalating to the `admin` identity, or acting as one via a shared/default
   credential.
3. An agent editing or publishing specs that belong to a different repo or project.
4. An agent reaching parts of the server (dashboard routes, internals, other tenants'
   data) outside the documented agent API.
5. An agent claiming a task is compliant/complete when it measurably isn't.

## Identity model

- **Roles**: `admin` > `reviewer` > `author` > `agent` (packages/server/src/lib/auth.ts).
  Rank is enforced numerically (`ROLE_RANK`), so "at least reviewer" really means
  reviewer or admin, nothing lower.
- **Agents get their own identity per repo, never a shared one.** `specreg init`
  enrolls the calling repo as `agent:<repo>` via `POST /api/v1/agents/enroll`
  (packages/server/src/routes/auth.ts) and stores the issued token in the repo's
  `.spec/credentials.json` (gitignored). The MCP config (`.mcp.json`) authenticates as
  that identity, not as `admin` and not as a human account.
- **Enrollment itself is gated in secured deployments.** `/agents/enroll` is open in
  dev, but the moment `SPECREG_AUTH=required`, it refuses to issue a token unless the
  caller presents `SPECREG_ENROLL_SECRET` via the `x-enroll-secret` header — an
  unauthenticated caller cannot mint itself an agent identity on a secured server.

## Enforced vs. advisory

| Control | Enforced by | What actually stops the agent |
| --- | --- | --- |
| Agents cannot approve/reject any change request | Server RBAC (`min: "reviewer"` policy on `POST /reviews/:id/approve\|reject`) | `agent` role rank (0) is below `reviewer` rank (2); the request 403s before any handler logic runs. True regardless of separation-of-duties checks below. |
| No one approves their own proposal | Server logic in `reviews.ts` (`approve` handler) comparing `req.user.username` to `change_request.proposed_by` | In secured mode the approver identity comes from the verified token (`req.user.username`), not a client-supplied field, so it cannot be spoofed. Blocks reviewers *and* admins by default (`SPECREG_ALLOW_ADMIN_SELF_APPROVE` opts back in, off by default). |
| Agents can only create/edit/publish specs for their own enrolled repo | Server logic (`assertAgentScope` in `specs.ts`) checked against `req.user.repo` on every create/edit/publish call | An agent token bound to repo A gets a 403 the moment it targets a `project_id` that resolves to a different repo, or targets a global/project-type (non-project-scoped) spec at all. |
| Global and project-type specs always go through human review | Same `assertAgentScope` check: agents get a 403 unless `project_id` is set | An agent can *propose* a change to a governed spec (`POST /specs/review`, allowed at `agent` rank), but cannot create/edit/publish one directly — only a human review can turn that proposal into a change. |
| Server won't boot with a known-default admin password | `assertSecurePosture` (auth.ts), called from the server entrypoint before it starts accepting traffic | When `SPECREG_AUTH=required`, if `admin`'s password hash still verifies against the literal string `"admin"`, startup throws and the process exits. A fresh secured database instead auto-generates a strong random password and prints it once. This closes the classic "agent finds `admin`/`admin`, logs in, self-approves" path at the door. |
| Inbound GitHub/Slack webhooks are authentic | HMAC-SHA256 signature verification with `crypto.timingSafeEqual` (`integrations.ts`) | Forged webhook payloads (e.g., a fake "spec edited on GitHub" push) are rejected with 401 before they can open a change request. |
| Agent-tier session listing can't enumerate other repos | `GET /ai/agent-sessions` requires a `repo` query param; the unscoped cross-repo view moved to the admin-only `GET /agent-sessions` | An agent token cannot page through every other repo's task descriptions, plans, and models — only its own. |
| Agent begins work with a registered intent (`begin_task`) and must call `finish_task`/`check_compliance` before claiming done | **Advisory.** `AGENT_OPERATING_RULES` (a governed spec) and the MCP tool descriptions instruct the agent to do this; the server records whatever the agent reports and returns a `directive` string. | Nothing server-side stops an agent from skipping `begin_task`, or from calling `finish_task` and then reporting "done" to its human regardless of a `COMPLETION BLOCKED` directive. The objective compliance *score* is real and measured from actual code-trace data, but acting on the verdict is the agent's/host's responsibility, same as any other instruction in a spec. Treat this as a strong nudge and an audit trail (every attestation is persisted — see `compliance_attestations` and the Reports/compliance dashboard), not a network-level gate. |
| Agent stays within the documented MCP/API surface instead of browsing the dashboard or probing routes | **Advisory.** `SPECREGISTRY.md` and `AGENT_OPERATING_RULES` state this boundary. | RBAC and `assertAgentScope` mean that *even if* an agent ignores this and calls dashboard-adjacent routes directly with its `agent` token, the write-side actions above are still blocked by rank/scope. The instruction narrows what a well-behaved agent *attempts*; RBAC is what actually stops a misbehaving one from *succeeding*. |

The pattern to notice: every claim in the left column that matters for "can an agent
approve its own work or become admin" is backed by a row where the enforcement
mechanism is server-side RBAC or an identity comparison, not agent cooperation. The
compliance loop and MCP lifecycle tools are a different, complementary layer: they make
good behavior easy and measurable, and they leave an audit trail, but they are not
what stands between an agent and a privileged action — RBAC and separation-of-duties
are.

## Defense in depth for the "self-approval" scenario specifically

Concretely, if a fully adversarial agent tried to get its own change into a governed
spec without independent review, every one of these would have to fail at once:

1. It would need a token with `reviewer` or `admin` rank — but its own enrolled
   identity is always `agent` rank, and nothing in the enrollment flow lets an agent
   request a higher role for itself.
2. Even holding a `reviewer`/`admin` token some other way, approving its own proposal
   is blocked by the proposer/approver identity comparison, which reads the verified
   token identity server-side, not a client-supplied name.
3. Even with `admin`, self-approval is still refused unless an operator has explicitly
   set `SPECREG_ALLOW_ADMIN_SELF_APPROVE=true` (default: off).
4. It cannot fall back to editing the published spec directly — `PUT /specs/:key`
   refuses once a spec is out of `draft` status; only the review/approve path can
   change a published spec.

This is exercised by the test suite (`packages/server/test/platform.test.ts`, describe
blocks `"agent identity, scope, and separation of duties"` and `"secured posture"`):
`forbids an agent from approving any change request`, `blocks a reviewer from
approving their own proposal`, `blocks admin self-approval unless explicitly enabled`,
`lets an agent create + publish its own project-scoped spec but not a governed one`,
and `refuses to run with the default admin password when auth is required`. Run
`npm test -w @specregistry/server` to see them pass.

## Deployment hardening checklist

Auth is **off by default** for the zero-config local/dev experience. For any shared or
internet-reachable deployment:

- [ ] Set `SPECREG_AUTH=required`.
- [ ] Set `SPECREG_ADMIN_PASSWORD` yourself, or let a fresh database auto-generate one
  and capture it from the boot log immediately — the server refuses to start with the
  literal default password once auth is required.
- [ ] Set `SPECREG_ENROLL_SECRET` so `POST /agents/enroll` isn't open to anyone who can
  reach the server.
- [ ] Leave `SPECREG_ALLOW_ADMIN_SELF_APPROVE` unset (default `false`) unless you have
  a specific, understood reason to allow solo admin self-approval.
- [ ] Configure per-project-type `required_reviewers` and/or approval policies
  (`min_approvals`) for any spec whose accuracy actually matters operationally —
  the RBAC rank check only guarantees *a* reviewer approved, not a *specific* one.
- [ ] If you use LDAP, map `LDAP_ADMIN_GROUP`/`LDAP_REVIEWER_GROUP` deliberately; the
  default role for unmapped users is `author`, not `agent` or `admin`.
- [ ] Set `SPECREG_SECRET_KEY` (from a secrets manager, not checked into the same place
  as the database) to encrypt the LDAP bind password, GitHub token, webhook/Slack
  signing secrets, and LLM/embedding API keys at rest instead of storing them plaintext.
- [ ] Put the server behind TLS termination; tokens are bearer credentials sent over
  plain HTTP otherwise.

## Known gaps (tracked, not yet fixed)

These are real limitations as of this writing, verified against the current code, not
hypothetical. They're tracked in [docs/TODO.md](docs/TODO.md) rather than hidden here:

- **Secrets at rest are plaintext by default.** LDAP bind password, GitHub token,
  GitHub/Slack webhook signing secrets, and LLM/embedding provider API keys are masked
  from the browser UI either way, but are stored unencrypted in the `settings` SQLite
  table unless `SPECREG_SECRET_KEY` is set — see the hardening checklist above. Without
  it, a stolen database file exposes all of them.
- **No login rate limiting.** `POST /api/v1/auth/login` has no throttling or lockout.
  scrypt makes single guesses slow but does not stop a distributed brute-force attempt
  against an internet-reachable secured deployment.
- **Tokens never expire.** Login sessions and agent/API tokens are valid until someone
  deletes the row via `DELETE /auth/api-keys/:id`. There is no TTL or rotation policy.
- **CORS reflects any origin** (`origin: true`). Low risk today because auth is
  bearer-token-only (nothing for a cross-site request to ride via cookies), but it
  should be tightened if a cookie-based session is ever added.
- **Agent-role spec reads are not repo-scoped**, only writes are. An agent enrolled for
  repo A can read repo B's project-scoped specs by passing repo B's identifier to the
  read endpoints. Writes (`assertAgentScope`) are strictly scoped; reads are not. This
  is likely fine for the common single-org deployment (specs are governance docs, not
  secrets) but is an emergent property today, not a documented decision.
- **This repository has no CI workflow of its own** — `npm run build`/`npm test` are
  not automatically gated on every push/PR (only a reusable Action for *consumers* of
  SpecRegistry exists).
- **The compliance/lifecycle loop is advisory**, as detailed above — it produces a real
  audit trail and a real measured score, but nothing server-side currently blocks an
  agent from ignoring a `COMPLETION BLOCKED` directive and reporting done anyway to its
  human operator.

## See also

- [README-AGENTS.md](README-AGENTS.md) — the full agent feedback/compliance loop from
  the agent's point of view.
- [docs/TODO.md](docs/TODO.md) — the live backlog, including the gaps above and
  planned hardening work (governed tool permission profiles, dedicated narrow
  agent-scope token type, human intervention queue for blocked compliance).
