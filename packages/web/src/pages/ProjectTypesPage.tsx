import { useCallback, useEffect, useState } from "react";
import { api, type ProjectTypeWithCount } from "../api";
import { timeAgo } from "../components";

export default function ProjectTypesPage() {
  const [types, setTypes] = useState<ProjectTypeWithCount[]>([]);
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [description, setDescription] = useState("");

  const reload = useCallback(() => {
    api
      .projectTypes()
      .then(setTypes)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(reload, [reload]);

  async function create() {
    if (!name.trim()) return;
    try {
      await api.createProjectType({
        name: name.trim(),
        industry: industry.trim() || undefined,
        description: description.trim() || undefined,
      });
      setName("");
      setIndustry("");
      setDescription("");
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Project Types</h1>
        <span className="sub">The organization hierarchy — fully configurable, nothing hardcoded</span>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="form-row">
          <input type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            type="text"
            placeholder="Industry"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
          />
          <input
            type="text"
            placeholder="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ flex: 1, minWidth: 240 }}
          />
          <button className="primary" onClick={create}>
            Add project type
          </button>
        </div>
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Scope</th>
            <th>Industry</th>
            <th>Description</th>
            <th>Specs</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {types.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>{t.scope === "global" ? <span className="badge global">global</span> : "project type"}</td>
              <td className="dim">{t.industry ?? "—"}</td>
              <td className="dim">{t.description ?? "—"}</td>
              <td className="mono">{t.spec_count}</td>
              <td className="faint">{timeAgo(t.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
