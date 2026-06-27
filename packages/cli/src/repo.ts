import { execFileSync } from "node:child_process";
import path from "node:path";
import { fetchJson } from "./registry.js";
import type { CodeTraceReport } from "./codeMetadata.js";

export interface ManifestSpec {
  filename: string;
  version: string;
  project_type?: string;
  sha256?: string;
  pin?: string;
}

export interface Manifest {
  project_type: string;
  specs: ManifestSpec[];
}

function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function repoIdentity(): { repo: string; branch?: string; commit_sha?: string } {
  const configured = process.env.SPECREG_REPO;
  const remote = configured || git(["config", "--get", "remote.origin.url"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = git(["rev-parse", "HEAD"]);
  return {
    repo: normalizeRemote(remote) || path.basename(process.cwd()),
    branch,
    commit_sha: commit,
  };
}

function normalizeRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const ssh = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  try {
    const url = new URL(remote);
    return `${url.hostname}/${url.pathname.replace(/^\//, "").replace(/\.git$/, "")}`;
  } catch {
    return remote.replace(/\.git$/, "");
  }
}

export async function reportManifest(
  server: string,
  token: string | undefined,
  manifest: Manifest,
  dir: string,
  source: string
): Promise<{ project_id: string }> {
  const identity = repoIdentity();
  return await fetchJson<{ project_id: string }>(`${server}/api/v1/cli/manifest-report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...identity,
      project_type: manifest.project_type,
      specs: manifest.specs,
      specs_path: dir,
      manifest_path: `${dir.replace(/\/+$/, "")}/.specregistry.json`,
      source,
    }),
  }, token);
}

export async function reportCodeTrace(
  server: string,
  token: string | undefined,
  projectType: string,
  trace: CodeTraceReport,
  dir: string
): Promise<{ report_id: string; project_id: string; coverage_ratio: number; drift_score: number; drift_severity: string }> {
  const identity = repoIdentity();
  return await fetchJson<{ report_id: string; project_id: string; coverage_ratio: number; drift_score: number; drift_severity: string }>(`${server}/api/v1/cli/code-trace-report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...identity,
      project_type: projectType,
      specs_path: dir,
      manifest_path: `${dir.replace(/\/+$/, "")}/.specregistry.json`,
      source: "code-map",
      trace,
    }),
  }, token);
}
