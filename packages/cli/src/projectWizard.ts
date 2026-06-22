import path from "node:path";
import readline from "node:readline/promises";
import type { ProjectType } from "@specregistry/shared";
import { fetchJson, listProjectTypes } from "./registry.js";
import { listAgentSkills, resolveAgentSkills, type AgentSkill } from "./skills.js";

export interface ProjectProfile {
  schema_version: 1;
  project_name: string;
  summary: string;
  industry: string;
  lifecycle_stage: string;
  users: string[];
  project_shapes: string[];
  languages: string[];
  frameworks: string[];
  platforms: string[];
  data_stores: string[];
  interfaces: string[];
  runtimes: string[];
  infrastructure: string[];
  identity: string[];
  messaging: string[];
  observability: string[];
  testing: string[];
  delivery: string[];
  security: string[];
  environments: string[];
  constraints: string[];
  non_goals: string[];
  agent_skills: string[];
}

export interface ProjectWizardResult {
  projectType: ProjectType;
  profile?: ProjectProfile;
  skills: AgentSkill[];
}

interface Choice {
  id: string;
  label: string;
}

const CHOICES = {
  shapes: choices("web:Web application", "api:API or backend service", "cli:CLI or developer tool", "mobile:Mobile application", "desktop:Desktop application", "library:Library or SDK", "data:Data or ML system", "embedded:Embedded or IoT", "infra:Infrastructure or platform", "game:Game"),
  languages: choices("typescript:TypeScript", "javascript:JavaScript", "python:Python", "go:Go", "rust:Rust", "java:Java", "kotlin:Kotlin", "csharp:C#", "cpp:C++", "c:C", "swift:Swift", "ruby:Ruby", "php:PHP", "dart:Dart", "sql:SQL", "shell:Shell"),
  frameworks: choices("react:React", "next:Next.js", "vue:Vue", "angular:Angular", "svelte:Svelte", "node:Node.js", "fastify:Fastify", "express:Express", "nestjs:NestJS", "django:Django", "fastapi:FastAPI", "flask:Flask", "spring:Spring Boot", "dotnet:.NET", "rails:Ruby on Rails", "flutter:Flutter", "react-native:React Native"),
  platforms: choices("browser:Web browser", "ios:iOS", "android:Android", "windows:Windows", "macos:macOS", "linux:Linux", "embedded:Embedded hardware", "edge:Edge devices", "server:Server", "serverless:Serverless"),
  data: choices("postgres:PostgreSQL", "mysql:MySQL or MariaDB", "sqlite:SQLite", "sqlserver:SQL Server", "mongodb:MongoDB", "dynamodb:DynamoDB", "redis:Redis", "elasticsearch:Elasticsearch or OpenSearch", "object:Object storage", "warehouse:Data warehouse", "vector:Vector database", "none:No persistent database"),
  interfaces: choices("rest:REST or JSON API", "graphql:GraphQL", "grpc:gRPC", "websocket:WebSocket", "events:Event-driven interfaces", "webhooks:Webhooks", "cli:CLI interface", "files:File exchange", "mcp:Model Context Protocol", "hardware:Hardware protocols"),
  runtimes: choices("containers:Containers", "kubernetes:Kubernetes", "serverless:Serverless functions", "vm:Virtual machines", "baremetal:Bare metal", "nginx:Nginx", "apache:Apache", "iis:IIS", "edge:Edge runtime", "device:On-device runtime"),
  infrastructure: choices("aws:AWS", "azure:Azure", "gcp:Google Cloud", "cloudflare:Cloudflare", "vercel:Vercel", "netlify:Netlify", "onprem:On-premises", "hybrid:Hybrid cloud", "terraform:Terraform or OpenTofu", "pulumi:Pulumi", "none:No managed infrastructure"),
  identity: choices("none:No user authentication", "sessions:Session or cookie auth", "jwt:JWT or bearer tokens", "oauth:OAuth 2.0 or OIDC", "saml:SAML", "ldap:LDAP or Active Directory", "apikey:API keys", "passkeys:Passkeys or WebAuthn", "rbac:Role-based access control", "multitenant:Multi-tenant isolation"),
  messaging: choices("none:No message broker", "kafka:Kafka", "rabbitmq:RabbitMQ", "sqs:Amazon SQS or SNS", "pubsub:Google Pub/Sub", "servicebus:Azure Service Bus", "nats:NATS", "redis:Redis queues", "cron:Scheduled jobs or cron", "workflow:Workflow engine"),
  observability: choices("logs:Structured logs", "metrics:Prometheus metrics", "traces:Distributed traces", "otel:OpenTelemetry", "sentry:Error tracking", "analytics:Product analytics", "audit:Audit logging", "alerts:Alerting and on-call", "dashboards:Operational dashboards"),
  testing: choices("unit:Unit tests", "integration:Integration tests", "e2e:End-to-end tests", "contract:Contract tests", "performance:Performance or load tests", "security:Security tests", "accessibility:Accessibility tests", "hardware:Hardware-in-the-loop tests", "manual:Manual acceptance tests"),
  delivery: choices("github:GitHub Actions", "gitlab:GitLab CI", "azure:Azure Pipelines", "jenkins:Jenkins", "circle:CircleCI", "buildkite:Buildkite", "argocd:Argo CD", "flux:Flux", "releases:Automated releases", "manual:Manual deployment"),
  security: choices("secrets:Managed secrets", "encryption:Encryption at rest and in transit", "pii:Personal data or PII", "payments:Payment data", "hipaa:HIPAA", "soc2:SOC 2", "pci:PCI DSS", "gdpr:GDPR", "fedramp:FedRAMP", "supplychain:Software supply-chain controls", "threat:Threat modeling"),
  environments: choices("local:Local development", "dev:Shared development", "test:Test or QA", "staging:Staging", "production:Production", "preview:Ephemeral previews", "dr:Disaster recovery", "airgap:Air-gapped"),
};

function choices(...values: string[]): Choice[] {
  return values.map((value) => {
    const [id, ...label] = value.split(":");
    return { id, label: label.join(":") };
  });
}

export function parseMultiSelection(input: string, options: Choice[], defaults: string[] = []): string[] {
  const trimmed = input.trim();
  if (!trimmed) return defaults;
  if (/^(none|no|off)$/i.test(trimmed)) return [];
  const result: string[] = [];
  for (const raw of trimmed.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const index = Number(token);
    const known = Number.isInteger(index) && index >= 1 && index <= options.length
      ? options[index - 1]
      : options.find((option) => option.id.toLowerCase() === token.toLowerCase() || option.label.toLowerCase() === token.toLowerCase());
    const value = known?.label ?? token;
    if (!result.some((item) => item.toLowerCase() === value.toLowerCase())) result.push(value);
  }
  return result;
}

export function renderProjectProfile(profile: ProjectProfile, projectType: string): string {
  const section = (title: string, values: string[]) => `## ${title}\n\n${values.length ? values.map((value) => `- ${value}`).join("\n") : "- None selected"}`;
  return `# ${profile.project_name} Project Profile

> Project-scoped specification draft generated by \`specreg init\`.
> Governing project type: ${projectType}
> Review and publish this profile in SpecRegistry before treating it as approved guidance.

## Intent

${profile.summary || "Intent to be defined during review."}

- Industry/domain: ${profile.industry || "Not specified"}
- Lifecycle stage: ${profile.lifecycle_stage}

${section("Users and Stakeholders", profile.users)}

## Product and Architecture

${section("Project Shapes", profile.project_shapes)}

${section("Languages", profile.languages)}

${section("Frameworks and Major Libraries", profile.frameworks)}

${section("Target Platforms", profile.platforms)}

${section("Data Stores", profile.data_stores)}

${section("Interfaces and Protocols", profile.interfaces)}

## Runtime and Operations

${section("Servers and Runtimes", profile.runtimes)}

${section("Cloud and Infrastructure", profile.infrastructure)}

${section("Environments", profile.environments)}

${section("Identity and Authorization", profile.identity)}

${section("Messaging and Background Work", profile.messaging)}

${section("Observability", profile.observability)}

## Quality and Delivery

${section("Testing", profile.testing)}

${section("CI/CD and Release", profile.delivery)}

${section("Security, Privacy, and Compliance", profile.security)}

${section("Constraints", profile.constraints)}

${section("Non-goals", profile.non_goals)}

${section("Agent Skills", profile.agent_skills)}

## Acceptance Criteria

- Architecture and implementation decisions remain consistent with this profile and all approved global and project-type specs.
- Material changes to the selected stack, platforms, data stores, interfaces, deployment model, or compliance scope update this profile through review.
- Tests, deployment evidence, and observability cover the selected capabilities before production release.

## AI Agent Directives

- Load the current governed spec set before making implementation decisions.
- Treat this project profile as project-scoped context only after it is published.
- Do not invent missing technology choices; report ambiguity or propose a reviewed profile change.
- Report conflicts between this profile and global or project-type specs through SpecRegistry feedback.
`;
}

export async function runProjectSetupWizard(server: string, token?: string, skillSelection?: string): Promise<ProjectWizardResult> {
  if (!process.stdin.isTTY) {
    throw new Error("Interactive project setup requires a terminal. Use --type <name> for a premade project type.");
  }
  const projectTypes = await listProjectTypes(server, token);
  const skillCatalog = await listAgentSkills(server, token);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\nHow would you like to initialize this repository?\n");
    console.log("  1. Guided setup for a brand-new project (default)");
    console.log("  2. Use an existing / premade project type");
    const mode = (await rl.question("\nChoose [1]: ")).trim();
    if (mode === "2" || /^existing|premade$/i.test(mode)) {
      return { projectType: await chooseExistingType(rl, projectTypes), skills: resolveAgentSkills(skillCatalog, skillSelection) };
    }

    console.log("\nNew project walkthrough");
    console.log("Choose comma-separated numbers or names. You can type any custom value even when it is not listed.\n");
    const projectName = await askRequired(rl, "Project name", path.basename(process.cwd()));
    const summary = await rl.question("One-sentence purpose: ");
    const industry = await rl.question("Industry or domain [optional]: ");
    const lifecycle = await askSingle(rl, "Lifecycle stage", ["Prototype", "Internal", "Production", "Regulated or safety-critical"], "Prototype");
    const users = commaValues(await rl.question("Primary users/stakeholders [comma-separated]: "));

    const selectedSkills = skillSelection
      ? resolveAgentSkills(skillCatalog, skillSelection)
      : await chooseAgentSkills(rl, skillCatalog);
    const profile: ProjectProfile = {
      schema_version: 1,
      project_name: projectName,
      summary: summary.trim(),
      industry: industry.trim(),
      lifecycle_stage: lifecycle,
      users,
      project_shapes: await askMulti(rl, "Product shapes", CHOICES.shapes),
      languages: await askMulti(rl, "Languages", CHOICES.languages),
      frameworks: await askMulti(rl, "Frameworks and major libraries", CHOICES.frameworks),
      platforms: await askMulti(rl, "Target platforms", CHOICES.platforms),
      data_stores: await askMulti(rl, "Databases and data stores", CHOICES.data),
      interfaces: await askMulti(rl, "Interfaces and protocols", CHOICES.interfaces),
      runtimes: await askMulti(rl, "Servers, runtimes, and packaging", CHOICES.runtimes),
      infrastructure: await askMulti(rl, "Cloud and infrastructure", CHOICES.infrastructure),
      identity: await askMulti(rl, "Authentication and authorization", CHOICES.identity),
      messaging: await askMulti(rl, "Messaging and background work", CHOICES.messaging),
      observability: await askMulti(rl, "Observability", CHOICES.observability, ["Structured logs"]),
      testing: await askMulti(rl, "Testing strategy", CHOICES.testing, ["Unit tests", "Integration tests"]),
      delivery: await askMulti(rl, "CI/CD and release", CHOICES.delivery),
      security: await askMulti(rl, "Security, privacy, and compliance", CHOICES.security, ["Managed secrets", "Encryption at rest and in transit"]),
      environments: await askMulti(rl, "Deployment environments", CHOICES.environments, ["Local development", "Production"]),
      constraints: commaValues(await rl.question("Architecture or operational constraints [comma-separated, optional]: ")),
      non_goals: commaValues(await rl.question("Explicit non-goals [comma-separated, optional]: ")),
      agent_skills: selectedSkills.map((skill) => skill.slug),
    };

    console.log("\nProfile summary:");
    console.log(`  ${profile.project_name}: ${profile.summary || "No summary provided"}`);
    console.log(`  ${profile.languages.length} language(s), ${profile.platforms.length} platform(s), ${profile.data_stores.length} data choice(s)`);
    const confirmed = (await rl.question("Continue with this profile? [Y/n]: ")).trim();
    if (/^n(o)?$/i.test(confirmed)) throw new Error("Project setup cancelled.");

    const projectType = await chooseGoverningType(rl, projectTypes, profile, server, token);
    return { projectType, profile, skills: selectedSkills };
  } finally {
    rl.close();
  }
}

async function chooseAgentSkills(rl: readline.Interface, catalog: AgentSkill[]): Promise<AgentSkill[]> {
  console.log("\nAgent skills:");
  catalog.forEach((skill, index) => {
    const marker = skill.built_in && skill.risk_level === "safe" ? "*" : " ";
    console.log(` ${marker} ${index + 1}. ${skill.slug} [${skill.risk_level}] - ${skill.description}`);
  });
  console.log("Base safe skills are marked with *. Restricted skills should be selected only when their procedure is appropriate.");
  const answer = await rl.question("Select skills [Enter=base, comma numbers/slugs, all, none]: ");
  return resolveAgentSkills(catalog, answer || "base");
}

async function askMulti(rl: readline.Interface, title: string, options: Choice[], defaults: string[] = []): Promise<string[]> {
  console.log(`\n${title}:`);
  console.log(options.map((option, index) => `${index + 1}. ${option.label}`).join("  |  "));
  const defaultText = defaults.length ? ` [Enter=${defaults.join(", ")}]` : " [Enter=none]";
  const answer = await rl.question(`Select numbers/names or type custom values${defaultText}: `);
  return parseMultiSelection(answer, options, defaults);
}

async function askSingle(rl: readline.Interface, title: string, options: string[], defaultValue: string): Promise<string> {
  console.log(`\n${title}: ${options.map((option, index) => `${index + 1}. ${option}`).join("  |  ")}`);
  const answer = (await rl.question(`Choose [${defaultValue}]: `)).trim();
  if (!answer) return defaultValue;
  const index = Number(answer);
  return Number.isInteger(index) && index >= 1 && index <= options.length ? options[index - 1] : answer;
}

async function askRequired(rl: readline.Interface, title: string, defaultValue: string): Promise<string> {
  while (true) {
    const answer = (await rl.question(`${title} [${defaultValue}]: `)).trim() || defaultValue;
    if (answer) return answer;
  }
}

async function chooseExistingType(rl: readline.Interface, projectTypes: ProjectType[]): Promise<ProjectType> {
  if (projectTypes.length === 0) throw new Error("The registry has no premade project types. Run guided setup and create one instead.");
  console.log("\nAvailable project types:\n");
  projectTypes.forEach((type, index) => console.log(`  ${index + 1}. ${type.name}${type.description ? ` - ${type.description}` : ""}`));
  while (true) {
    const answer = (await rl.question(`\nSelect [1-${projectTypes.length}]: `)).trim();
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= projectTypes.length) return projectTypes[index - 1];
    console.log("Invalid selection, try again.");
  }
}

async function chooseGoverningType(
  rl: readline.Interface,
  projectTypes: ProjectType[],
  profile: ProjectProfile,
  server: string,
  token?: string
): Promise<ProjectType> {
  console.log("\nChoose the reusable project type that supplies this project's approved baseline specs.");
  projectTypes.forEach((type, index) => console.log(`  ${index + 1}. ${type.name}${type.description ? ` - ${type.description}` : ""}`));
  console.log(`  ${projectTypes.length + 1}. Create a new project type`);
  const recommended = recommendProjectType(projectTypes, profile);
  const defaultChoice = recommended ? projectTypes.indexOf(recommended) + 1 : projectTypes.length + 1;
  while (true) {
    const answer = (await rl.question(`Select [${defaultChoice}${recommended ? ` = ${recommended.name}` : " = create new"}]: `)).trim();
    const index = answer ? Number(answer) : defaultChoice;
    if (Number.isInteger(index) && index >= 1 && index <= projectTypes.length) return projectTypes[index - 1];
    if (index === projectTypes.length + 1 || /^create|new$/i.test(answer)) {
      const name = await askRequired(rl, "New project type name", `${profile.project_name} Standard`);
      const description = (await rl.question(`Description [Baseline for ${profile.project_name} projects]: `)).trim()
        || `Baseline for ${profile.project_name} projects`;
      return await fetchJson<ProjectType>(`${server}/api/v1/project-types`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, industry: profile.industry || undefined, description }),
      }, token);
    }
    console.log("Invalid selection, try again.");
  }
}

function recommendProjectType(projectTypes: ProjectType[], profile: ProjectProfile): ProjectType | undefined {
  const terms = [...profile.project_shapes, ...profile.languages, ...profile.platforms].map((value) => value.toLowerCase());
  let best: { type: ProjectType; score: number } | undefined;
  for (const type of projectTypes) {
    const haystack = `${type.name} ${type.industry ?? ""} ${type.description ?? ""}`.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
    if (score > 0 && (!best || score > best.score)) best = { type, score };
  }
  return best?.type;
}

function commaValues(input: string): string[] {
  return input.split(",").map((value) => value.trim()).filter(Boolean);
}
