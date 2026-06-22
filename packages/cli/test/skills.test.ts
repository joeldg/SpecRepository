import assert from "node:assert/strict";
import test from "node:test";
import { renderAgentSkill, resolveAgentSkills, type AgentSkill } from "../src/skills.js";

const catalog: AgentSkill[] = [
  { id: "1", slug: "load-specs", name: "Load specs", description: "Load governed specs.", instructions: "Call get_specs.", risk_level: "safe", status: "active", built_in: 1, created_at: "", updated_at: "" },
  { id: "2", slug: "deploy", name: "Deploy", description: "Prepare a deployment.", instructions: "Require approval.", risk_level: "restricted", status: "active", built_in: 0, created_at: "", updated_at: "" },
];

test("base skill selection includes only active built-in safe skills", () => {
  assert.deepEqual(resolveAgentSkills(catalog).map((skill) => skill.slug), ["load-specs"]);
  assert.deepEqual(resolveAgentSkills(catalog, "all").map((skill) => skill.slug), ["load-specs", "deploy"]);
  assert.deepEqual(resolveAgentSkills(catalog, "2").map((skill) => skill.slug), ["deploy"]);
});

test("rendered skills carry provenance, risk, and a safety boundary", () => {
  const markdown = renderAgentSkill(catalog[1]);
  assert.match(markdown, /name: deploy/);
  assert.match(markdown, /risk_level: restricted/);
  assert.match(markdown, /not permission to take external or destructive/);
});
