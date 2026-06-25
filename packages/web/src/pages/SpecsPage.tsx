import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SpecSummary, SpecTemplate } from "@specregistry/shared";
import { api, getAuthor, type ProjectTypeWithCount } from "../api";
import { StatusBadge, timeAgo } from "../components";

type DeletedSpec = SpecSummary & { deleted_at: string };

export default function SpecsPage() {
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [types, setTypes] = useState<ProjectTypeWithCount[]>([]);
  const [templates, setTemplates] = useState<SpecTemplate[]>([]);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [newTypeId, setNewTypeId] = useState("");
  const [newFilename, setNewFilename] = useState("");
  const [showDeleted, setShowDeleted] = useState(false);
  const [deletedSpecs, setDeletedSpecs] = useState<DeletedSpec[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);
  const navigate = useNavigate();

  function reload() {
    Promise.all([api.specs(), api.projectTypes(), api.templates()])
      .then(([s, t, tpl]) => {
        setSpecs(s);
        setTypes(t);
        setTemplates(tpl);
        if (!newTypeId && t.length) setNewTypeId(t[0].id);
      })
      .catch((e) => setError(e.message));
  }

  useEffect(reload, []);

  function loadDeleted() {
    api.deletedSpecs().then(setDeletedSpecs).catch((e) => setError(e.message));
  }

  const grouped = useMemo(() => {
    const groups = new Map<string, SpecSummary[]>();
    for (const spec of specs) {
      const key = spec.project_type_name;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(spec);
    }
    return [...groups.entries()];
  }, [specs]);

  async function createSpec() {
    if (!newFilename.trim()) return;
    const filename = newFilename.trim();
    const template = templates.find(
      (t) => t.filename.toLowerCase() === filename.toLowerCase() && t.content_template.trim()
    );
    try {
      const spec = await api.createSpec({
        project_type_id: newTypeId,
        filename,
        content: template?.content_template ?? `# ${filename.replace(/\.md$/i, "")}\n\n_Draft._\n`,
        updated_by: getAuthor(),
      });
      navigate(`/specs/${spec.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Specifications</h1>
        <button className="primary" onClick={() => setCreating((v) => !v)}>
          {creating ? "Cancel" : "New spec"}
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      {creating && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="form-row">
            <select value={newTypeId} onChange={(e) => setNewTypeId(e.target.value)}>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.scope === "global" ? `${t.name} (global)` : t.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="FILENAME.md"
              value={newFilename}
              onChange={(e) => setNewFilename(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createSpec()}
            />
            <button className="primary" onClick={createSpec}>
              Create draft
            </button>
          </div>
          <span className="faint">New specs start as 0.1.0 drafts; publishing makes them 1.0.0.</span>
        </div>
      )}

      {grouped.map(([typeName, group]) => (
        <div className="section" key={typeName}>
          <h2>
            {typeName}
            {group[0].project_type_scope === "global" && (
              <>
                {" "}
                <span className="badge global">global</span>
              </>
            )}
          </h2>
          <table className="grid">
            <thead>
              <tr>
                <th>File</th>
                <th>Version</th>
                <th>Status</th>
                <th>Alerts</th>
                <th>Updated by</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {group.map((s) => (
                <tr key={s.id} className="click" onClick={() => navigate(`/specs/${s.id}`)}>
                  <td className="mono">{s.filename}</td>
                  <td className="mono">{s.current_version}</td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td>
                    {s.open_feedback_count > 0 ? (
                      <span className="badge open">{s.open_feedback_count} open</span>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  <td className="dim">{s.updated_by}</td>
                  <td className="faint">{timeAgo(s.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <div className="section" style={{ marginTop: 24 }}>
        <button
          style={{ fontSize: 13, opacity: 0.7 }}
          onClick={() => {
            const next = !showDeleted;
            setShowDeleted(next);
            if (next) loadDeleted();
          }}
        >
          {showDeleted ? "▾ Hide deleted specs" : "▸ Show deleted specs"}
        </button>
        {showDeleted && (
          <>
            {deletedSpecs.length === 0 ? (
              <p className="dim" style={{ marginTop: 8 }}>No deleted specs.</p>
            ) : (
              <table className="grid" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Project type</th>
                    <th>Version</th>
                    <th>Deleted</th>
                    <th>Purge in</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {deletedSpecs.map((ds) => {
                    const deletedDate = new Date(ds.deleted_at);
                    const purgeDate = new Date(deletedDate.getTime() + 14 * 24 * 60 * 60 * 1000);
                    const daysLeft = Math.max(0, Math.ceil((purgeDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
                    return (
                      <tr key={ds.id} style={{ opacity: 0.7 }}>
                        <td className="mono">{ds.filename}</td>
                        <td>{ds.project_type_name}</td>
                        <td className="mono">{ds.current_version}</td>
                        <td className="faint">{timeAgo(ds.deleted_at)}</td>
                        <td className="faint">{daysLeft}d</td>
                        <td>
                          <button
                            className="success"
                            style={{ fontSize: 12 }}
                            disabled={restoring === ds.id}
                            onClick={async () => {
                              setRestoring(ds.id);
                              try {
                                await api.restoreSpec(ds.id);
                                reload();
                                loadDeleted();
                              } catch (e) {
                                setError((e as Error).message);
                              } finally {
                                setRestoring(null);
                              }
                            }}
                          >
                            {restoring === ds.id ? "Restoring..." : "Restore"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </>
  );
}
