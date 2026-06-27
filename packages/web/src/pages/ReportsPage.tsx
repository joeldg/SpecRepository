import { useEffect, useMemo, useState } from "react";
import type { SpecSummary } from "@specregistry/shared";
import { api, getAuthor, type DependencyMap, type EfficacyRun, type ManifestDiagnostics, type ProjectTypeWithCount, type ReportsOverview } from "../api";
import { StatusBadge, timeAgo } from "../components";

type ChartDatum = { label: string; value: number; tone?: "accent" | "green" | "amber" | "red" };

const toneColor: Record<NonNullable<ChartDatum["tone"]>, string> = {
  accent: "#5e6ad2",
  green: "#3fb950",
  amber: "#d29922",
  red: "#f85149",
};

function total(values: Array<{ n: number }>) {
  return values.reduce((sum, row) => sum + Number(row.n ?? 0), 0);
}

function BarChart({ data }: { data: ChartDatum[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="report-chart" role="img">
      {data.map((d) => (
        <div className="report-bar-row" key={d.label}>
          <div className="report-bar-label">{d.label}</div>
          <div className="report-bar-track">
            <div
              className="report-bar-fill"
              style={{ width: `${Math.max(4, (d.value / max) * 100)}%`, background: toneColor[d.tone ?? "accent"] }}
            />
          </div>
          <div className="report-bar-value mono">{d.value}</div>
        </div>
      ))}
    </div>
  );
}

function DonutChart({ data }: { data: ChartDatum[] }) {
  const sum = data.reduce((acc, item) => acc + item.value, 0);
  let offset = 25;
  return (
    <div className="donut-wrap">
      <svg className="donut" viewBox="0 0 42 42" aria-hidden="true">
        <circle cx="21" cy="21" r="15.915" fill="transparent" stroke="var(--border)" strokeWidth="6" />
        {data.map((d) => {
          const length = sum ? (d.value / sum) * 100 : 0;
          const strokeDasharray = `${length} ${100 - length}`;
          const strokeDashoffset = offset;
          offset -= length;
          return (
            <circle
              key={d.label}
              cx="21"
              cy="21"
              r="15.915"
              fill="transparent"
              stroke={toneColor[d.tone ?? "accent"]}
              strokeWidth="6"
              strokeDasharray={strokeDasharray}
              strokeDashoffset={strokeDashoffset}
            />
          );
        })}
        <text x="21" y="22" textAnchor="middle" className="donut-number">
          {sum}
        </text>
      </svg>
      <div className="legend">
        {data.map((d) => (
          <span key={d.label}>
            <i style={{ background: toneColor[d.tone ?? "accent"] }} /> {d.label} <b>{d.value}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function ReportsPage() {
  const [report, setReport] = useState<ReportsOverview>();
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [types, setTypes] = useState<ProjectTypeWithCount[]>([]);
  const [dependencies, setDependencies] = useState<DependencyMap>();
  const [tokenRoi, setTokenRoi] = useState<Array<{ filename: string; approx_tokens: number; roi_score: number; open_feedback: number }>>([]);
  const [efficacyTrend, setEfficacyTrend] = useState<Array<EfficacyRun & { filename: string }>>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [specId, setSpecId] = useState("");
  const [projectType, setProjectType] = useState("");
  const [feedbackType, setFeedbackType] = useState<"ambiguity" | "contradiction" | "outdated">("ambiguity");
  const [feedbackText, setFeedbackText] = useState("Synthetic report test: verify this AI feedback appears in reports.");
  const [auditResult, setAuditResult] = useState<string>();
  const [efficacyResult, setEfficacyResult] = useState<EfficacyRun>();
  const [manifestText, setManifestText] = useState("");
  const [manifestRepo, setManifestRepo] = useState("");
  const [manifestResult, setManifestResult] = useState<ManifestDiagnostics>();
  const [busy, setBusy] = useState<string>();

  function reload() {
    setError(undefined);
    Promise.all([api.reports(), api.specs(), api.projectTypes(), api.dependencyMap(), api.tokenRoi(), api.efficacyTrends()])
      .then(([nextReport, nextSpecs, nextTypes, nextDependencies, nextTokenRoi, nextEfficacyTrend]) => {
        setReport(nextReport);
        setSpecs(nextSpecs);
        setTypes(nextTypes.filter((t) => t.scope === "project_type"));
        setDependencies(nextDependencies);
        setTokenRoi(nextTokenRoi.specs.slice(0, 8));
        setEfficacyTrend(nextEfficacyTrend.runs.slice(-8));
        setSpecId((current) => current || nextSpecs.find((s) => s.status === "published")?.id || nextSpecs[0]?.id || "");
        setProjectType((current) => current || nextTypes.find((t) => t.scope === "project_type")?.name || "");
      })
      .catch((e) => setError(e.message));
  }

  useEffect(reload, []);

  const scopeData = useMemo(() => {
    const byScope = new Map<string, number>();
    for (const row of report?.scopes ?? []) byScope.set(row.scope, (byScope.get(row.scope) ?? 0) + row.n);
    return [
      { label: "Global", value: byScope.get("global") ?? 0, tone: "green" as const },
      { label: "Project types", value: byScope.get("project_type") ?? 0, tone: "accent" as const },
      { label: "Projects", value: byScope.get("project") ?? 0, tone: "amber" as const },
    ];
  }, [report]);

  const feedbackData = useMemo(() => {
    const byType = new Map<string, number>();
    for (const row of report?.feedback_by_type ?? []) byType.set(row.error_type, (byType.get(row.error_type) ?? 0) + row.n);
    return [
      { label: "Ambiguity", value: byType.get("ambiguity") ?? 0, tone: "amber" as const },
      { label: "Contradiction", value: byType.get("contradiction") ?? 0, tone: "red" as const },
      { label: "Outdated", value: byType.get("outdated") ?? 0, tone: "accent" as const },
    ];
  }, [report]);

  async function createFeedback() {
    if (!specId) return;
    setBusy("feedback");
    setError(undefined);
    setNotice(undefined);
    try {
      const spec = specs.find((s) => s.id === specId);
      await api.createFeedback({
        spec_id: specId,
        spec_version: spec?.current_version,
        agent_identifier: "report-test-agent",
        error_type: feedbackType,
        description: feedbackText,
        context_code_snippet: "reports:test-fixture",
      });
      setNotice("Created test AI feedback.");
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function runAuditTest() {
    if (!projectType) return;
    setBusy("audit");
    setError(undefined);
    setAuditResult(undefined);
    try {
      const result = await api.runAudit({
        project_type: projectType,
        tree: "src/\nsrc/example.ts\n",
        files: [{ path: "src/example.ts", content: "export function handler() { return 'audit-report-test'; }\n" }],
      });
      setAuditResult(`${result.finding_count} findings returned`);
    } catch (e) {
      setAuditResult((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function runEfficacyTest() {
    if (!specId) return;
    setBusy("efficacy");
    setError(undefined);
    setEfficacyResult(undefined);
    try {
      const result = await api.runEfficacy(specId, "Explain how an implementation should follow this spec in one paragraph.");
      setEfficacyResult(result);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function diagnoseManifest() {
    setBusy("manifest");
    setError(undefined);
    setManifestResult(undefined);
    try {
      const manifest = JSON.parse(manifestText);
      const result = await api.manifestDiagnostics({ manifest, repo: manifestRepo || undefined });
      setManifestResult(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  const topTypes = [...(report?.project_types ?? [])]
    .sort((a, b) => b.feedback_total + b.pending_reviews - (a.feedback_total + a.pending_reviews))
    .slice(0, 8);
  const projectRisk = [...(report?.projects ?? [])]
    .sort((a, b) => b.outdated_specs + b.open_feedback + b.pending_reviews - (a.outdated_specs + a.open_feedback + a.pending_reviews))
    .slice(0, 10);
  const traceReports = [...(report?.code_trace_reports ?? [])]
    .sort((a, b) => b.drift_score - a.drift_score || a.coverage_ratio - b.coverage_ratio)
    .slice(0, 10);
  const traceSummary = useMemo(() => {
    const rows = report?.code_trace_reports ?? [];
    const governed = rows.reduce((sum, row) => sum + Number(row.governed_entity_count ?? 0), 0);
    const linked = rows.reduce((sum, row) => sum + Number(row.linked_entity_count ?? 0), 0);
    const high = rows.filter((row) => row.drift_severity === "high").length;
    return {
      projects: rows.length,
      coverage: governed ? linked / governed : 0,
      high,
      unmapped: rows.reduce((sum, row) => sum + Number(row.unlinked_entity_count ?? 0), 0),
    };
  }, [report]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <span className="sub">Granular SDD health by global specs, project type, and project</span>
        </div>
        <button onClick={reload}>Refresh</button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      {report && (
        <>
          <div className="cards">
            <div className="card">
              <div className="metric">{total(report.scopes)}</div>
              <div className="label">Tracked specs</div>
            </div>
            <div className="card">
              <div className="metric">{report.project_types.filter((t) => t.scope === "project_type").length}</div>
              <div className="label">Project types</div>
            </div>
            <div className="card">
              <div className="metric">{report.projects.length}</div>
              <div className="label">Projects</div>
            </div>
            <div className={`card${feedbackData.some((d) => d.value) ? " alert" : ""}`}>
              <div className="metric">{feedbackData.reduce((sum, d) => sum + d.value, 0)}</div>
              <div className="label">AI feedback items</div>
            </div>
          </div>

          <div className="report-grid">
            <div className="section report-panel">
              <h2>Spec Scope Mix</h2>
              <DonutChart data={scopeData} />
            </div>
            <div className="section report-panel">
              <h2>AI Feedback Mix</h2>
              <BarChart data={feedbackData} />
            </div>
          </div>

          <div className="report-grid">
            <div className="section report-panel">
              <h2>Dependency Map</h2>
              <div className="cards" style={{ marginBottom: 12 }}>
                <div className="card">
                  <div className="metric">{dependencies?.edges.length ?? 0}</div>
                  <div className="label">Spec links</div>
                </div>
                <div className={`card${dependencies?.unresolved.length ? " alert" : ""}`}>
                  <div className="metric">{dependencies?.unresolved.length ?? 0}</div>
                  <div className="label">Unresolved refs</div>
                </div>
              </div>
              {(dependencies?.edges ?? []).slice(0, 8).map((edge) => (
                <div key={`${edge.from_spec_id}-${edge.to_filename}-${edge.relation}`} className="dim">
                  <span className="mono">{edge.from_filename}</span> {edge.relation.replace("_", " ")}{" "}
                  <span className="mono">{edge.to_filename}</span>
                </div>
              ))}
            </div>
            <div className="section report-panel">
              <h2>Token ROI</h2>
              <BarChart data={tokenRoi.map((row) => ({ label: row.filename, value: Math.max(0, row.roi_score), tone: row.open_feedback ? "amber" : "green" }))} />
            </div>
          </div>

          <div className="section report-panel">
            <h2>Efficacy Trend</h2>
            {efficacyTrend.length === 0 ? (
              <div className="empty">No efficacy runs yet.</div>
            ) : (
              <BarChart
                data={efficacyTrend.map((run) => ({
                  label: `${run.filename} ${new Date(run.created_at).toLocaleDateString()}`,
                  value: Math.max(0, run.score_with - run.score_without),
                  tone: run.improved ? "green" : "amber",
                }))}
              />
            )}
          </div>

          <div className="section report-panel">
            <h2>Code-to-Spec Traceability</h2>
            <div className="cards" style={{ marginBottom: 12 }}>
              <div className="card">
                <div className="metric">{traceSummary.projects}</div>
                <div className="label">Reporting projects</div>
              </div>
              <div className={`card${traceSummary.coverage < 0.5 && traceSummary.projects ? " alert" : ""}`}>
                <div className="metric">{Math.round(traceSummary.coverage * 100)}%</div>
                <div className="label">Code coverage</div>
              </div>
              <div className={`card${traceSummary.high ? " alert" : ""}`}>
                <div className="metric">{traceSummary.high}</div>
                <div className="label">High drift projects</div>
              </div>
              <div className="card">
                <div className="metric">{traceSummary.unmapped}</div>
                <div className="label">Unmapped entities</div>
              </div>
            </div>
            {traceReports.length === 0 ? (
              <div className="empty">No code trace reports yet. Run `specreg code-map --report` from a project.</div>
            ) : (
              <BarChart
                data={traceReports.map((row) => ({
                  label: row.repo,
                  value: Math.round(row.drift_score * 100),
                  tone: row.drift_severity === "high" ? "red" : row.drift_severity === "medium" ? "amber" : "green",
                }))}
              />
            )}
          </div>

          <div className="section">
            <h2>Project Type Reports</h2>
            <table className="grid">
              <thead>
                <tr>
                  <th>Project type</th>
                  <th>Specs</th>
                  <th>Projects</th>
                  <th>Usage</th>
                  <th>Open feedback</th>
                  <th>Pending reviews</th>
                  <th>Efficacy</th>
                  <th>Stale</th>
                </tr>
              </thead>
              <tbody>
                {topTypes.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td className="mono">{t.published_specs}/{t.spec_count} published · {t.project_spec_count} project</td>
                    <td className="mono">{t.project_count}</td>
                    <td className="mono">
                      {(t.usage.agent_read ?? 0) + (t.usage.search ?? 0) + (t.usage.download ?? 0)} events
                    </td>
                    <td><StatusBadge status={t.open_feedback ? "open" : "resolved"} /> <span className="mono">{t.open_feedback}</span></td>
                    <td><StatusBadge status={t.pending_reviews ? "pending" : "approved"} /> <span className="mono">{t.pending_reviews}</span></td>
                    <td className="mono">{t.efficacy_improved}/{t.efficacy_runs} improved</td>
                    <td className="mono">{t.stale_specs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="section">
            <h2>Project Reports</h2>
            {projectRisk.length === 0 ? (
              <div className="empty">No projects have reported manifests yet.</div>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Project type</th>
                    <th>Reported specs</th>
                    <th>Project specs</th>
                    <th>Outdated</th>
                    <th>Code coverage</th>
                    <th>Code drift</th>
                    <th>Open feedback</th>
                    <th>Pending reviews</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {projectRisk.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.repo}</td>
                      <td>{p.project_type_name}</td>
                      <td className="mono">{p.reported_specs}</td>
                      <td className="mono">{p.project_specs}</td>
                      <td><StatusBadge status={p.outdated_specs ? "pending" : "approved"} /> <span className="mono">{p.outdated_specs}</span></td>
                      <td className="mono">
                        {p.code_trace_report_id ? `${Math.round(Number(p.code_coverage_ratio ?? 0) * 100)}% (${p.code_linked_entity_count ?? 0}/${p.code_governed_entity_count ?? 0})` : "not reported"}
                      </td>
                      <td>
                        {p.code_trace_report_id ? (
                          <>
                            <StatusBadge status={p.code_drift_severity ?? "none"} /> <span className="mono">{Number(p.code_drift_score ?? 0).toFixed(2)}</span>
                          </>
                        ) : (
                          <span className="faint">none</span>
                        )}
                      </td>
                      <td><StatusBadge status={p.open_feedback ? "open" : "resolved"} /> <span className="mono">{p.open_feedback}</span></td>
                      <td><StatusBadge status={p.pending_reviews ? "pending" : "approved"} /> <span className="mono">{p.pending_reviews}</span></td>
                      <td className="faint">{timeAgo(p.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="section report-panel">
            <h2>Manifest Drift Diagnostics</h2>
            <div className="form-row">
              <input
                value={manifestRepo}
                onChange={(e) => setManifestRepo(e.target.value)}
                placeholder="Optional repo override, e.g. github.com/org/repo"
              />
              <button className="primary" disabled={!manifestText.trim() || busy === "manifest"} onClick={diagnoseManifest}>
                {busy === "manifest" ? "Checking..." : "Check manifest"}
              </button>
            </div>
            <textarea
              value={manifestText}
              onChange={(e) => setManifestText(e.target.value)}
              rows={8}
              placeholder="Paste specs/.specregistry.json"
              style={{ marginTop: 10 }}
            />
            {manifestResult && (
              <>
                <div className="cards" style={{ marginTop: 12 }}>
                  <div className={`card${manifestResult.drift ? " alert" : ""}`}>
                    <div className="label">Drift</div>
                    <div><StatusBadge status={manifestResult.drift ? "pending" : "approved"} /> {manifestResult.project_type}</div>
                    <div className="dim">{manifestResult.project ?? "No project repo supplied"}</div>
                  </div>
                  <div className="card">
                    <div className="label">Up to date</div>
                    <div className="mono">{manifestResult.up_to_date.length}/{manifestResult.latest_count}</div>
                  </div>
                  <div className={`card${manifestResult.breaking_count ? " alert" : ""}`}>
                    <div className="label">Breaking drift</div>
                    <div className="mono">{manifestResult.breaking_count}</div>
                  </div>
                  <div className="card">
                    <div className="label">Local only</div>
                    <div className="mono">{manifestResult.local_only_count}</div>
                  </div>
                </div>
                <table className="grid" style={{ marginTop: 12 }}>
                  <thead>
                    <tr>
                      <th>Spec</th>
                      <th>Local</th>
                      <th>Registry</th>
                      <th>Severity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manifestResult.outdated.map((row) => (
                      <tr key={row.filename}>
                        <td className="mono">{row.filename}</td>
                        <td className="mono">{row.local_version}</td>
                        <td className="mono">{row.latest_version}</td>
                        <td><StatusBadge status={row.severity} /> {!row.within_pin && <span className="badge rejected">outside pin</span>}</td>
                      </tr>
                    ))}
                    {manifestResult.missing_locally.map((row) => (
                      <tr key={row.filename}>
                        <td className="mono">{row.filename}</td>
                        <td className="faint">missing</td>
                        <td className="mono">{row.latest_version}</td>
                        <td><StatusBadge status="pending" /></td>
                      </tr>
                    ))}
                    {manifestResult.not_on_server.map((filename) => (
                      <tr key={filename}>
                        <td className="mono">{filename}</td>
                        <td className="faint">local</td>
                        <td className="faint">not governed</td>
                        <td><StatusBadge status="draft" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>

          <div className="section">
            <h2>Global Spec Reports</h2>
            <table className="grid">
              <thead>
                <tr>
                  <th>Spec</th>
                  <th>Status</th>
                  <th>Feedback</th>
                  <th>Reviews</th>
                  <th>Efficacy</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {report.global_specs.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.filename}</td>
                    <td><StatusBadge status={s.status} /></td>
                    <td className="mono">{s.open_feedback} open / {s.feedback_total} total</td>
                    <td className="mono">{s.pending_reviews} pending</td>
                    <td className="mono">{s.efficacy_improved}/{s.efficacy_runs} improved</td>
                    <td className="faint">{timeAgo(s.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="section report-panel">
            <h2>AI Reporting Test Bench</h2>
            <div className="form-row">
              <select value={specId} onChange={(e) => setSpecId(e.target.value)}>
                {specs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.filename} · {s.project_type_name} · v{s.current_version}
                  </option>
                ))}
              </select>
              <select value={feedbackType} onChange={(e) => setFeedbackType(e.target.value as typeof feedbackType)}>
                <option value="ambiguity">Ambiguity</option>
                <option value="contradiction">Contradiction</option>
                <option value="outdated">Outdated</option>
              </select>
              <button className="primary" disabled={!specId || busy === "feedback"} onClick={createFeedback}>
                {busy === "feedback" ? "Creating..." : "Create test feedback"}
              </button>
              <button disabled={!specId || busy === "efficacy"} onClick={runEfficacyTest}>
                {busy === "efficacy" ? "Running..." : "Run efficacy test"}
              </button>
            </div>
            <textarea value={feedbackText} onChange={(e) => setFeedbackText(e.target.value)} rows={3} />
            <div className="form-row" style={{ marginTop: 10 }}>
              <select value={projectType} onChange={(e) => setProjectType(e.target.value)}>
                {types.map((t) => (
                  <option key={t.id} value={t.name}>{t.name}</option>
                ))}
              </select>
              <button disabled={!projectType || busy === "audit"} onClick={runAuditTest}>
                {busy === "audit" ? "Running..." : "Run audit smoke test"}
              </button>
              <span className="faint">Actor: {getAuthor()}</span>
            </div>
            {auditResult && <div className="mono dim">Audit result: {auditResult}</div>}
            {efficacyResult && (
              <div className="mono dim">
                Efficacy: with {efficacyResult.score_with}, without {efficacyResult.score_without}, model {efficacyResult.model}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
