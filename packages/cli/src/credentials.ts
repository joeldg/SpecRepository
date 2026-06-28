import fs from "node:fs";
import path from "node:path";

export interface StoredCredentials {
  server: string;
  repo: string;
  username: string;
  role: string;
  token: string;
  enrolled_at: string;
}

const CRED_PATH = ".spec/credentials.json";

function credFile(): string {
  return path.resolve(process.cwd(), CRED_PATH);
}

/** Read the locally stored agent token, if any. */
export function readStoredCredentials(): StoredCredentials | undefined {
  try {
    return JSON.parse(fs.readFileSync(credFile(), "utf8")) as StoredCredentials;
  } catch {
    return undefined;
  }
}

export function storeCredentials(cred: StoredCredentials): void {
  const file = credFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cred, null, 2) + "\n", { mode: 0o600 });
  ensureGitignored();
}

/** Keep the agent token out of version control. */
function ensureGitignored(): void {
  const gi = path.resolve(process.cwd(), ".gitignore");
  const entry = ".spec/credentials.json";
  try {
    const current = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
    if (!current.split("\n").some((l) => l.trim() === entry)) {
      fs.appendFileSync(gi, (current && !current.endsWith("\n") ? "\n" : "") + entry + "\n");
    }
  } catch {
    // best-effort; never fail a command over .gitignore
  }
}

/**
 * Self-enroll an agent identity for this repo and persist the token. Returns the
 * token, or undefined if enrollment is disabled on the server (auth-required with
 * no SPECREG_ENROLL_SECRET) — callers then proceed unauthenticated.
 */
export async function enrollAgent(
  server: string,
  repo: string,
  projectType: string
): Promise<string | undefined> {
  const existing = readStoredCredentials();
  if (existing?.token && existing.server === server && existing.repo === repo) {
    return existing.token;
  }
  const enrollSecret = process.env.SPECREG_ENROLL_SECRET;
  let res: Response;
  try {
    res = await fetch(`${server}/api/v1/agents/enroll`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(enrollSecret ? { "x-enroll-secret": enrollSecret } : {}),
      },
      body: JSON.stringify({ repo, project_type: projectType }),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) {
    return undefined;
  }
  const data = (await res.json()) as { token: string; username: string; role: string };
  storeCredentials({
    server,
    repo,
    username: data.username,
    role: data.role,
    token: data.token,
    enrolled_at: new Date().toISOString(),
  });
  return data.token;
}
