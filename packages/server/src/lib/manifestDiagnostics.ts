import { driftSeverity, satisfiesCaret, type SyncCheckResponse } from "@specregistry/shared";
import type { Db } from "../db.js";
import { findProjectConsumer, requireProjectType } from "../helpers.js";
import { bundleSpecs } from "./compile.js";

export interface LocalManifestSpec {
  filename: string;
  version: string;
  pin?: string;
  project_type?: string;
  scope?: string;
  sha256?: string;
}

export interface ManifestDiagnostics extends SyncCheckResponse {
  project_type_id: string;
  project_id: string | null;
  project: string | null;
  local_count: number;
  latest_count: number;
  latest_specs: Array<{
    filename: string;
    latest_version: string;
    scope: "global" | "project_type" | "project";
    project_type: string;
  }>;
  local_only_count: number;
  breaking_count: number;
}

export function diagnoseManifest(
  db: Db,
  input: {
    project_type: string;
    repo?: string;
    project_id?: string;
    specs: LocalManifestSpec[];
  }
): ManifestDiagnostics {
  const pt = requireProjectType(db, input.project_type);
  const project =
    input.project_id
      ? findProjectConsumer(db, input.project_id, pt.id)
      : input.repo
        ? findProjectConsumer(db, input.repo, pt.id)
        : undefined;
  const latest = bundleSpecs(db, pt.id, "stable", project?.id);
  const typeNames = db.prepare("SELECT id, name, scope FROM project_types").all() as Array<{
    id: string;
    name: string;
    scope: "global" | "project_type";
  }>;
  const namesById = new Map(typeNames.map((type) => [type.id, type]));
  const latestByName = new Map(latest.map((spec) => [spec.filename, spec]));

  const up_to_date: string[] = [];
  const outdated: SyncCheckResponse["outdated"] = [];
  const not_on_server: string[] = [];
  for (const file of input.specs) {
    const serverSpec = latestByName.get(file.filename);
    if (!serverSpec) {
      not_on_server.push(file.filename);
    } else if (serverSpec.current_version === file.version) {
      up_to_date.push(file.filename);
    } else {
      outdated.push({
        filename: file.filename,
        local_version: file.version,
        latest_version: serverSpec.current_version,
        severity: driftSeverity(file.version, serverSpec.current_version),
        within_pin: file.pin ? satisfiesCaret(serverSpec.current_version, file.pin) : true,
      });
    }
  }

  const localNames = new Set(input.specs.map((file) => file.filename));
  const missing_locally = latest
    .filter((spec) => !localNames.has(spec.filename))
    .map((spec) => ({ filename: spec.filename, latest_version: spec.current_version }));
  const latest_specs = latest.map((spec) => {
    const type = namesById.get(spec.project_type_id);
    return {
      filename: spec.filename,
      latest_version: spec.current_version,
      scope: spec.project_id ? "project" as const : type?.scope === "global" ? "global" as const : "project_type" as const,
      project_type: spec.project_id ? project?.repo ?? "Project" : type?.name ?? "Unknown",
    };
  });

  return {
    project_type: pt.name,
    project_type_id: pt.id,
    project_id: project?.id ?? null,
    project: project?.repo ?? input.repo ?? null,
    up_to_date,
    outdated,
    missing_locally,
    not_on_server,
    drift: outdated.length > 0 || missing_locally.length > 0,
    local_count: input.specs.length,
    latest_count: latest.length,
    latest_specs,
    local_only_count: not_on_server.length,
    breaking_count: outdated.filter((file) => file.severity === "major" || !file.within_pin).length,
  };
}
