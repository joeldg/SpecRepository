import fs from "node:fs";
import path from "node:path";

const IGNORED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".cache",
]);

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".cc": "C++",
  ".hpp": "C++",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".rb": "Ruby",
  ".cs": "C#",
  ".php": "PHP",
  ".sh": "Shell",
  ".sql": "SQL",
  ".vhd": "VHDL",
  ".v": "Verilog",
  ".sv": "SystemVerilog",
};

export interface ScanResult {
  tree: string;
  languages: string[];
  fileCount: number;
}

/** Walk a directory and produce an indented tree plus detected languages, ordered by prevalence. */
export function scanDirectory(root: string, maxDepth = 4, maxEntriesPerDir = 50): ScanResult {
  const langCounts = new Map<string, number>();
  const lines: string[] = [path.basename(root) + "/"];
  let fileCount = 0;

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    let shown = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const indent = "  ".repeat(depth);
      if (shown >= maxEntriesPerDir) {
        lines.push(`${indent}… (${entries.length - shown} more)`);
        break;
      }
      shown++;
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        walk(full, depth + 1);
      } else {
        fileCount++;
        lines.push(`${indent}${entry.name}`);
        const lang = LANGUAGE_BY_EXT[path.extname(entry.name).toLowerCase()];
        if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
      }
    }
  }

  walk(root, 1);
  const languages = [...langCounts.entries()].sort((a, b) => b[1] - a[1]).map(([lang]) => lang);
  return { tree: lines.join("\n"), languages, fileCount };
}
