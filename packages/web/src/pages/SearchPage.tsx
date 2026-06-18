import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ProjectTypeWithCount, type SearchHit } from "../api";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [typeName, setTypeName] = useState("");
  const [mode, setMode] = useState<"fts" | "semantic" | "hybrid">("fts");
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
      const res = await api.search(query, typeName || undefined, mode);
      setResults(res.results);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Search Specs</h1>
        <span className="sub">Section-level FTS, semantic, or hybrid search — the same index agents query via /api/v1/ai/search</span>
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
        <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="fts">FTS</option>
          <option value="semantic">Semantic</option>
          <option value="hybrid">Hybrid</option>
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
                <th>Score</th>
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
                  <td>
                    <Link to={`/specs/${hit.spec_id}#${hit.section_anchor}`} style={{ textDecoration: "underline" }}>
                      {hit.section}
                    </Link>
                    <div className="faint mono">{hit.permalink}</div>
                  </td>
                  <td className="mono">{hit.score === undefined ? "—" : hit.score.toFixed(3)}</td>
                  <td className="dim">
                    {hit.excerpt}
                    <div className="faint">{hit.match_type ?? "fts"} · {hit.explanation ?? "Matched indexed spec content."}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </>
  );
}
