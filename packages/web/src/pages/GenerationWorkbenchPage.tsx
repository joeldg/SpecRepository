import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  getAuthor,
  type AutomationFlags,
  type GenerationPreview,
  type ProjectTypeWithCount,
  type SpecGap,
  type SpecPurposeTemplate,
  type TaskPlan,
} from "../api";

const SAMPLE_TREE = `src/
src/routes/
src/routes/api.ts
src/db/schema.sql
src/auth/session.ts
tests/api.test.ts
docker-compose.yml`;

function detectedLanguages(tree: string): string[] {
  const languages = new Set<string>();
  if (/\.(ts|tsx)\b/.test(tree)) languages.add("TypeScript");
  if (/\.py\b/.test(tree)) languages.add("Python");
  if (/\.go\b/.test(tree)) languages.add("Go");
  if (/\.rs\b/.test(tree)) languages.add("Rust");
  if (/\.sql\b/.test(tree)) languages.add("SQL");
  if (/docker|compose|kubernetes|helm/i.test(tree)) languages.add("Deployment");
  return [...languages];
}

export default function GenerationWorkbenchPage() {
  const [projectTypes, setProjectTypes] = useState<ProjectTypeWithCount[]>([]);
  const [purposes, setPurposes] = useState<SpecPurposeTemplate[]>([]);
  const [features, setFeatures] = useState<AutomationFlags>();
  const [projectType, setProjectType] = useState("");
  const [purposeId, setPurposeId] = useState("");
  const [tree, setTree] = useState(SAMPLE_TREE);
  const [extraContext, setExtraContext] = useState("");
  const [task, setTask] = useState("Implement secure API session handling with observable failures.");
  const [tokenBudget, setTokenBudget] = useState(1200);
  const [useLlm, setUseLlm] = useState(false);
  const [gaps, setGaps] = useState<SpecGap[]>([]);
  const [preview, setPreview] = useState<GenerationPreview>();
  const [plan, setPlan] = useState<TaskPlan>();
  const [ticket, setTicket] = useState("");
  const [suggestions, setSuggestions] = useState<Array<{ filename: string; suggestion: string; reason: string }>>([]);
  const [pack, setPack] = useState<Array<{ filename: string; purpose_id: string }>>([]);
  const [auditPrompt, setAuditPrompt] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([api.projectTypes(), api.specPurposes(), api.automationFeatures()])
      .then(([types, nextPurposes, nextFeatures]) => {
        const selectable = types.filter((type) => type.scope === "project_type");
        setProjectTypes(selectable);
        setPurposes(nextPurposes);
        setFeatures(nextFeatures);
        setProjectType(selectable[0]?.name ?? "");
        setPurposeId(nextPurposes[0]?.id ?? "");
      })
      .catch((e) => setError(e.message));
  }, []);

  const languages = useMemo(() => detectedLanguages(tree), [tree]);
  const selectedPurpose = purposes.find((purpose) => purpose.id === purposeId);

  async function detectGaps() {
    if (!projectType) return;
    setBusy("gaps");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await api.specGaps({ project_type: projectType, tree, detected_languages: languages });
      setGaps(result.gaps);
      if (result.gaps[0]) setPurposeId(result.gaps[0].purpose_id);
      setNotice(`Detected ${result.gaps.length} candidate spec gap(s).`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  useEffect(() => {
    if (projectType) {
      detectGaps();
    }
  }, [projectType]);


  async function generate() {
    if (!projectType || !purposeId) return;
    setBusy("generate");
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await api.generationPreview({
        project_type: projectType,
        purpose: purposeId,
        tree,
        detected_languages: languages,
        extra_context: extraContext,
        use_llm: useLlm,
      });
      setPreview(result);
      setContent(result.content);
      setNotice(useLlm ? `Generated with ${result.provider}/${result.model}.` : "Generated deterministic draft from the purpose template.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function createDraft() {
    if (!preview || !content.trim()) return;
    setBusy("draft");
    setError(undefined);
    try {
      const draft = await api.createGeneratedDraft({
        project_type: projectType,
        purpose: preview.purpose.id,
        filename: preview.filename,
        content,
        updated_by: getAuthor(),
      });
      navigate(`/specs/${draft.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function runPlanner() {
    if (!projectType) return;
    setBusy("planner");
    setError(undefined);
    try {
      const [nextPlan, nextTicket] = await Promise.all([
        api.taskPlan({ project_type: projectType, task, tree, token_budget: tokenBudget, use_llm: useLlm }),
        api.ticketChecklist({ project_type: projectType, task, tree, use_llm: useLlm }),
      ]);
      setPlan(nextPlan);
      setTicket(nextTicket.markdown);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function runMaintenance() {
    if (!projectType) return;
    setBusy("maintenance");
    setError(undefined);
    try {
      const [nextSuggestions, nextPack] = await Promise.all([
        api.improvementSuggestions({ project_type: projectType, use_llm: useLlm }),
        api.specPack({ name: `${projectType} Starter Pack`, purposes: purposes.map((purpose) => purpose.id), use_llm: useLlm }),
      ]);
      setSuggestions(nextSuggestions.suggestions.slice(0, 8));
      setPack(nextPack.specs);
      const specId = plan?.applicable_specs[0]?.spec_id;
      if (specId) {
        const prompt = await api.auditPrompt(specId, useLlm);
        setAuditPrompt(prompt.prompt);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Generate Specs</h1>
          <span className="sub">Detect missing spec coverage and generate reviewed drafts from purpose templates</span>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}
      {features && !features.enabled && <div className="error-banner">Automation features are disabled for this deployment.</div>}
      {features && (
        <details className="card" style={{ marginBottom: 20 }}>
          <summary style={{ cursor: "pointer", fontWeight: 600, display: "flex", alignItems: "center", gap: "6px", userSelect: "none" }}>
            <span>💡 Automation Feature Guide & Status Flags</span>
            <span style={{ fontSize: "11px", fontWeight: "normal", color: "var(--text-faint)" }}>(Click to expand)</span>
          </summary>
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px", fontSize: "12px", lineHeight: "1.4" }}>
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
              <span className={`badge ${features.enabled ? "approved" : "rejected"}`} style={{ minWidth: "110px", textAlign: "center" }}>enabled</span>
              <span style={{ color: "var(--text-dim)" }}>Global activation switch for the SpecRegistry Automation and LLM orchestration engine.</span>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
              <span className={`badge ${features.gap_detection ? "approved" : "rejected"}`} style={{ minWidth: "110px", textAlign: "center" }}>gap_detection</span>
              <span style={{ color: "var(--text-dim)" }}>Scans repository files and directory paths against spec templates to identify missing specs.</span>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
              <span className={`badge ${features.generation ? "approved" : "rejected"}`} style={{ minWidth: "110px", textAlign: "center" }}>generation</span>
              <span style={{ color: "var(--text-dim)" }}>Drafts new specification documents using rule-based templates or LLM prompts.</span>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
              <span className={`badge ${features.llm_generation ? "approved" : "rejected"}`} style={{ minWidth: "110px", textAlign: "center" }}>llm_generation</span>
              <span style={{ color: "var(--text-dim)" }}>Uses active LLM providers (Gemini/Anthropic/OpenAI) to generate intelligent documents.</span>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
              <span className={`badge ${features.task_planner ? "approved" : "rejected"}`} style={{ minWidth: "110px", textAlign: "center" }}>task_planner</span>
              <span style={{ color: "var(--text-dim)" }}>Analyzes user tasks and optimizes context by selecting relevant spec sections.</span>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
              <span className={`badge ${features.ticket_generator ? "approved" : "rejected"}`} style={{ minWidth: "110px", textAlign: "center" }}>ticket_generator</span>
              <span style={{ color: "var(--text-dim)" }}>Generates spec-conformance checklists for task tickets and PR descriptions.</span>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
              <span className={`badge ${features.maintenance ? "approved" : "rejected"}`} style={{ minWidth: "110px", textAlign: "center" }}>maintenance</span>
              <span style={{ color: "var(--text-dim)" }}>Evaluates specification quality, generates audit prompts, and suggests upgrades.</span>
            </div>
          </div>
        </details>
      )}


      <div className="split">
        <div className="section">
          <h2>Repo Evidence</h2>
          <div className="card">
            <div className="form-row">
              <select value={projectType} onChange={(e) => setProjectType(e.target.value)}>
                {projectTypes.map((type) => (
                  <option key={type.id} value={type.name}>{type.name}</option>
                ))}
              </select>
              <button onClick={detectGaps} disabled={!features?.gap_detection || !projectType || busy === "gaps"}>
                {busy === "gaps" ? "Detecting..." : "Detect gaps"}
              </button>
            </div>
            <textarea className="editor" style={{ minHeight: 260 }} value={tree} onChange={(e) => setTree(e.target.value)} />
            <div className="faint">Detected: {languages.join(", ") || "unknown"}</div>
          </div>

          <div className="section" style={{ marginTop: 18 }}>
            <h2>Detected Gaps</h2>
            {gaps.length === 0 ? (
              <div className="empty">Run gap detection to find missing spec purposes.</div>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>Spec</th>
                    <th>Confidence</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {gaps.map((gap) => (
                    <tr key={gap.purpose_id} className="click" onClick={() => setPurposeId(gap.purpose_id)}>
                      <td>
                        <div className="mono">{gap.filename}</div>
                        <div className="dim">{gap.reason}</div>
                      </td>
                      <td className="mono">{Math.round(gap.confidence * 100)}%</td>
                      <td className="dim">{gap.evidence.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="section">
          <h2>Generation</h2>
          <div className="card">
            <div className="form-row">
              <select value={purposeId} onChange={(e) => setPurposeId(e.target.value)}>
                {purposes.map((purpose) => (
                  <option key={purpose.id} value={purpose.id}>{purpose.title} · {purpose.filename}</option>
                ))}
              </select>
              <label className="faint">
                <input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} /> Use server LLM
              </label>
              <button className="primary" onClick={generate} disabled={!features?.generation || !purposeId || busy === "generate" || (useLlm && !features?.llm_generation)}>
                {busy === "generate" ? "Generating..." : "Generate"}
              </button>
            </div>
            {selectedPurpose && (
              <div className="dim" style={{ marginBottom: 10 }}>
                {selectedPurpose.description} Required sections: {selectedPurpose.required_sections.join(", ")}.
              </div>
            )}
            <textarea
              rows={4}
              value={extraContext}
              onChange={(e) => setExtraContext(e.target.value)}
              placeholder="Additional intent, constraints, or source evidence..."
            />
          </div>

          {preview && (
            <div className="section" style={{ marginTop: 18 }}>
              <h2>Draft Preview</h2>
              <div className="toolbar">
                <span className="mono">{preview.filename}</span>
                <button className="success" onClick={createDraft} disabled={busy === "draft"}>
                  {busy === "draft" ? "Creating..." : "Create registry draft"}
                </button>
              </div>
              <textarea className="editor" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
              <details>
                <summary className="faint">Generation prompt</summary>
                <pre className="diff" style={{ padding: 12 }}>{preview.prompt}</pre>
              </details>
            </div>
          )}
        </div>
      </div>

      <div className="section">
        <h2>Task Automation</h2>
        <div className="card">
          <div className="form-row">
            <label style={{ flex: "1 1 320px", minWidth: 280 }}>
              <span className="label">Task or maintenance goal</span>
              <input type="text" value={task} onChange={(e) => setTask(e.target.value)} style={{ width: "100%" }} />
            </label>
            <label style={{ width: 180 }}>
              <span className="label">Context token budget</span>
              <input
                type="number"
                value={tokenBudget}
                min={100}
                step={100}
                aria-describedby="task-token-budget-help"
                onChange={(e) => setTokenBudget(Math.max(100, Number(e.target.value) || 1200))}
                style={{ width: "100%" }}
              />
            </label>
            <button onClick={runPlanner} disabled={!features?.task_planner || !projectType || busy === "planner" || (useLlm && !features?.llm_generation)}>
              {busy === "planner" ? "Planning..." : "Plan task"}
            </button>
            <button onClick={runMaintenance} disabled={!features?.maintenance || !projectType || busy === "maintenance" || (useLlm && !features?.llm_generation)}>
              {busy === "maintenance" ? "Loading..." : "Maintenance"}
            </button>
          </div>
          <div id="task-token-budget-help" className="faint" style={{ margin: "-4px 0 12px" }}>
            Token budget limits how much spec context the planner and maintenance suggestions can select.
          </div>
          {plan && (
            <div className="report-grid">
              <div>
                <div className="label">Applicable specs</div>
                {plan.applicable_specs.length === 0 ? (
                  <div className="dim">No direct matches.</div>
                ) : (
                  plan.applicable_specs.map((spec) => (
                    <div key={spec.spec_id} className="dim"><span className="mono">{spec.filename}</span> · priority {spec.priority}</div>
                  ))
                )}
                <div className="label" style={{ marginTop: 12 }}>Context budget</div>
                <div className="mono">{plan.context_selection.estimated_tokens}/{plan.context_selection.token_budget} tokens</div>
                {plan.context_selection.selected_sections.slice(0, 6).map((section) => (
                  <div key={`${section.filename}-${section.section}`} className="dim">
                    {section.filename} · {section.section} · {section.classification}
                  </div>
                ))}
                {plan.llm_notes && <pre className="diff" style={{ padding: 12, marginTop: 10 }}>{plan.llm_notes}</pre>}
              </div>
              <div>
                <div className="label">PR/ticket checklist</div>
                <pre className="diff" style={{ padding: 12, maxHeight: 260 }}>{ticket}</pre>
              </div>
            </div>
          )}
        </div>
      </div>

      {(suggestions.length > 0 || pack.length > 0 || auditPrompt) && (
        <div className="section">
          <h2>Automation Maintenance</h2>
          <div className="report-grid">
            <div className="card">
              <div className="label">Spec improvement suggestions</div>
              {suggestions.map((item, index) => (
                <div key={`${item.filename}-${index}`} className="dim">
                  <span className="mono">{item.filename}</span>: {item.suggestion} {item.reason}
                </div>
              ))}
            </div>
            <div className="card">
              <div className="label">Spec pack composer</div>
              {pack.slice(0, 10).map((item) => (
                <div key={item.purpose_id} className="dim"><span className="mono">{item.filename}</span> · {item.purpose_id}</div>
              ))}
            </div>
          </div>
          {auditPrompt && (
            <details style={{ marginTop: 12 }}>
              <summary className="faint">Generated audit prompt</summary>
              <pre className="diff" style={{ padding: 12 }}>{auditPrompt}</pre>
            </details>
          )}
        </div>
      )}
    </>
  );
}
