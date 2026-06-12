import { useCallback, useEffect, useState } from "react";
import type { SpecTemplate } from "@specregistry/shared";
import { api } from "../api";

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<SpecTemplate[]>([]);
  const [error, setError] = useState<string>();
  const [filename, setFilename] = useState("");
  const [sections, setSections] = useState("");
  const [body, setBody] = useState("");

  const reload = useCallback(() => {
    api.templates().then(setTemplates).catch((e) => setError(e.message));
  }, []);

  useEffect(reload, [reload]);

  async function create() {
    if (!filename.trim()) return;
    try {
      await api.createTemplate({
        filename: filename.trim(),
        required_sections: sections.split(",").map((s) => s.trim()).filter(Boolean),
        content_template: body,
      });
      setFilename("");
      setSections("");
      setBody("");
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    await api.deleteTemplate(id);
    reload();
  }

  return (
    <>
      <div className="page-head">
        <h1>Spec Templates</h1>
        <span className="sub">Required sections are linted on every change request; the body seeds new drafts</span>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="form-row">
          <input type="text" placeholder="FILENAME.md" value={filename} onChange={(e) => setFilename(e.target.value)} />
          <input
            type="text"
            placeholder="Required sections (comma-separated)"
            value={sections}
            style={{ flex: 1, minWidth: 280 }}
            onChange={(e) => setSections(e.target.value)}
          />
          <button className="primary" onClick={create}>
            Add template
          </button>
        </div>
        <textarea
          className="editor"
          style={{ minHeight: 140 }}
          placeholder="Markdown skeleton used when creating a new spec with this filename…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          spellCheck={false}
        />
      </div>

      {templates.length === 0 ? (
        <div className="empty">No templates yet.</div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Filename</th>
              <th>Required sections</th>
              <th>Description</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.filename}</td>
                <td>
                  {(JSON.parse(t.required_sections) as string[]).map((s) => (
                    <span key={s} className="badge" style={{ marginRight: 6 }}>
                      {s}
                    </span>
                  ))}
                </td>
                <td className="dim">{t.description ?? "—"}</td>
                <td>
                  <button className="danger" onClick={() => remove(t.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
