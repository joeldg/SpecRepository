import readline from "node:readline/promises";
import type { ProjectType } from "@specregistry/shared";

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error(`Could not reach the registry server at ${new URL(url).origin}. Is it running?`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      detail = body.message ?? body.error ?? detail;
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

/** Resolve a project type by flag value, or interactively if none was given. */
export async function selectProjectType(server: string, typeName?: string): Promise<ProjectType> {
  const all = await fetchJson<ProjectType[]>(`${server}/api/v1/project-types`);
  const selectable = all.filter((t) => t.scope === "project_type");
  if (selectable.length === 0) {
    throw new Error("The registry has no project types configured yet.");
  }

  if (typeName) {
    const match = selectable.find((t) => t.name.toLowerCase() === typeName.toLowerCase());
    if (!match) {
      throw new Error(
        `Unknown project type "${typeName}". Available: ${selectable.map((t) => t.name).join(", ")}`
      );
    }
    return match;
  }

  console.log("\nAvailable project types:\n");
  selectable.forEach((t, i) => {
    const industry = t.industry ? `  [${t.industry}]` : "";
    console.log(`  ${i + 1}. ${t.name}${industry}`);
    if (t.description) console.log(`     ${t.description}`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await rl.question(`\nSelect a project type [1-${selectable.length}]: `);
      const n = Number(answer.trim());
      if (Number.isInteger(n) && n >= 1 && n <= selectable.length) {
        return selectable[n - 1];
      }
      console.log("Invalid selection, try again.");
    }
  } finally {
    rl.close();
  }
}
