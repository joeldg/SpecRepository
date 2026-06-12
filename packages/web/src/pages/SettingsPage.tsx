import { useCallback, useEffect, useState } from "react";
import type { Webhook } from "@specregistry/shared";
import { api, type ProjectTypeWithCount, type SubscriptionRow, type SyncJobRow } from "../api";
import { StatusBadge, timeAgo } from "../components";

const WEBHOOK_EVENTS = ["spec.published", "review.submitted", "review.approved", "review.rejected", "feedback.created"];

export default function SettingsPage() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [subs, setSubs] = useState<SubscriptionRow[]>([]);
  const [jobs, setJobs] = useState<SyncJobRow[]>([]);
  const [types, setTypes] = useState<ProjectTypeWithCount[]>([]);
  const [error, setError] = useState<string>();

  const [hookUrl, setHookUrl] = useState("");
  const [hookFormat, setHookFormat] = useState("json");
  const [subTypeId, setSubTypeId] = useState("");
  const [subRepo, setSubRepo] = useState("");
  const [subBranch, setSubBranch] = useState("main");
  const [subPath, setSubPath] = useState("specs");

  const reload = useCallback(() => {
    Promise.all([api.webhooks(), api.subscriptions(), api.syncJobs(), api.projectTypes()])
      .then(([w, s, j, t]) => {
        setWebhooks(w);
        setSubs(s);
        setJobs(j);
        setTypes(t);
        setSubTypeId((current) => current || t[0]?.id || "");
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(reload, [reload]);

  async function act(fn: () => Promise<unknown>) {
    setError(undefined);
    try {
      await fn();
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <span className="sub">Notifications and git distribution</span>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="section">
        <h2>Webhooks</h2>
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="form-row">
            <input
              type="text"
              placeholder="https://hooks.slack.com/services/… or any HTTPS endpoint"
              value={hookUrl}
              style={{ flex: 1, minWidth: 320 }}
              onChange={(e) => setHookUrl(e.target.value)}
            />
            <select value={hookFormat} onChange={(e) => setHookFormat(e.target.value)}>
              <option value="json">JSON payload</option>
              <option value="slack">Slack message</option>
            </select>
            <button
              className="primary"
              onClick={() => act(() => api.createWebhook({ url: hookUrl, events: [], format: hookFormat }))}
            >
              Add webhook
            </button>
          </div>
          <span className="faint">Fires on: {WEBHOOK_EVENTS.join(", ")}</span>
        </div>
        {webhooks.length === 0 ? (
          <div className="empty">No webhooks configured.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>URL</th>
                <th>Format</th>
                <th>Events</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {webhooks.map((w) => (
                <tr key={w.id}>
                  <td className="mono">{w.url}</td>
                  <td>{w.format}</td>
                  <td className="dim">{(JSON.parse(w.events) as string[]).join(", ") || "all"}</td>
                  <td>
                    <button className="danger" onClick={() => act(() => api.deleteWebhook(w.id))}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="section">
        <h2>Repo subscriptions (git push-back)</h2>
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="form-row">
            <select value={subTypeId} onChange={(e) => setSubTypeId(e.target.value)}>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.scope === "global" ? `${t.name} (global)` : t.name}
                </option>
              ))}
            </select>
            <input type="text" placeholder="owner/repo" value={subRepo} onChange={(e) => setSubRepo(e.target.value)} />
            <input type="text" value={subBranch} style={{ width: 90 }} onChange={(e) => setSubBranch(e.target.value)} />
            <input type="text" value={subPath} style={{ width: 90 }} onChange={(e) => setSubPath(e.target.value)} />
            <button
              className="primary"
              onClick={() =>
                act(() =>
                  api.createSubscription({ project_type_id: subTypeId, repo: subRepo, branch: subBranch, base_path: subPath })
                )
              }
            >
              Subscribe repo
            </button>
          </div>
          <span className="faint">
            Approved spec versions open PRs against subscribed repos. Requires GITHUB_TOKEN on the server.
          </span>
        </div>
        {subs.length === 0 ? (
          <div className="empty">No repos subscribed.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Project type</th>
                <th>Repo</th>
                <th>Branch</th>
                <th>Path</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id}>
                  <td>{s.project_type_name}</td>
                  <td className="mono">{s.repo}</td>
                  <td className="mono">{s.branch}</td>
                  <td className="mono">{s.base_path}/</td>
                  <td>
                    <button className="danger" onClick={() => act(() => api.deleteSubscription(s.id))}>
                      Unsubscribe
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="section">
        <h2>
          Sync jobs{" "}
          <button style={{ marginLeft: 8 }} onClick={() => act(() => api.runSyncJobs())}>
            Run pending
          </button>
        </h2>
        {jobs.length === 0 ? (
          <div className="empty">No sync jobs yet — approve a spec change for a subscribed project type.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Status</th>
                <th>Spec</th>
                <th>Version</th>
                <th>Repo</th>
                <th>Detail</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>
                    <StatusBadge status={j.status === "done" ? "approved" : j.status === "error" ? "rejected" : "pending"} />
                  </td>
                  <td className="mono">{j.filename}</td>
                  <td className="mono">{j.version}</td>
                  <td className="mono">{j.repo}</td>
                  <td className="dim">{j.detail ?? "—"}</td>
                  <td className="faint">{timeAgo(j.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
