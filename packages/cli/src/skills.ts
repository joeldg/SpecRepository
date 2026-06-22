import fs from "node:fs";
import path from "node:path";
import { fetchJson } from "./registry.js";

export interface AgentSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  risk_level: "safe" | "restricted";
  status: "active" | "disabled";
  built_in: number;
  created_at: string;
  updated_at: string;
}

export async function listAgentSkills(server: string, token?: string): Promise<AgentSkill[]> {
  return await fetchJson<AgentSkill[]>(`${server}/api/v1/skills`, undefined, token);
}

export function resolveAgentSkills(catalog: AgentSkill[], selection?: string): AgentSkill[] {
  const normalized = selection?.trim().toLowerCase();
  if (normalized === "none" || normalized === "off") return [];
  if (normalized === "all") return catalog.filter((skill) => skill.status === "active");
  if (!normalized || normalized === "base" || normalized === "recommended") {
    return catalog.filter((skill) => skill.status === "active" && skill.built_in && skill.risk_level === "safe");
  }
  const selected: AgentSkill[] = [];
  for (const raw of normalized.split(",")) {
    const token = raw.trim();
    const index = Number(token);
    const skill = Number.isInteger(index) && index >= 1 && index <= catalog.length
      ? catalog[index - 1]
      : catalog.find((candidate) => candidate.slug.toLowerCase() === token || candidate.name.toLowerCase() === token);
    if (!skill) throw new Error(`Unknown agent skill "${raw.trim()}". Available: ${catalog.map((item) => item.slug).join(", ")}`);
    if (skill.status !== "active") throw new Error(`Agent skill is disabled: ${skill.slug}`);
    if (!selected.some((item) => item.id === skill.id)) selected.push(skill);
  }
  return selected;
}

export function installAgentSkills(skills: AgentSkill[], dir: string, force = false): void {
  const outDir = path.resolve(process.cwd(), dir);
  fs.mkdirSync(outDir, { recursive: true });
  for (const skill of skills) {
    const skillDir = path.join(outDir, skill.slug);
    const target = path.join(skillDir, "SKILL.md");
    if (fs.existsSync(target) && !force) {
      console.log(`Skipping ${skill.name}; ${path.relative(process.cwd(), target)} already exists. Use --force to refresh.`);
      continue;
    }
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(target, renderAgentSkill(skill), "utf8");
  }
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ source: "specregistry", installed_at: new Date().toISOString(), skills: skills.map(({ id, slug, name, description, risk_level }) => ({ id, slug, name, description, risk_level })) }, null, 2) + "\n",
    "utf8"
  );
  console.log(`Installed ${skills.length} agent skill(s) in ${path.relative(process.cwd(), outDir) || "."}/.`);
}

export function renderAgentSkill(skill: AgentSkill): string {
  return `---
name: ${skill.slug}
description: ${yamlString(skill.description)}
metadata:
  specregistry_id: ${skill.id}
  risk_level: ${skill.risk_level}
---

# ${skill.name}

${skill.description}

## Instructions

${skill.instructions.trim()}

## Safety Boundary

This skill is a governed operating procedure, not permission to take external or destructive
actions. Follow the agent host's approval policy, current published specifications, and the
principle of least privilege. Stop and ask when required authorization or intent is unclear.
`;
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}
