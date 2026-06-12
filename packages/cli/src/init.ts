import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { selectProjectType } from "./registry.js";

export interface InitOptions {
  server: string;
  type?: string;
  dir: string;
}

export async function runInit(opts: InitOptions): Promise<void> {
  const projectType = await selectProjectType(opts.server, opts.type);
  console.log(`\nFetching latest approved specs for "${projectType.name}"...`);

  const url = `${opts.server}/api/v1/specs/${encodeURIComponent(projectType.name)}/download`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));

  const outDir = path.resolve(process.cwd(), opts.dir);
  fs.mkdirSync(outDir, { recursive: true });
  zip.extractAllTo(outDir, true);

  const entries = zip.getEntries().filter((e) => e.entryName !== ".specregistry.json");
  console.log(`\nWrote ${entries.length} spec file(s) to ${path.relative(process.cwd(), outDir) || "."}/:`);
  for (const entry of entries) {
    console.log(`  - ${entry.entryName}`);
  }
  console.log(`\nManifest saved as ${opts.dir}/.specregistry.json (records versions for future syncs).`);

  writeMcpConfig(opts.server, projectType.name);
}

/**
 * Drop a .mcp.json so MCP-capable agents (Claude Code etc.) in this repo can query
 * the registry and file feedback natively. Existing files are left untouched.
 */
function writeMcpConfig(server: string, projectType: string): void {
  const mcpPath = path.resolve(process.cwd(), ".mcp.json");
  if (fs.existsSync(mcpPath)) {
    console.log(".mcp.json already exists; not overwriting (add a 'specregistry' server manually if wanted).");
    return;
  }
  fs.writeFileSync(
    mcpPath,
    JSON.stringify(
      {
        mcpServers: {
          specregistry: {
            command: "specreg-mcp",
            args: [],
            env: { SPECREG_SERVER: server, SPECREG_PROJECT_TYPE: projectType },
          },
        },
      },
      null,
      2
    ) + "\n"
  );
  console.log("Wrote .mcp.json — AI agents in this repo can now read specs and file feedback via MCP.");
}
