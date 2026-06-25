import { useCallback, useEffect, useState } from "react";
import type { Webhook } from "@specregistry/shared";
import {
  api,
  type AgentSkillRow,
  type AppKeyConfig,
  type AuditLogRow,
  type ApiKeyRow,
  type ApprovalPolicyRow,
  type EmbeddingConfig,
  type EmbeddingStatus,
  type LdapConfig,
  type LlmConfig,
  type LlmTaskRoute,
  type LlmTier,
  type LlmTieringConfig,
  type McpGuide,
  type ProjectTypeWithCount,
  type RepoConsumerRow,
  type SubscriptionRow,
  type SyncJobRow,
  type UserRow,
} from "../api";
import { StatusBadge, timeAgo } from "../components";

const WEBHOOK_EVENTS = ["spec.published", "review.submitted", "review.approved", "review.rejected", "feedback.created"];
const LLM_TIERS: LlmTier[] = ["cheap", "standard", "frontier"];
type SettingsTab = "ai" | "access" | "governance" | "integrations";
const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; description: string }> = [
  { id: "ai", label: "AI & Search", description: "Choose models, route AI work, and manage agent context and semantic indexing." },
  { id: "access", label: "Access", description: "Manage people, machine credentials, and directory-based authentication." },
  { id: "governance", label: "Governance", description: "Control approvals and inspect the projects and events governed by this registry." },
  { id: "integrations", label: "Integrations", description: "Connect external services and distribute approved specs to subscribed repositories." },
];
const LLM_ROUTES: Array<{ route: LlmTaskRoute; label: string; defaultTier: LlmTier }> = [
  { route: "classification", label: "Classification", defaultTier: "cheap" },
  { route: "summarization", label: "Summarization", defaultTier: "cheap" },
  { route: "task_planning", label: "Task planning", defaultTier: "cheap" },
  { route: "ticket_generation", label: "Ticket generation", defaultTier: "standard" },
  { route: "maintenance", label: "Maintenance suggestions", defaultTier: "standard" },
  { route: "spec_generation", label: "Spec generation", defaultTier: "frontier" },
  { route: "audit", label: "Audits and audit prompts", defaultTier: "frontier" },
  { route: "draft_fix", label: "AI draft fixes", defaultTier: "frontier" },
  { route: "efficacy", label: "AI efficacy reports", defaultTier: "frontier" },
  { route: "test", label: "Connectivity test", defaultTier: "standard" },
];

function modelPlaceholder(provider: LlmConfig["provider"]): string {
  if (provider === "anthropic") return "claude-sonnet-4-5";
  if (provider === "openai") return "gpt-4.1";
  if (provider === "gemini") return "gemini-3.5-flash";
  return "google/gemma-4-12b-qat";
}

function baseUrlPlaceholder(provider: LlmConfig["provider"]): string {
  if (provider === "anthropic") return "Optional proxy base URL";
  if (provider === "openai") return "Optional OpenAI-compatible proxy URL";
  if (provider === "gemini") return "Optional Gemini API base URL";
  return "LM Studio: http://10.0.0.142:1234 · Ollama: http://localhost:11434/v1";
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("ai");
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [subs, setSubs] = useState<SubscriptionRow[]>([]);
  const [consumers, setConsumers] = useState<RepoConsumerRow[]>([]);
  const [jobs, setJobs] = useState<SyncJobRow[]>([]);
  const [types, setTypes] = useState<ProjectTypeWithCount[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [ldap, setLdap] = useState<LdapConfig>();
  const [llmTiering, setLlmTiering] = useState<LlmTieringConfig>();
  const [embedding, setEmbedding] = useState<EmbeddingConfig>();
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus>();
  const [appKeys, setAppKeys] = useState<AppKeyConfig>();
  const [mcpGuide, setMcpGuide] = useState<McpGuide>();
  const [policies, setPolicies] = useState<ApprovalPolicyRow[]>([]);
  const [auditRows, setAuditRows] = useState<AuditLogRow[]>([]);
  const [agentSkills, setAgentSkills] = useState<AgentSkillRow[]>([]);
  const [error, setError] = useState<string>();
  const [issuedToken, setIssuedToken] = useState<string>();
  const [ldapNotice, setLdapNotice] = useState<string>();
  const [llmNotice, setLlmNotice] = useState<string>();
  const [embeddingNotice, setEmbeddingNotice] = useState<string>();
  const [appKeyNotice, setAppKeyNotice] = useState<string>();
  const [tierModels, setTierModels] = useState<Record<LlmTier, string[]>>({ cheap: [], standard: [], frontier: [] });
  const [llmTestStatus, setLlmTestStatus] = useState<"idle" | "running" | "ok" | "error">("idle");
  const [llmTestResult, setLlmTestResult] = useState<string>();

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
  const [pwResetUserId, setPwResetUserId] = useState<string | null>(null);
  const [pwResetValue, setPwResetValue] = useState("");
  const [pwResetConfirm, setPwResetConfirm] = useState("");
  const [pwResetSaving, setPwResetSaving] = useState(false);
  const [keyName, setKeyName] = useState("api key");
  const [ldapPassword, setLdapPassword] = useState("");
  const [ldapTestUsername, setLdapTestUsername] = useState("");
  const [ldapTestPassword, setLdapTestPassword] = useState("");
  const [ldapGroups, setLdapGroups] = useState("");
  const [tierApiKeys, setTierApiKeys] = useState<Record<LlmTier, string>>({ cheap: "", standard: "", frontier: "" });
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [llmTestPrompt, setLlmTestPrompt] = useState("Reply with ok.");
  const [llmTestTier, setLlmTestTier] = useState<LlmTier>("standard");
  const [llmTestRoute, setLlmTestRoute] = useState<LlmTaskRoute>("test");
  const [githubToken, setGithubToken] = useState("");
  const [githubWebhookSecret, setGithubWebhookSecret] = useState("");
  const [slackSigningSecret, setSlackSigningSecret] = useState("");
  const [mcpTypeName, setMcpTypeName] = useState("");
  const [policyTypeId, setPolicyTypeId] = useState("");
  const [policyGlob, setPolicyGlob] = useState("*.md");
  const [policyApprovals, setPolicyApprovals] = useState(2);
  const [policyReviewers, setPolicyReviewers] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillSlug, setSkillSlug] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillInstructions, setSkillInstructions] = useState("");
  const [skillRisk, setSkillRisk] = useState<AgentSkillRow["risk_level"]>("safe");

  const reload = useCallback(() => {
    Promise.all([
      api.webhooks(),
      api.subscriptions(),
      api.repoConsumers(),
      api.syncJobs(),
      api.projectTypes(),
      api.users(),
      api.apiKeys(),
      api.ldapConfig(),
      api.llmTiering(),
      api.embeddingConfig(),
      api.embeddingStatus(),
      api.appKeys(),
      api.approvalPolicies(),
      api.auditLog(50),
      api.agentSkills(true),
    ])
      .then(([w, s, c, j, t, u, k, l, tieringConfig, embeddingConfig, nextEmbeddingStatus, appKeyConfig, p, a, nextSkills]) => {
        setWebhooks(w);
        setSubs(s);
        setConsumers(c);
        setJobs(j);
        setTypes(t);
        setUsers(u);
        setKeys(k);
        setLdap(l);
        setLlmTiering(tieringConfig);
        setEmbedding(embeddingConfig);
        setEmbeddingStatus(nextEmbeddingStatus);
        setAppKeys(appKeyConfig);
        setPolicies(p);
        setAuditRows(a);
        setAgentSkills(nextSkills);
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

  async function act(fn: () => Promise<unknown>, reloadAfter = true) {
    setError(undefined);
    try {
      await fn();
      if (reloadAfter) reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveCurrentTier(tier: LlmTier): Promise<LlmTieringConfig> {
    if (!llmTiering) throw new Error("LLM tiering config is not loaded");
    const config = llmTiering.tiers[tier];
    const saved = await api.updateLlmTier(tier, {
      provider: config.provider,
      model: config.model,
      base_url: config.base_url,
      max_tokens: config.max_tokens,
      api_key: tierApiKeys[tier] || undefined,
    });
    const next = {
      ...llmTiering,
      tiers: { ...llmTiering.tiers, [tier]: saved },
    };
    setLlmTiering(next);
    setTierApiKeys((keys) => ({ ...keys, [tier]: "" }));
    return next;
  }

  async function saveCurrentEmbedding(config: EmbeddingConfig): Promise<EmbeddingConfig> {
    const saved = await api.updateEmbeddingConfig({
      provider: config.provider,
      model: config.model,
      base_url: config.base_url,
      dimensions: config.dimensions,
      api_key: embeddingApiKey || undefined,
    });
    setEmbedding(saved);
    setEmbeddingApiKey("");
    return saved;
  }

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <span className="sub">Configure the registry and its connected services</span>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls="settings-panel"
            className={activeTab === tab.id ? "active" : ""}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="settings-tab-intro" id="settings-panel" role="tabpanel">
        {SETTINGS_TABS.find((tab) => tab.id === activeTab)?.description}
      </div>

      <div className={`section${activeTab === "access" ? "" : " settings-hidden"}`}>
        <h2>Users and API keys</h2>
        <p className="settings-help">Create human identities and issue revocable bearer tokens for CLI, MCP, and API clients.</p>
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
                <th style={{ width: 200 }}>Password</th>
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
                  <td>
                    {pwResetUserId === u.id ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <input
                          type="password"
                          placeholder="New password"
                          value={pwResetValue}
                          onChange={(e) => setPwResetValue(e.target.value)}
                          style={{ width: "100%" }}
                        />
                        <input
                          type="password"
                          placeholder="Confirm password"
                          value={pwResetConfirm}
                          onChange={(e) => setPwResetConfirm(e.target.value)}
                          style={{ width: "100%" }}
                        />
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            className="primary"
                            disabled={pwResetSaving || !pwResetValue || pwResetValue !== pwResetConfirm}
                            onClick={async () => {
                              setPwResetSaving(true);
                              try {
                                await api.changePassword(u.id, { new_password: pwResetValue });
                                setPwResetUserId(null);
                                setPwResetValue("");
                                setPwResetConfirm("");
                                setError(undefined);
                              } catch (e) {
                                setError((e as Error).message);
                              } finally {
                                setPwResetSaving(false);
                              }
                            }}
                          >
                            {pwResetSaving ? "Saving..." : "Save"}
                          </button>
                          <button
                            onClick={() => {
                              setPwResetUserId(null);
                              setPwResetValue("");
                              setPwResetConfirm("");
                            }}
                            disabled={pwResetSaving}
                          >
                            Cancel
                          </button>
                        </div>
                        {pwResetValue && pwResetConfirm && pwResetValue !== pwResetConfirm && (
                          <span style={{ color: "var(--danger)", fontSize: 11 }}>Passwords don't match</span>
                        )}
                      </div>
                    ) : (
                      <button
                        style={{ fontSize: 12 }}
                        onClick={() => {
                          setPwResetUserId(u.id);
                          setPwResetValue("");
                          setPwResetConfirm("");
                        }}
                      >
                        Reset password
                      </button>
                    )}
                  </td>
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

      <div className={`section${activeTab === "ai" ? "" : " settings-hidden"}`}>
        <h2>LLM routing</h2>
        <p className="settings-help">Assign providers and models by cost and capability, then route each AI task to the appropriate tier.</p>
        {llmTiering && (
          <>
            {llmNotice && (
              <div className="card" style={{ marginBottom: 12 }}>
                {llmNotice}
              </div>
            )}
            {LLM_TIERS.map((tier) => {
              const config = llmTiering.tiers[tier];
              const models = tierModels[tier];
              return (
                <div className="card" style={{ marginBottom: 12 }} key={tier}>
                  <div className="form-row" style={{ alignItems: "center" }}>
                    <div style={{ minWidth: 180 }}>
                      <strong>{config.label}</strong>
                      <div className="faint">{config.description}</div>
                    </div>
                    <select
                      value={config.provider}
                      onChange={(e) =>
                        setLlmTiering({
                          ...llmTiering,
                          tiers: {
                            ...llmTiering.tiers,
                            [tier]: { ...config, provider: e.target.value as LlmConfig["provider"] },
                          },
                        })
                      }
                    >
                      <option value="anthropic">Anthropic</option>
                      <option value="openai">OpenAI</option>
                      <option value="gemini">Gemini</option>
                      <option value="openai_compatible">OpenAI-compatible / local</option>
                    </select>
                    <input
                      type="text"
                      placeholder={modelPlaceholder(config.provider)}
                      value={config.model}
                      style={{ minWidth: 220, display: models.length ? "none" : undefined }}
                      onChange={(e) =>
                        setLlmTiering({
                          ...llmTiering,
                          tiers: { ...llmTiering.tiers, [tier]: { ...config, model: e.target.value } },
                        })
                      }
                    />
                    {models.length > 0 && (
                      <select
                        value={config.model}
                        style={{ minWidth: 220 }}
                        onChange={(e) =>
                          setLlmTiering({
                            ...llmTiering,
                            tiers: { ...llmTiering.tiers, [tier]: { ...config, model: e.target.value } },
                          })
                        }
                      >
                        {!models.includes(config.model) && <option value={config.model}>{config.model}</option>}
                        {models.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                    )}
                    <input
                      type="number"
                      min={1}
                      value={config.max_tokens}
                      style={{ width: 120 }}
                      onChange={(e) =>
                        setLlmTiering({
                          ...llmTiering,
                          tiers: { ...llmTiering.tiers, [tier]: { ...config, max_tokens: Number(e.target.value) } },
                        })
                      }
                    />
                    <button
                      onClick={() =>
                        act(async () => {
                          await saveCurrentTier(tier);
                          const result = await api.llmTierModels(tier);
                          setTierModels((current) => ({ ...current, [tier]: result.models }));
                          if (result.models.length > 0 && !result.models.includes(config.model)) {
                            setLlmTiering((current) =>
                              current
                                ? {
                                    ...current,
                                    tiers: {
                                      ...current.tiers,
                                      [tier]: { ...current.tiers[tier], model: result.models[0] },
                                    },
                                  }
                                : current
                            );
                          }
                          setLlmNotice(
                            result.models.length
                              ? `Loaded ${result.models.length} model(s) for ${config.label}. Select one, then save or test.`
                              : `No models returned for ${config.label}.`
                          );
                        }, false)
                      }
                    >
                      Load models
                    </button>
                    <button
                      className="primary"
                      onClick={() =>
                        act(async () => {
                          await saveCurrentTier(tier);
                          setLlmNotice(`${config.label} tier saved.`);
                        }, false)
                      }
                    >
                      Save tier
                    </button>
                  </div>
                  <div className="form-row">
                    <input
                      type="text"
                      placeholder={baseUrlPlaceholder(config.provider)}
                      value={config.base_url}
                      style={{ flex: 1, minWidth: 360 }}
                      onChange={(e) =>
                        setLlmTiering({
                          ...llmTiering,
                          tiers: { ...llmTiering.tiers, [tier]: { ...config, base_url: e.target.value } },
                        })
                      }
                    />
                    <input
                      type="password"
                      placeholder={config.has_api_key ? "Stored API key" : "API key, optional for local"}
                      value={tierApiKeys[tier]}
                      onChange={(e) => setTierApiKeys((keys) => ({ ...keys, [tier]: e.target.value }))}
                    />
                    {config.has_api_key && <span className="faint">saved</span>}
                    {config.has_api_key && (
                      <button
                        className="danger"
                        onClick={() =>
                          act(async () => {
                            const saved = await api.updateLlmTier(tier, { clear_api_key: true });
                            setLlmTiering({
                              ...llmTiering,
                              tiers: { ...llmTiering.tiers, [tier]: saved },
                            });
                            setLlmNotice(`${config.label} API key cleared.`);
                          }, false)
                        }
                      >
                        Clear key
                      </button>
                    )}
                    <button
                      onClick={() =>
                        act(async () => {
                          setLlmTestStatus("running");
                          setLlmTestResult(undefined);
                          try {
                            await saveCurrentTier(tier);
                            setLlmTestTier(tier);
                            setLlmTestRoute("test");
                            const result = await api.testLlm(llmTestPrompt, config.max_tokens, tier);
                            setLlmTestStatus("ok");
                            setLlmTestResult(
                              `${result.tier}/${result.route} · ${result.provider}/${result.model} · max ${result.max_tokens} token(s)\n${result.text}`
                            );
                            setLlmNotice(`${config.label} test completed.`);
                          } catch (e) {
                            setLlmTestStatus("error");
                            setLlmTestResult((e as Error).message);
                            throw e;
                          }
                        }, false)
                      }
                      disabled={llmTestStatus === "running"}
                    >
                      Test tier
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="card" style={{ marginBottom: 12 }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th>Tier</th>
                    <th>Default</th>
                  </tr>
                </thead>
                <tbody>
                  {LLM_ROUTES.map((item) => (
                    <tr key={item.route}>
                      <td>{item.label}</td>
                      <td>
                        <select
                          value={llmTiering.routes[item.route]}
                          onChange={(e) =>
                            setLlmTiering({
                              ...llmTiering,
                              routes: { ...llmTiering.routes, [item.route]: e.target.value as LlmTier },
                            })
                          }
                        >
                          {LLM_TIERS.map((tier) => (
                            <option key={tier} value={tier}>
                              {llmTiering.tiers[tier].label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="faint">{llmTiering.tiers[item.defaultTier].label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="form-row" style={{ marginTop: 12 }}>
                <button
                  className="primary"
                  onClick={() =>
                    act(async () => {
                      const result = await api.updateLlmRoutes(llmTiering.routes);
                      setLlmTiering({ ...llmTiering, routes: result.routes });
                      setLlmNotice("LLM feature routing saved.");
                    }, false)
                  }
                >
                  Save routing
                </button>
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
                <select value={llmTestTier} onChange={(e) => setLlmTestTier(e.target.value as LlmTier)}>
                  {LLM_TIERS.map((tier) => (
                    <option key={tier} value={tier}>
                      {llmTiering.tiers[tier].label}
                    </option>
                  ))}
                </select>
                <select value={llmTestRoute} onChange={(e) => setLlmTestRoute(e.target.value as LlmTaskRoute)}>
                  {LLM_ROUTES.map((item) => (
                    <option key={item.route} value={item.route}>
                      {item.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() =>
                    act(async () => {
                      setLlmTestStatus("running");
                      setLlmTestResult(undefined);
                      try {
                        const next = await saveCurrentTier(llmTestTier);
                        const selected = next.tiers[llmTestTier];
                        const result = await api.testLlm(llmTestPrompt, selected.max_tokens, llmTestTier, llmTestRoute);
                        setLlmTestStatus("ok");
                        setLlmTestResult(
                          `${result.tier}/${result.route} · ${result.provider}/${result.model || selected.model} · max ${result.max_tokens} token(s)\n${result.text}`
                        );
                        setLlmNotice("LLM test completed.");
                      } catch (e) {
                        setLlmTestStatus("error");
                        setLlmTestResult((e as Error).message);
                        throw e;
                      }
                    }, false)
                  }
                  disabled={llmTestStatus === "running"}
                >
                  {llmTestStatus === "running" ? "Testing..." : "Test route"}
                </button>
              </div>
              {llmTestStatus !== "idle" && (
                <pre className="mono" style={{ whiteSpace: "pre-wrap", maxHeight: 180, overflow: "auto", margin: "8px 0 0" }}>
                  {llmTestStatus === "running" ? "Testing LLM connection..." : llmTestResult}
                </pre>
              )}
              <div className="faint">
                Cheap/local defaults to LLM_LOCAL_BASE_URL or LLM_CHEAP_BASE_URL when present. OpenAI-compatible mode supports local/network services such as LM Studio, Ollama, vLLM, LocalAI, or an internal LLM gateway. Root URLs like http://10.0.0.142:1234 are normalized to /v1 automatically.
              </div>
            </div>
          </>
        )}
      </div>

      <div className={`section${activeTab === "ai" ? "" : " settings-hidden"}`}>
        <h2>Semantic search</h2>
        <p className="settings-help">Configure section embeddings used to retrieve relevant spec context for semantic and hybrid search.</p>
        {embedding && embeddingStatus && (
          <div className="card">
            {embeddingNotice && <div style={{ marginBottom: 12 }}>{embeddingNotice}</div>}
            <div className="form-row">
              <select
                value={embedding.provider}
                onChange={(e) => setEmbedding({ ...embedding, provider: e.target.value as EmbeddingConfig["provider"] })}
              >
                <option value="local_hash">Local deterministic</option>
                <option value="openai">OpenAI</option>
                <option value="gemini">Gemini</option>
                <option value="openai_compatible">OpenAI-compatible / local</option>
              </select>
              <input
                type="text"
                value={embedding.model}
                placeholder={
                  embedding.provider === "openai"
                    ? "text-embedding-3-small"
                    : embedding.provider === "gemini"
                      ? "gemini-embedding-001"
                      : embedding.provider === "openai_compatible"
                        ? "nomic-embed-text"
                        : "local-hash-v1"
                }
                style={{ minWidth: 240 }}
                onChange={(e) => setEmbedding({ ...embedding, model: e.target.value })}
              />
              <input
                type="number"
                min={16}
                value={embedding.dimensions}
                style={{ width: 110 }}
                onChange={(e) => setEmbedding({ ...embedding, dimensions: Number(e.target.value) })}
              />
              <button
                className="primary"
                onClick={() =>
                  act(async () => {
                    await saveCurrentEmbedding(embedding);
                    const status = await api.embeddingStatus();
                    setEmbeddingStatus(status);
                    setEmbeddingNotice("Embedding settings saved.");
                  }, false)
                }
              >
                Save embeddings
              </button>
              <button
                onClick={() =>
                  act(async () => {
                    await saveCurrentEmbedding(embedding);
                    const result = await api.reindexEmbeddings();
                    setEmbeddingStatus(result.status);
                    setEmbeddingNotice(`Semantic index updated: ${result.indexed_sections} changed section(s).`);
                  }, false)
                }
              >
                Reindex
              </button>
            </div>
            <div className="form-row">
              <input
                type="text"
                placeholder={
                  embedding.provider === "openai"
                    ? "Optional OpenAI-compatible proxy URL"
                    : embedding.provider === "gemini"
                      ? "Optional Gemini API base URL"
                      : embedding.provider === "openai_compatible"
                        ? "http://localhost:11434/v1 or http://embedding-gateway.internal/v1"
                        : "Not used by local deterministic embeddings"
                }
                value={embedding.base_url}
                style={{ flex: 1, minWidth: 360 }}
                onChange={(e) => setEmbedding({ ...embedding, base_url: e.target.value })}
              />
              <input
                type="password"
                placeholder={embedding.has_api_key ? "Stored embedding API key" : "Embedding API key, optional for local"}
                value={embeddingApiKey}
                onChange={(e) => setEmbeddingApiKey(e.target.value)}
              />
              {embedding.has_api_key && (
                <button
                  className="danger"
                  onClick={() =>
                    act(async () => {
                      const saved = await api.updateEmbeddingConfig({ clear_api_key: true });
                      setEmbedding(saved);
                      setEmbeddingNotice("Embedding API key cleared.");
                    }, false)
                  }
                >
                  Clear key
                </button>
              )}
            </div>
            <div className="cards" style={{ marginTop: 12 }}>
              <div className={`card${embeddingStatus.ready ? "" : " alert"}`}>
                <div className="label">Index status</div>
                <div><StatusBadge status={embeddingStatus.ready ? "approved" : "pending"} /> {embeddingStatus.provider}/{embeddingStatus.model}</div>
              </div>
              <div className="card">
                <div className="label">Indexed sections</div>
                <div className="mono">{embeddingStatus.indexed_sections}/{embeddingStatus.published_sections}</div>
              </div>
              <div className="card">
                <div className="label">Last indexed</div>
                <div className="faint">{embeddingStatus.last_indexed_at ? timeAgo(embeddingStatus.last_indexed_at) : "never"}</div>
              </div>
            </div>
            <div className="faint">
              Semantic and hybrid search use section-level embeddings. Local deterministic mode needs no network; OpenAI-compatible mode supports local embedding servers and internal gateways.
            </div>
          </div>
        )}
      </div>

      <div className={`section${activeTab === "integrations" ? "" : " settings-hidden"}`}>
        <h2>App keys</h2>
        <p className="settings-help">Store service credentials used for GitHub automation and verification of signed inbound requests.</p>
        {appKeys && (
          <div className="card">
            {appKeyNotice && <div style={{ marginBottom: 12 }}>{appKeyNotice}</div>}
            <div className="form-row">
              <input
                type="password"
                placeholder={appKeys.has_github_token ? "GitHub token saved (hidden)" : "GitHub token"}
                value={githubToken}
                style={{ flex: 1, minWidth: 260 }}
                onChange={(e) => setGithubToken(e.target.value)}
              />
              {appKeys.has_github_token && <span className="faint">•••••••• saved</span>}
              {appKeys.has_github_token && (
                <button
                  className="danger"
                  onClick={() =>
                    act(async () => {
                      const saved = await api.updateAppKeys({ clear_github_token: true });
                      setAppKeys(saved);
                      setAppKeyNotice("GitHub token cleared.");
                    }, false)
                  }
                >
                  Clear
                </button>
              )}
            </div>
            <div className="form-row">
              <input
                type="password"
                placeholder={
                  appKeys.has_github_webhook_secret ? "GitHub webhook secret saved (hidden)" : "GitHub webhook secret"
                }
                value={githubWebhookSecret}
                style={{ flex: 1, minWidth: 260 }}
                onChange={(e) => setGithubWebhookSecret(e.target.value)}
              />
              {appKeys.has_github_webhook_secret && <span className="faint">•••••••• saved</span>}
              {appKeys.has_github_webhook_secret && (
                <button
                  className="danger"
                  onClick={() =>
                    act(async () => {
                      const saved = await api.updateAppKeys({ clear_github_webhook_secret: true });
                      setAppKeys(saved);
                      setAppKeyNotice("GitHub webhook secret cleared.");
                    }, false)
                  }
                >
                  Clear
                </button>
              )}
            </div>
            <div className="form-row">
              <input
                type="password"
                placeholder={appKeys.has_slack_signing_secret ? "Slack signing secret saved (hidden)" : "Slack signing secret"}
                value={slackSigningSecret}
                style={{ flex: 1, minWidth: 260 }}
                onChange={(e) => setSlackSigningSecret(e.target.value)}
              />
              {appKeys.has_slack_signing_secret && <span className="faint">•••••••• saved</span>}
              {appKeys.has_slack_signing_secret && (
                <button
                  className="danger"
                  onClick={() =>
                    act(async () => {
                      const saved = await api.updateAppKeys({ clear_slack_signing_secret: true });
                      setAppKeys(saved);
                      setAppKeyNotice("Slack signing secret cleared.");
                    }, false)
                  }
                >
                  Clear
                </button>
              )}
            </div>
            <button
              className="primary"
              onClick={() =>
                act(async () => {
                  const saved = await api.updateAppKeys({
                    github_token: githubToken || undefined,
                    github_webhook_secret: githubWebhookSecret || undefined,
                    slack_signing_secret: slackSigningSecret || undefined,
                  });
                  setAppKeys(saved);
                  setGithubToken("");
                  setGithubWebhookSecret("");
                  setSlackSigningSecret("");
                  setAppKeyNotice("App keys saved. Stored values remain hidden.");
                }, false)
              }
            >
              Save app keys
            </button>
            <div className="faint" style={{ marginTop: 8 }}>
              GitHub token enables push-back PRs and webhook file fetches. GitHub and Slack secrets verify inbound webhook/action signatures.
            </div>
          </div>
        )}
      </div>

      <div className={`section${activeTab === "access" ? "" : " settings-hidden"}`}>
        <h2>LDAP</h2>
        <p className="settings-help">Connect a directory, map groups to registry roles, and test authentication before enabling it for users.</p>
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

      <div className={`section${activeTab === "ai" ? "" : " settings-hidden"}`}>
        <h2>Agent MCP guide</h2>
        <p className="settings-help">Preview the discovery guide and download a project-type agent pack with governed MCP instructions.</p>
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

      <div className={`section${activeTab === "ai" ? "" : " settings-hidden"}`}>
        <h2>Agent skills</h2>
        <p className="settings-help">Register governed Markdown procedures that agents can select during initialization. Restricted skills require extra scrutiny and never grant permission by themselves.</p>
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="form-row">
            <input type="text" placeholder="Skill name" value={skillName} onChange={(e) => setSkillName(e.target.value)} />
            <input type="text" placeholder="slug (optional)" value={skillSlug} onChange={(e) => setSkillSlug(e.target.value)} />
            <select value={skillRisk} onChange={(e) => setSkillRisk(e.target.value as AgentSkillRow["risk_level"])}>
              <option value="safe">Safe procedure</option>
              <option value="restricted">Restricted procedure</option>
            </select>
          </div>
          <div className="form-row">
            <input type="text" placeholder="When should an agent use this skill?" value={skillDescription} style={{ flex: 1 }} onChange={(e) => setSkillDescription(e.target.value)} />
          </div>
          <div className="form-row">
            <textarea placeholder="Step-by-step agent instructions. Do not include secrets or executable payloads." value={skillInstructions} style={{ width: "100%", minHeight: 110 }} onChange={(e) => setSkillInstructions(e.target.value)} />
          </div>
          <button
            className="primary"
            disabled={!skillName.trim() || !skillDescription.trim() || !skillInstructions.trim()}
            onClick={() =>
              act(async () => {
                await api.createAgentSkill({
                  name: skillName.trim(),
                  slug: skillSlug.trim() || skillName.trim(),
                  description: skillDescription.trim(),
                  instructions: skillInstructions.trim(),
                  risk_level: skillRisk,
                });
                setSkillName("");
                setSkillSlug("");
                setSkillDescription("");
                setSkillInstructions("");
                setSkillRisk("safe");
              })
            }
          >
            Register skill
          </button>
        </div>
        <table className="grid">
          <thead>
            <tr><th>Skill</th><th>Risk</th><th>Status</th><th>Purpose</th><th></th></tr>
          </thead>
          <tbody>
            {agentSkills.map((skill) => (
              <tr key={skill.id}>
                <td><strong>{skill.name}</strong><div className="mono faint">{skill.slug}{skill.built_in ? " · built in" : ""}</div></td>
                <td><StatusBadge status={skill.risk_level === "safe" ? "approved" : "pending"} /> {skill.risk_level}</td>
                <td>{skill.status}</td>
                <td className="dim">{skill.description}</td>
                <td>
                  <button onClick={() => act(() => api.updateAgentSkill(skill.id, { status: skill.status === "active" ? "disabled" : "active" }))}>
                    {skill.status === "active" ? "Disable" : "Enable"}
                  </button>{" "}
                  {!skill.built_in && <button className="danger" onClick={() => act(() => api.deleteAgentSkill(skill.id))}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={`section${activeTab === "governance" ? "" : " settings-hidden"}`}>
        <h2>Approval policies</h2>
        <p className="settings-help">Require a minimum number of approvals or named reviewers before matching spec changes can publish.</p>
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

      <div className={`section${activeTab === "governance" ? "" : " settings-hidden"}`}>
        <h2>Audit log</h2>
        <p className="settings-help">Review recent administrative and governance actions with their actor, time, and outcome.</p>
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

      <div className={`section${activeTab === "integrations" ? "" : " settings-hidden"}`}>
        <h2>Webhooks</h2>
        <p className="settings-help">Notify automation, Slack, or Google Chat when important review, publication, and feedback events occur.</p>
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

      <div className={`section${activeTab === "governance" ? "" : " settings-hidden"}`}>
        <h2>Projects</h2>
        <p className="settings-help">See which repositories report manifests, which project type governs them, and whether their specs are current.</p>
        {consumers.length === 0 ? (
          <div className="empty">No projects have reported a local spec manifest yet.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Repo</th>
                <th>Project type</th>
                <th>Specs</th>
                <th>Outdated</th>
                <th>Manifest</th>
                <th>Branch</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {consumers.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.repo}</td>
                  <td>{c.project_type_name}</td>
                  <td className="mono">{c.spec_count}</td>
                  <td>
                    {c.outdated_count > 0 ? <StatusBadge status="pending" /> : <StatusBadge status="approved" />}
                    <span className="mono" style={{ marginLeft: 6 }}>{c.outdated_count}</span>
                  </td>
                  <td className="mono">{c.manifest_path}</td>
                  <td className="mono">{c.branch ?? "—"}</td>
                  <td className="faint">{timeAgo(c.last_seen_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={`section${activeTab === "integrations" ? "" : " settings-hidden"}`}>
        <h2>Repo subscriptions (git push-back)</h2>
        <p className="settings-help">Subscribe repositories to approved spec changes so the registry can open synchronized update pull requests.</p>
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
            Approved spec versions open PRs against subscribed repos. Configure a GitHub token in App keys or GITHUB_TOKEN on the server.
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

      <div className={`section${activeTab === "integrations" ? "" : " settings-hidden"}`}>
        <h2>
          Sync jobs{" "}
          <button style={{ marginLeft: 8 }} onClick={() => act(() => api.runSyncJobs())}>
            Run pending
          </button>
        </h2>
        <p className="settings-help">Monitor and retry queued repository updates created when subscribed specifications are approved.</p>
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
