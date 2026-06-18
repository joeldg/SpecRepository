import { useEffect, useState } from "react";
import type { SpecSummary } from "@specregistry/shared";
import { api, type SpecImpactResponse } from "../api";
import { StatusBadge, timeAgo } from "../components";

export default function ImpactExplorerPage() {
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [specId, setSpecId] = useState("");
  const [delta, setDelta] = useState("minor");
  const [impact, setImpact] = useState<SpecImpactResponse>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.specs()
      .then((rows) => {
        const published = rows.filter((row) => row.status === "published");
        setSpecs(published);
        setSpecId((current) => current || published[0]?.id || "");
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!specId) return;
    setError(undefined);
    api.specImpact(specId, delta).then(setImpact).catch((e) => setError(e.message));
  }, [specId, delta]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Impact Explorer</h1>
          <span className="sub">Inspect spec consumers, dependencies, migration work, and PR-ready summaries</span>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="section">
        <div className="form-row">
          <select value={specId} onChange={(e) => setSpecId(e.target.value)}>
            {specs.map((spec) => (
              <option key={spec.id} value={spec.id}>
                {spec.filename} · {spec.project_type_name} · v{spec.current_version}
              </option>
            ))}
          </select>
          <select value={delta} onChange={(e) => setDelta(e.target.value)}>
            <option value="patch">patch</option>
            <option value="minor">minor</option>
            <option value="major">major</option>
          </select>
        </div>
      </div>

      {impact && (
        <>
          <div className="cards">
            <div className={`card${impact.impact.level === "high" || impact.impact.level === "critical" ? " alert" : ""}`}>
              <div className="label">Impact</div>
              <div><span className="mono">{impact.impact.score}/100</span> <StatusBadge status={impact.impact.level} /></div>
              <div className="dim">{impact.impact.summary}</div>
            </div>
            <div className="card">
              <div className="label">Reported consumers</div>
              <div className="metric">{impact.impact.manifest_consumers.length}</div>
            </div>
            <div className="card">
              <div className="label">Subscribed repos</div>
              <div className="metric">{impact.impact.repo_subscriptions.length}</div>
            </div>
            <div className="card">
              <div className="label">Dependent specs</div>
              <div className="metric">{impact.impact.dependent_specs.length}</div>
            </div>
          </div>

          <div className="report-grid">
            <div className="section report-panel">
              <h2>Consumers</h2>
              {impact.impact.manifest_consumers.length === 0 ? (
                <div className="empty">No projects have reported this spec yet.</div>
              ) : (
                impact.impact.manifest_consumers.slice(0, 12).map((consumer) => (
                  <div key={consumer.id} className="dim">
                    <span className="mono">{consumer.repo}</span>{consumer.branch ? `@${consumer.branch}` : ""} · {timeAgo(consumer.last_seen_at)}
                  </div>
                ))
              )}
            </div>
            <div className="section report-panel">
              <h2>Dependencies</h2>
              {impact.impact.dependent_specs.length === 0 ? (
                <div className="empty">No dependent spec references found.</div>
              ) : (
                impact.impact.dependent_specs.map((dep) => (
                  <div key={`${dep.spec_id}-${dep.relation}`} className="dim">
                    <span className="mono">{dep.filename}</span> · {dep.relation.replace("_", " ")}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="section">
            <h2>Migration Checklist</h2>
            <ul>
              {impact.migration_checklist.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>

          <div className="section">
            <h2>PR Summary</h2>
            <pre className="diff" style={{ padding: 12 }}>{impact.pr_summary_markdown}</pre>
          </div>
        </>
      )}
    </>
  );
}
