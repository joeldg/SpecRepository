import { useCallback, useEffect, useState } from "react";
import type { Webhook } from "@specregistry/shared";
import {
  api,
  type AuditLogRow,
  type ApiKeyRow,
  type ApprovalPolicyRow,
  type LdapConfig,
  type LlmConfig,
  type McpGuide,
  type ProjectTypeWithCount,
  type SubscriptionRow,
  type SyncJobRow,
  type UserRow,
} from "../api";
import { StatusBadge, timeAgo } from "../components";

const WEBHOOK_EVENTS = ["spec.published", "review.submitted", "review.approved", "review.rejected", "feedback.created"];

export default function SettingsPage() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [subs, setSubs] = useState<SubscriptionRow[]>([]);
  const [jobs, setJobs] = useState<SyncJobRow[]>([]);
  const [types, setTypes] = useState<ProjectTypeWithCount[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [ldap, setLdap] = useState<LdapConfig>();
  const [llm, setLlm] = useState<LlmConfig>();
  const [mcpGuide, setMcpGuide] = useState<McpGuide>();
  const [policies, setPolicies] = useState<ApprovalPolicyRow[]>([]);
  const [auditRows, setAuditRows] = useState<AuditLogRow[]>([]);
  const [error, setError] = useState<string>();
  const [issuedToken, setIssuedToken] = useState<string>();
  const [ldapNotice, setLdapNotice] = useState<string>();
  const [llmNotice, setLlmNotice] = useState<string>();
  const [llmModels, setLlmModels] = useState<string[]>([]);

  const [hookUrl, setHookUrl] = useState("");
  const [hookFormat, setHookFormat] = useState("json");
  const [subTypeId, setSubTypeId] = useState("");
  const [subRepo, setSubRepo] = useState("");
  const [subBranch, setSubBranch] = useState("main");
  const [subPath, setSubPath] = useState("specs");
  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState("author");
  const [newPassword, setNewPassword] = useState("");
  const [keyUsername, setKeyUsername] = useState("");
  const [keyName, setKeyName] = useState("api key");
  const [ldapPassword, setLdapPassword] = useState("");
  const [ldapTestUsername, setLdapTestUsername] = useState("");
  const [ldapTestPassword, setLdapTestPassword] = useState("");
  const [ldapGroups, setLdapGroups] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmTestPrompt, setLlmTestPrompt] = useState("Reply with ok.");
  const [mcpTypeName, setMcpTypeName] = useState("");
  const [policyTypeId, setPolicyTypeId] = useState("");
  const [policyGlob, setPolicyGlob] = useState("*.md");
  const [policyApprovals, setPolicyApprovals] = useState(2);
  const [policyReviewers, setPolicyReviewers] = useState("");

  const reload = useCallback(() => {
    Promise.all([
      api.webhooks(),
      api.subscriptions(),
      api.syncJobs(),
      api.projectTypes(),
      api.users(),
      api.apiKeys(),
      api.ldapConfig(),
      api.llmConfig(),
      api.approvalPolicies(),
      api.auditLog(50),
    ])
      .then(([w, s, j, t, u, k, l, llmConfig, p, a]) => {
        setWebhooks(w);
        setSubs(s);
        setJobs(j);
        setTypes(t);
        setUsers(u);
        setKeys(k);
        setLdap(l);
        setLlm(llmConfig);
        setPolicies(p);
        setAuditRows(a);
        setSubTypeId((current) => current || t[0]?.id || "");
        setKeyUsername((current) => current || u[0]?.username || "");
        setMcpTypeName((current) => current || t.find((x) => x.scope !== "global")?.name || t[0]?.name || "");
        setPolicyTypeId((current) => current || t.find((x) => x.scope !== "global")?.id || "");
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(reload, [reload]);

  useEffect(() => {
    api.mcpGuide(mcpTypeName).then(setMcpGuide).catch((e) => setError(e.message));
  }, [mcpTypeName]);

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
        <h2>Users and API keys</h2>
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="form-row">
            <input type="text" placeholder="Username" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} />
            <input
              type="text"
              placeholder="Display name"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
            />
            <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
              <option value="admin">admin</option>
              <option value="reviewer">reviewer</option>
              <option value="author">author</option>
              <option value="agent">agent</option>
            </select>
            <input
              type="password"
              placeholder="Password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <button
              className="primary"
              onClick={() =>
                act(async () => {
                  await api.createUser({
                    username: newUsername.trim(),
                    display_name: newDisplayName.trim() || undefined,
                    role: newRole,
                    password: newPassword || undefined,
                  });
                  setNewUsername("");
                  setNewDisplayName("");
                  setNewPassword("");
                })
              }
            >
              Add user
            </button>
          </div>
        </div>
        {users.length > 0 && (
          <table className="grid" style={{ marginBottom: 12 }}>
            <thead>
              <tr>
                <th>Username</th>
                <th>Name</th>
                <th>Role</th>
                <th>Source</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="mono">{u.username}</td>
                  <td>{u.display_name ?? "—"}</td>
                  <td>
                    <StatusBadge status={u.role} />
                  </td>
                  <td>{u.source}</td>
                  <td className="faint">{timeAgo(u.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="form-row">
            <select value={keyUsername} onChange={(e) => setKeyUsername(e.target.value)}>
              {users.map((u) => (
                <option key={u.id} value={u.username}>
                  {u.username} ({u.role})
                </option>
              ))}
            </select>
            <input type="text" value={keyName} onChange={(e) => setKeyName(e.target.value)} />
            <button
              className="primary"
              onClick={() =>
                act(async () => {
                  const created = await api.createApiKey({ username: keyUsername, name: keyName.trim() || undefined });
                  setIssuedToken(created.token);
                })
              }
            >
              Issue API key
            </button>
          </div>
          {issuedToken && (
            <pre className="mono" style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
              {issuedToken}
            </pre>
          )}
        </div>
        {keys.length === 0 ? (
          <div className="empty">No API keys issued.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>User</th>
                <th>Name</th>
                <th>Created</th>
                <th>Last used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td className="mono">{k.username}</td>
                  <td>{k.name ?? "api key"}</td>
                  <td className="faint">{timeAgo(k.created_at)}</td>
                  <td className="faint">{k.last_used_at ? timeAgo(k.last_used_at) : "never"}</td>
                  <td>
                    <button className="danger" onClick={() => act(() => api.deleteApiKey(k.id))}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="section">
        <h2>LLM provider</h2>
        {llm && (
          <>
            {llmNotice && (
              <div className="card" style={{ marginBottom: 12 }}>
                {llmNotice}
              </div>
            )}
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="form-row">
                <select
                  value={llm.provider}
                  onChange={(e) => setLlm({ ...llm, provider: e.target.value as LlmConfig["provider"] })}
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Gemini</option>
                  <option value="openai_compatible">OpenAI-compatible / local</option>
                </select>
                <input
                  type="text"
                  placeholder={
                    llm.provider === "anthropic"
                      ? "claude-opus-4-8"
                      : llm.provider === "openai"
                        ? "gpt-4.1"
                        : llm.provider === "gemini"
                          ? "gemini-2.5-pro"
                          : "llama3.1"
                  }
                  value={llm.model}
                  list="llm-model-options"
                  style={{ minWidth: 220 }}
                  onChange={(e) => setLlm({ ...llm, model: e.target.value })}
                />
                <datalist id="llm-model-options">
                  {llmModels.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
                <input
                  type="number"
                  min={1}
                  value={llm.max_tokens}
                  style={{ width: 120 }}
                  onChange={(e) => setLlm({ ...llm, max_tokens: Number(e.target.value) })}
                />
                <button
                  onClick={() =>
                    act(async () => {
                      const result = await api.llmModels();
                      setLlmModels(result.models);
                      setLlmNotice(
                        result.models.length
                          ? `Loaded ${result.models.length} model(s) from ${result.provider}.`
                          : `No models returned by ${result.provider}.`
                      );
                    })
                  }
                >
                  Load models
                </button>
                <button
                  className="primary"
                  onClick={() =>
                    act(async () => {
                      const saved = await api.updateLlmConfig({
                        provider: llm.provider,
                        model: llm.model,
                        base_url: llm.base_url,
                        max_tokens: llm.max_tokens,
                        api_key: llmApiKey || undefined,
                      });
                      setLlm(saved);
                      setLlmApiKey("");
                      setLlmNotice("LLM settings saved.");
                    })
                  }
                >
                  Save LLM
                </button>
              </div>
              <div className="form-row">
                <input
                  type="text"
                  placeholder={
                    llm.provider === "anthropic"
                      ? "Optional proxy base URL"
                      : llm.provider === "openai"
                        ? "Optional OpenAI-compatible proxy URL"
                        : llm.provider === "gemini"
                          ? "Optional Gemini API base URL"
                      : "http://localhost:11434/v1 or http://llm-gateway.internal/v1"
                  }
                  value={llm.base_url}
                  style={{ flex: 1, minWidth: 360 }}
                  onChange={(e) => setLlm({ ...llm, base_url: e.target.value })}
                />
                <input
                  type="password"
                  placeholder={llm.has_api_key ? "Stored API key" : "API key, optional for local"}
                  value={llmApiKey}
                  onChange={(e) => setLlmApiKey(e.target.value)}
                />
                {llm.has_api_key && (
                  <button
                    className="danger"
                    onClick={() =>
                      act(async () => {
                        const saved = await api.updateLlmConfig({ clear_api_key: true });
                        setLlm(saved);
                        setLlmNotice("LLM API key cleared.");
                      })
                    }
                  >
                    Clear key
                  </button>
                )}
              </div>
            </div>
            <div className="card">
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Test prompt"
                  value={llmTestPrompt}
                  style={{ flex: 1, minWidth: 320 }}
                  onChange={(e) => setLlmTestPrompt(e.target.value)}
                />
                <button
                  onClick={() =>
                    act(async () => {
                      const result = await api.testLlm(llmTestPrompt);
                      setLlmNotice(`LLM test ok: ${result.provider}/${result.model} -> ${result.text.slice(0, 160)}`);
                    })
                  }
                >
                  Test LLM
                </button>
              </div>
              <div className="faint">
                Use OpenAI or Gemini for hosted providers. OpenAI-compatible mode supports local/network services such as Ollama, LM Studio, vLLM, LocalAI, or an internal LLM gateway.
              </div>
            </div>
          </>
        )}
      </div>

      <div className="section">
        <h2>LDAP</h2>
        {ldap && (
          <>
            {ldapNotice && (
              <div className="card" style={{ marginBottom: 12 }}>
                {ldapNotice}
              </div>
            )}
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="ldap://directory.example.com"
                  value={ldap.url}
                  style={{ flex: 1, minWidth: 280 }}
                  onChange={(e) => setLdap({ ...ldap, url: e.target.value })}
                />
                <select value={ldap.default_role} onChange={(e) => setLdap({ ...ldap, default_role: e.target.value as LdapConfig["default_role"] })}>
                  <option value="author">default author</option>
                  <option value="agent">default agent</option>
                  <option value="reviewer">default reviewer</option>
                  <option value="admin">default admin</option>
                </select>
                <button
                  className="primary"
                  onClick={() =>
                    act(async () => {
                      const saved = await api.updateLdapConfig({
                        url: ldap.url,
                        bind_dn_template: ldap.bind_dn_template,
                        bind_user: ldap.bind_user,
                        bind_password: ldapPassword || undefined,
                        search_base: ldap.search_base,
                        search_filter: ldap.search_filter,
                        admin_group: ldap.admin_group,
                        reviewer_group: ldap.reviewer_group,
                        default_role: ldap.default_role,
                      });
                      setLdap(saved);
                      setLdapPassword("");
                      setLdapNotice("LDAP settings saved.");
                    })
                  }
                >
                  Save LDAP
                </button>
              </div>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Direct bind DN template: uid={username},ou=people,dc=example,dc=com"
                  value={ldap.bind_dn_template}
                  style={{ flex: 1, minWidth: 360 }}
                  onChange={(e) => setLdap({ ...ldap, bind_dn_template: e.target.value })}
                />
              </div>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Service bind user"
                  value={ldap.bind_user}
                  onChange={(e) => setLdap({ ...ldap, bind_user: e.target.value })}
                />
                <input
                  type="password"
                  placeholder={ldap.has_bind_password ? "Stored bind password" : "Bind password"}
                  value={ldapPassword}
                  onChange={(e) => setLdapPassword(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Search base"
                  value={ldap.search_base}
                  style={{ flex: 1, minWidth: 260 }}
                  onChange={(e) => setLdap({ ...ldap, search_base: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="(uid={username})"
                  value={ldap.search_filter}
                  onChange={(e) => setLdap({ ...ldap, search_filter: e.target.value })}
                />
              </div>
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Admin group DN"
                  value={ldap.admin_group}
                  style={{ flex: 1, minWidth: 260 }}
                  onChange={(e) => setLdap({ ...ldap, admin_group: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="Reviewer group DN"
                  value={ldap.reviewer_group}
                  style={{ flex: 1, minWidth: 260 }}
                  onChange={(e) => setLdap({ ...ldap, reviewer_group: e.target.value })}
                />
              </div>
            </div>
            <div className="card">
              <div className="form-row">
                <input
                  type="text"
                  placeholder="Test username"
                  value={ldapTestUsername}
                  onChange={(e) => setLdapTestUsername(e.target.value)}
                />
                <input
                  type="password"
                  placeholder="Test password"
                  value={ldapTestPassword}
                  onChange={(e) => setLdapTestPassword(e.target.value)}
                />
                <button
                  onClick={() =>
                    act(async () => {
                      const result = await api.testLdap(ldapTestUsername, ldapTestPassword);
                      setLdapNotice(`LDAP test ok: ${result.display_name ?? result.username} maps to ${result.role}.`);
                      setLdapTestPassword("");
                    })
                  }
                >
                  Test login
                </button>
                <input
                  type="text"
                  placeholder="Group DNs to preview role"
                  value={ldapGroups}
                  style={{ flex: 1, minWidth: 260 }}
                  onChange={(e) => setLdapGroups(e.target.value)}
                />
                <button
                  onClick={() =>
                    act(async () => {
                      const result = await api.previewLdapRole(ldapGroups.split(",").map((g) => g.trim()).filter(Boolean));
                      setLdapNotice(`Preview role: ${result.role}`);
                    })
                  }
                >
                  Preview role
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="section">
        <h2>Agent MCP guide</h2>
        <div className="card">
          <div className="form-row">
            <select value={mcpTypeName} onChange={(e) => setMcpTypeName(e.target.value)}>
              {types
                .filter((t) => t.scope !== "global")
                .map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name}
                  </option>
                ))}
            </select>
            <input
              className="mono"
              type="text"
              readOnly
              value={`/api/v1/ai/mcp-guide/${encodeURIComponent(mcpTypeName)}`}
              style={{ flex: 1, minWidth: 320 }}
            />
            <a className="btn" href={`/api/v1/specs/${encodeURIComponent(mcpTypeName)}/agent-pack`}>
              Download agent pack
            </a>
          </div>
          {mcpGuide && (
            <pre className="mono" style={{ whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto", marginBottom: 0 }}>
              {mcpGuide.content}
            </pre>
          )}
        </div>
      </div>

      <div className="section">
        <h2>Approval policies</h2>
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="form-row">
            <select value={policyTypeId} onChange={(e) => setPolicyTypeId(e.target.value)}>
              <option value="">All project types</option>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.scope === "global" ? `${t.name} (global)` : t.name}
                </option>
              ))}
            </select>
            <input type="text" value={policyGlob} onChange={(e) => setPolicyGlob(e.target.value)} />
            <input
              type="number"
              min={1}
              value={policyApprovals}
              style={{ width: 80 }}
              onChange={(e) => setPolicyApprovals(Number(e.target.value))}
            />
            <input
              type="text"
              placeholder="Required reviewers (comma-separated)"
              value={policyReviewers}
              style={{ flex: 1, minWidth: 260 }}
              onChange={(e) => setPolicyReviewers(e.target.value)}
            />
            <button
              className="primary"
              onClick={() =>
                act(async () => {
                  await api.createApprovalPolicy({
                    project_type_id: policyTypeId || null,
                    filename_glob: policyGlob || "*",
                    min_approvals: policyApprovals,
                    required_reviewers: policyReviewers.split(",").map((r) => r.trim()).filter(Boolean),
                  });
                  setPolicyReviewers("");
                })
              }
            >
              Add policy
            </button>
          </div>
        </div>
        {policies.length === 0 ? (
          <div className="empty">No approval policies configured.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Project type</th>
                <th>Filename</th>
                <th>Approvals</th>
                <th>Required reviewers</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td>{p.project_type_name ?? "All"}</td>
                  <td className="mono">{p.filename_glob}</td>
                  <td className="mono">{p.min_approvals}</td>
                  <td className="dim">{(JSON.parse(p.required_reviewers) as string[]).join(", ") || "any reviewer"}</td>
                  <td>
                    <button className="danger" onClick={() => act(() => api.deleteApprovalPolicy(p.id))}>
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
        <h2>Audit log</h2>
        {auditRows.length === 0 ? (
          <div className="empty">No audit events yet.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {auditRows.map((row) => (
                <tr key={row.id}>
                  <td className="faint">{timeAgo(row.created_at)}</td>
                  <td className="mono">{row.actor}</td>
                  <td className="mono">{row.action}</td>
                  <td className="dim">{row.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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
              <option value="slack">Slack message (interactive)</option>
              <option value="gchat">Google Chat message</option>
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
