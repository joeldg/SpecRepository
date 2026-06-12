#!/usr/bin/env node
import { runInit } from "./init.js";
import { runGenerate } from "./generate.js";

const HELP = `specreg — SpecRegistry developer CLI

Usage:
  specreg init      Pull approved specs for a project type into ./specs/
  specreg generate  Scan this codebase and fetch LLM prompts to generate missing specs

Options:
  --server <url>    Registry server (default: $SPECREG_SERVER or http://localhost:4000)
  --type <name>     Project type name (skips the interactive prompt)
  --dir <path>      init: output directory (default: specs)
  --out <path>      generate: prompt output directory (default: .spec/prompts)
  -h, --help        Show this help
`;

interface Args {
  command: string | undefined;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg === "-h") {
      flags.help = true;
    } else if (!command) {
      command = arg;
    }
  }
  return { command, flags };
}

const { command, flags } = parseArgs(process.argv.slice(2));
const server =
  (typeof flags.server === "string" ? flags.server : undefined) ??
  process.env.SPECREG_SERVER ??
  "http://localhost:4000";

try {
  if (flags.help || command === undefined || command === "help") {
    console.log(HELP);
  } else if (command === "init") {
    await runInit({
      server,
      type: typeof flags.type === "string" ? flags.type : undefined,
      dir: typeof flags.dir === "string" ? flags.dir : "specs",
    });
  } else if (command === "generate") {
    await runGenerate({
      server,
      type: typeof flags.type === "string" ? flags.type : undefined,
      out: typeof flags.out === "string" ? flags.out : ".spec/prompts",
    });
  } else {
    console.error(`Unknown command: ${command}\n`);
    console.log(HELP);
    process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
