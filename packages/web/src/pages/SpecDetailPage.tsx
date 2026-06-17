import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, getAuthor, type SpecDetail } from "../api";
import { DiffView, Markdown, StatusBadge, timeAgo } from "../components";

export default function SpecDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [spec, setSpec] = useState<SpecDetail>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [delta, setDelta] = useState("minor");
  const [summary, setSummary] = useState("");
  const [viewVersion, setViewVersion] = useState<string>();

  const reload = useCallback(() => {
    if (!id) return;
    api
      .spec(id)
      .then((s) => {
        setSpec(s);
        setDraft(s.content);
      })
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(reload, [reload]);

  if (!spec) {
    return error ? <div className="error-banner">{error}</div> : <p className="dim">Loading…</p>;
  }

  const isDraft = spec.status === "draft";
  const shownVersion = spec.versions.find((v) => v.version === viewVersion);

  async function act(fn: () => Promise<unknown>, message: string) {
    setError(undefined);
    try {
      await fn();
      setNotice(message);
      setEditing(false);
      setViewVersion(undefined);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>
          <span className="mono">{spec.filename}</span>{" "}
          <span className="mono dim">v{spec.current_version}</span> <StatusBadge status={spec.status} />
        </h1>
        <span className="sub">
          Updated by {spec.updated_by} · {timeAgo(spec.updated_at)}
        </span>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {notice && !error && (
        <div className="card" style={{ marginBottom: 14 }}>
          {notice}
        </div>
      )}

      <div className="toolbar">
        {isDraft ? (
          <>
            <button className="primary" onClick={() => setEditing((v) => !v)}>
              {editing ? "Close editor" : "Edit draft"}
            </button>
            <button
              className="success"
              onClick={() => act(() => api.publishDraft(spec.id, getAuthor()), "Published as 1.0.0")}
            >
              Publish 1.0.0
            </button>
          </>
        ) : (
          <button className="primary" onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel proposal" : "Propose change"}
          </button>
        )}
        {editing && !isDraft && (
          <>
            <select value={delta} onChange={(e) => setDelta(e.target.value)}>
              <option value="major">major</option>
              <option value="minor">minor</option>
              <option value="patch">patch</option>
            </select>
            <input
              type="text"
              placeholder="Change summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              style={{ width: 260 }}
            />
            <button
              className="success"
              onClick={() =>
                act(
                  () =>
                    api.submitReview({
                      spec_id: spec.id,
                      proposed_content: draft,
                      version_delta: delta,
                      proposed_by: getAuthor(),
                      summary: summary || undefined,
                    }),
                  "Change request submitted for review"
                )
              }
            >
              Submit for review
            </button>
          </>
        )}
        {editing && isDraft && (
          <button
            className="success"
            onClick={() =>
              act(() => api.updateDraft(spec.id, { content: draft, updated_by: getAuthor() }), "Draft saved")
            }
          >
            Save draft
          </button>
        )}
        <div className="right">
          {shownVersion && (shownVersion as { channel?: string }).channel === "beta" && (
            <button
              className="success"
              onClick={() =>
                act(
                  () => api.promote(spec.id, shownVersion.version, getAuthor()),
                  `Promoted ${shownVersion.version} to stable`
                )
              }
            >
              Promote to stable
            </button>
          )}
          {spec.versions.length > 0 && (
            <select value={viewVersion ?? ""} onChange={(e) => setViewVersion(e.target.value || undefined)}>
              <option value="">Current ({spec.current_version})</option>
              {spec.versions.map((v) => (
                <option key={v.id} value={v.version}>
                  v{v.version}
                  {(v as { channel?: string }).channel === "beta" ? " [beta]" : ""} · {timeAgo(v.published_at)}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {editing ? (
        <div className="split">
          <textarea className="editor" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
          <Markdown content={draft} />
        </div>
      ) : (
        <Markdown content={shownVersion ? shownVersion.content : spec.content} />
      )}

      {spec.feedback.length > 0 && (
        <div className="section" style={{ marginTop: 28 }}>
          <h2>AI agent feedback</h2>
          <table className="grid">
            <thead>
              <tr>
                <th>Status</th>
                <th>Type</th>
                <th>Version</th>
                <th>Agent</th>
                <th>Description</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {spec.feedback.map((f) => (
                <tr key={f.id}>
                  <td>
                    <StatusBadge status={f.status} />
                  </td>
                  <td>
                    <StatusBadge status={f.error_type} />
                  </td>
                  <td className="mono">{f.spec_version}</td>
                  <td className="mono dim">{f.agent_identifier}</td>
                  <td className="feedback-desc">
                    {f.description}
                    {f.context_code_snippet && (
                      <pre className="mono faint" style={{ margin: "6px 0 0" }}>
                        {f.context_code_snippet}
                      </pre>
                    )}
                  </td>
                  <td>
                    {f.status !== "resolved" && (
                      <button
                        onClick={() =>
                          act(() => api.setFeedbackStatus(f.id, f.status === "open" ? "acknowledged" : "resolved"),
                            "Feedback updated")
                        }
                      >
                        {f.status === "open" ? "Acknowledge" : "Resolve"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AuditPromptPanel spec={spec} onError={setError} />

      {spec.change_requests.length > 0 && (
        <div className="section" style={{ marginTop: 28 }}>
          <h2>Change requests</h2>
          <table className="grid">
            <thead>
              <tr>
                <th>Status</th>
                <th>Delta</th>
                <th>Proposed by</th>
                <th>Summary</th>
                <th>Result</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {spec.change_requests.map((cr) => (
                <tr key={cr.id}>
                  <td>
                    <Link to={`/reviews/${cr.id}`}>
                      <StatusBadge status={cr.status} />
                    </Link>
                  </td>
                  <td className="mono">{cr.version_delta}</td>
                  <td>{cr.proposed_by}</td>
                  <td className="dim">{cr.summary ?? "—"}</td>
                  <td className="mono">{cr.resulting_version ?? "—"}</td>
                  <td className="faint">{timeAgo(cr.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {spec.change_requests.some((cr) => cr.status === "pending") && (
        <div className="section" style={{ marginTop: 28 }}>
          <h2>Pending diff</h2>
          <DiffView diff={spec.change_requests.find((cr) => cr.status === "pending")!.diff} />
        </div>
      )}

      <EfficacyPanel spec={spec} onRan={reload} onError={setError} />
    </>
  );
}

function AuditPromptPanel({ spec, onError }: { spec: SpecDetail; onError: (msg: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const [useLlm, setUseLlm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const result = await api.auditPromptGet(spec.id, useLlm);
      setPrompt(result.prompt);
      setModel(result.model ? `${result.provider}/${result.model}` : null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="section" style={{ marginTop: 28 }}>
      <h2>Audit prompt</h2>
      <div className="card">
        <div className="form-row">
          <button onClick={load} disabled={loading}>
            {loading ? "Generating..." : prompt ? "Regenerate prompt" : "Generate prompt"}
          </button>
          <label className="faint">
            <input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} /> Use server LLM
          </label>
          {model && <span className="faint">Generated by {model}</span>}
        </div>
        {prompt ? (
          <pre className="diff" style={{ padding: 12, maxHeight: 420 }}>{prompt}</pre>
        ) : (
          <div className="dim">Generate a reverse-conformance prompt for this spec before running implementation audits.</div>
        )}
      </div>
    </div>
  );
}

function EfficacyPanel({
  spec,
  onRan,
  onError,
}: {
  spec: SpecDetail;
  onRan: () => void;
  onError: (msg: string) => void;
}) {
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);

  async function run() {
    if (!task.trim()) return;
    setRunning(true);
    try {
      await api.runEfficacy(spec.id, task.trim());
      setTask("");
      onRan();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="section" style={{ marginTop: 28 }}>
      <h2>Spec efficacy</h2>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="form-row">
          <input
            type="text"
            placeholder='Task to A/B test, e.g. "Add a login endpoint to the service"'
            value={task}
            style={{ flex: 1, minWidth: 320 }}
            onChange={(e) => setTask(e.target.value)}
          />
          <button className="primary" disabled={running} onClick={run}>
            {running ? "Running A/B…" : "Run A/B test"}
          </button>
        </div>
        <span className="faint">
          Generates a response with and without this spec in context, then grades both for spec adherence.
          Requires a configured server LLM provider; takes ~a minute.
        </span>
      </div>
      {spec.efficacy_runs.length > 0 && (
        <table className="grid">
          <thead>
            <tr>
              <th>Task</th>
              <th>With spec</th>
              <th>Without</th>
              <th>Verdict</th>
              <th>Rationale</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {spec.efficacy_runs.map((run) => (
              <tr key={run.id}>
                <td className="dim feedback-desc">{run.task_prompt}</td>
                <td className="mono">{run.score_with}</td>
                <td className="mono">{run.score_without}</td>
                <td>
                  {run.improved ? (
                    <span className="badge approved">earns its tokens</span>
                  ) : (
                    <span className="badge rejected">no lift</span>
                  )}
                </td>
                <td className="dim feedback-desc">{run.rationale}</td>
                <td className="faint">{timeAgo(run.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
