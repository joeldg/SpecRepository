import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ProjectTypeWithCount, type SearchHit } from "../api";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [typeName, setTypeName] = useState("");
  const [types, setTypes] = useState<ProjectTypeWithCount[]>([]);
  const [results, setResults] = useState<SearchHit[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.projectTypes().then(setTypes).catch((e) => setError(e.message));
  }, []);

  async function run() {
    if (!query.trim()) return;
    setError(undefined);
    try {
      const res = await api.search(query, typeName || undefined);
      setResults(res.results);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Search Specs</h1>
        <span className="sub">Section-level full-text search — the same index agents query via /api/v1/ai/search</span>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="toolbar">
        <input
          type="text"
          placeholder="e.g. TLS firewall rules"
          value={query}
          style={{ width: 320 }}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
        />
        <select value={typeName} onChange={(e) => setTypeName(e.target.value)}>
          <option value="">All project types</option>
          {types
            .filter((t) => t.scope === "project_type")
            .map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
        </select>
        <button className="primary" onClick={run}>
          Search
        </button>
      </div>

      {results &&
        (results.length === 0 ? (
          <div className="empty">No matching sections.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Spec</th>
                <th>Project type</th>
                <th>Section</th>
                <th>Match</th>
              </tr>
            </thead>
            <tbody>
              {results.map((hit, i) => (
                <tr key={i}>
                  <td className="mono">
                    <Link to={`/specs/${hit.spec_id}`} style={{ textDecoration: "underline" }}>
                      {hit.filename}
                    </Link>{" "}
                    <span className="faint">v{hit.current_version}</span>
                  </td>
                  <td>{hit.project_type_name}</td>
                  <td>{hit.section}</td>
                  <td className="dim">{hit.excerpt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </>
  );
}
