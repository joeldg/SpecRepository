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
          {spec.versions.length > 0 && (
            <select value={viewVersion ?? ""} onChange={(e) => setViewVersion(e.target.value || undefined)}>
              <option value="">Current ({spec.current_version})</option>
              {spec.versions.map((v) => (
                <option key={v.id} value={v.version}>
                  v{v.version} · {timeAgo(v.published_at)}
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
    </>
  );
}
