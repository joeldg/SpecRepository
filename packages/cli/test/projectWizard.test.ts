import assert from "node:assert/strict";
import test from "node:test";
import { parseMultiSelection, renderProjectProfile, type ProjectProfile } from "../src/projectWizard.js";

const profile: ProjectProfile = {
  schema_version: 1,
  project_name: "Atlas",
  summary: "Routes governed work to internal services.",
  industry: "Developer tools",
  lifecycle_stage: "Production",
  users: ["Developers", "AI agents"],
  project_shapes: ["Web application", "API or backend service"],
  languages: ["TypeScript", "Rust"],
  frameworks: ["React", "Fastify"],
  platforms: ["Web browser", "Server"],
  data_stores: ["PostgreSQL", "Redis"],
  interfaces: ["REST or JSON API", "Model Context Protocol"],
  runtimes: ["Containers", "Kubernetes"],
  infrastructure: ["AWS", "Terraform or OpenTofu"],
  identity: ["OAuth 2.0 or OIDC", "Role-based access control"],
  messaging: ["Kafka"],
  observability: ["Structured logs", "Prometheus metrics"],
  testing: ["Unit tests", "Integration tests"],
  delivery: ["GitHub Actions"],
  security: ["Managed secrets", "SOC 2"],
  environments: ["Local development", "Staging", "Production"],
  constraints: ["Private network deployment"],
  non_goals: ["Public SaaS hosting"],
  agent_skills: ["load-governed-specs", "verify-conformance"],
};

test("multi-selection accepts numbered, named, and custom values without duplicates", () => {
  const options = [
    { id: "typescript", label: "TypeScript" },
    { id: "python", label: "Python" },
  ];
  assert.deepEqual(
    parseMultiSelection("1, python, Elixir, typescript", options),
    ["TypeScript", "Python", "Elixir"]
  );
  assert.deepEqual(parseMultiSelection("", options, ["TypeScript"]), ["TypeScript"]);
  assert.deepEqual(parseMultiSelection("none", options, ["TypeScript"]), []);
});

test("project profile renders review status and all major SDD sections", () => {
  const markdown = renderProjectProfile(profile, "Web Platform");
  assert.match(markdown, /^# Atlas Project Profile/m);
  assert.match(markdown, /Review and publish this profile/);
  assert.match(markdown, /## Product and Architecture/);
  assert.match(markdown, /## Runtime and Operations/);
  assert.match(markdown, /## Quality and Delivery/);
  assert.match(markdown, /- PostgreSQL/);
  assert.match(markdown, /- Kubernetes/);
  assert.match(markdown, /- SOC 2/);
  assert.match(markdown, /- verify-conformance/);
  assert.match(markdown, /Do not invent missing technology choices/);
});
