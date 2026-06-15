# SpecRegistry Add-On Backlog

## Governance

- Review SLA dashboard for old pending reviews and stale reviewer queues.
- Spec ownership with CODEOWNERS-style owners per project type and filename.
- Dry-run publish preview showing affected repos, webhooks, generated agent files, and sync jobs.
- Spec diff risk scoring for security-sensitive or compatibility-heavy changes.

## Quality and Safety

- Spec lint rules beyond headings: required examples, prohibited ambiguity terms, required non-goals, and required operational sections.
- Contradiction detector across global and project-type specs before publish.
- Section-level permalinks for exact citations in feedback and audit findings.
- Spec dependency map showing references, overrides, and supersession.

## Developer Workflow

- GitHub App integration instead of raw `GITHUB_TOKEN`.
- Official `specreg check` GitHub Action with PR comments.
- Generated spec update PR summaries and changelogs.
- Dashboard drift diagnostics from an uploaded or pasted `.specregistry.json`.

## Search and Discovery

- Semantic search alongside FTS5.
- Saved searches for common policy areas such as auth, PII, deployment, and observability.

## AI Feedback and Efficacy

- Feedback cluster actions: acknowledge/resolve/draft-fix an entire cluster.
- Scheduled efficacy runs for important specs.
- Efficacy trend charts over model and spec versions.
- Prompt regression suite comparing outputs across model versions.
- Token ROI report combining spec size, usage frequency, efficacy lift, and stale risk.

## Enterprise

- Secrets hygiene with encrypted-at-rest LDAP bind passwords and webhook secrets.
- Read-only public share links for approved spec bundles.
- SCIM or scheduled LDAP user/group sync.
