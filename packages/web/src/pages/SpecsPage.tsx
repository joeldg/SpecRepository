import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SpecSummary } from "@specregistry/shared";
import { api, getAuthor, type ProjectTypeWithCount } from "../api";
import { StatusBadge, timeAgo } from "../components";

export default function SpecsPage() {
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [types, setTypes] = useState<ProjectTypeWithCount[]>([]);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [newTypeId, setNewTypeId] = useState("");
  const [newFilename, setNewFilename] = useState("");
  const navigate = useNavigate();

  function reload() {
    Promise.all([api.specs(), api.projectTypes()])
      .then(([s, t]) => {
        setSpecs(s);
        setTypes(t);
        if (!newTypeId && t.length) setNewTypeId(t[0].id);
      })
      .catch((e) => setError(e.message));
  }

  useEffect(reload, []);

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
    try {
      const spec = await api.createSpec({
        project_type_id: newTypeId,
        filename: newFilename.trim(),
        content: `# ${newFilename.trim().replace(/\.md$/i, "")}\n\n_Draft._\n`,
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
    </>
  );
}
