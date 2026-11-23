import { useEffect, useState } from "react";
import { audipickOcrTest, audipickLlmTest, secretSet, settingsGet, settingsSet } from "./api";
import { errorText } from "@/lib/errors";
import { SecretInput } from "./components/SecretInput";
import { BAILIAN_OCR_BASE_URL, BAILIAN_OCR_MODEL, createOcrTestImage, ocrEngineLabel } from "./ocrConfig";
import "./AudiPickLegacyAuxiliary.css";

export function AudiPickLegacyHome({ onStart, onConfig }: { onStart: () => void; onConfig: () => void }) {
  return (
    <div className="apl-home">
      <header><div><span className="apl-home-mark">A</span><strong>AudiPick</strong></div><nav><button onClick={onConfig}>配置</button><button className="primary" onClick={onStart}>开始使用</button></nav></header>
      <section className="apl-home-hero"><span className="apl-home-bigmark">A</span><h1>AudiPick</h1><h2>智能合同审计助手</h2><p>从合同文档中提取关键条款，生成结构化工作底稿</p><button className="primary" onClick={onStart}>开始审计</button></section>
      <section className="apl-capabilities"><h2>核心能力</h2><div><article><b>↥</b><h3>批量上传PDF</h3><p>支持多文件、文件夹上传，扫描件自动OCR识别</p></article><article><b>▤</b><h3>AI智能提取</h3><p>自动识别合同中的关键条款和约束条件</p></article><article><b>✓</b><h3>导出工作底稿</h3><p>导出Excel格式工作底稿</p></article></div></section>
    </div>
  );
}

type ConfigForm = {
  mode: "inherit" | "dedicated";
  ocrSource: "inherit" | "dedicated" | "legacy";
  enabled: boolean;
  apiType: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  authMode: string;
  timeout: string;
  thinkingEnabled: boolean;
  ocrEngine: string;
  ocrApiKey: string;
  ocrSecret: string;
  bailianOcrUrl: string;
  bailianOcrModel: string;
  bailianOcrKey: string;
  ocrLlmEnabled: boolean;
  ocrApiType: string;
  ocrBaseUrl: string;
  ocrModel: string;
  ocrLlmApiKey: string;
  ocrAuthMode: string;
  ocrTimeout: string;
  ocrThinkingEnabled: boolean;
};

const DEFAULT_FORM: ConfigForm = {
  mode: "inherit",
  ocrSource: "inherit",
  enabled: false, apiType: "openai", baseUrl: "", model: "", apiKey: "",
  authMode: "bearer", timeout: "120", thinkingEnabled: false,
  ocrEngine: "ai", ocrApiKey: "", ocrSecret: "",
  bailianOcrUrl: BAILIAN_OCR_BASE_URL, bailianOcrModel: BAILIAN_OCR_MODEL, bailianOcrKey: "",
  ocrLlmEnabled: false, ocrApiType: "openai", ocrBaseUrl: "", ocrModel: "", ocrLlmApiKey: "",
  ocrAuthMode: "bearer", ocrTimeout: "120", ocrThinkingEnabled: false,
};

export type AudiPickConfigStatus = {
  llm?: { ready: boolean; source?: "dedicated" | "toolbox"; model?: string };
  ocr?: { ready: boolean; engine: string; source?: "inherit" | "dedicated" | "legacy"; llmSource?: "dedicated_ocr" | "dedicated" | "toolbox"; effectiveModel?: string };
  credentials?: { baiduApiKey: boolean; baiduSecretKey: boolean; llmApiKey: boolean; audipickOpenaiKey?: boolean; audipickDifyKey?: boolean; bailianOcrKey?: boolean; audipickOcrOpenaiKey?: boolean; audipickOcrDifyKey?: boolean; audipickOcrBaiduApiKey?: boolean; audipickOcrBaiduSecretKey?: boolean; audipickOcrBailianKey?: boolean };
};

export function AudiPickLegacyConfig({ status, onSaved }: {
  status: AudiPickConfigStatus;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<"ocr" | "ai">("ocr");
  const [form, setForm] = useState(DEFAULT_FORM);
  const [toolboxModel, setToolboxModel] = useState<Record<string, unknown>>({});
  const [toolboxOcrEngine, setToolboxOcrEngine] = useState("ai");
  const [dedicatedOcrEngine, setDedicatedOcrEngine] = useState("ai");
  const [legacyOcrAvailable, setLegacyOcrAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string }>();
  useEffect(() => {
    let active = true;
    void settingsGet().then((value) => {
      if (!active) return;
      const llm = (value.audipickLlm ?? {}) as Record<string, unknown>;
      setToolboxModel((value.llm ?? {}) as Record<string, unknown>);
      const ocr = (value.ocr ?? {}) as Record<string, unknown>;
      const audipickOcr = (value.audipickOcr ?? {}) as Record<string, unknown>;
      setToolboxOcrEngine(String(ocr.engine ?? "ai"));
      setDedicatedOcrEngine(String(audipickOcr.engine ?? "ai"));
      const ocrLlm = (value.audipickOcrLlm ?? {}) as Record<string, unknown>;
      const ocrSource = audipickOcr.mode === "inherit" || audipickOcr.mode === "dedicated" || audipickOcr.mode === "legacy"
        ? audipickOcr.mode
        : llm.mode === "dedicated" ? "legacy" : "inherit";
      setLegacyOcrAvailable(ocrSource === "legacy");
      const selectedOcr = ocrSource === "dedicated" ? audipickOcr : ocr;
      setForm((current) => ({ ...current, mode: llm.mode === "dedicated" ? "dedicated" : "inherit", enabled: llm.enabled !== false, apiType: String(llm.api_type ?? current.apiType), baseUrl: String(llm.base_url ?? ""), model: String(llm.model ?? ""), authMode: String(llm.auth_mode ?? current.authMode), timeout: String(llm.timeout ?? current.timeout), thinkingEnabled: Boolean(llm.thinking_enabled), ocrSource, ocrEngine: String(selectedOcr.engine ?? current.ocrEngine), bailianOcrUrl: String(audipickOcr.bailian_base_url ?? "").trim() || BAILIAN_OCR_BASE_URL, bailianOcrModel: String(audipickOcr.bailian_model ?? "").trim() || BAILIAN_OCR_MODEL, ocrLlmEnabled: ocrLlm.enabled !== false, ocrApiType: String(ocrLlm.api_type ?? current.ocrApiType), ocrBaseUrl: String(ocrLlm.base_url ?? ""), ocrModel: String(ocrLlm.model ?? ""), ocrAuthMode: String(ocrLlm.auth_mode ?? current.ocrAuthMode), ocrTimeout: String(ocrLlm.timeout ?? current.ocrTimeout), ocrThinkingEnabled: Boolean(ocrLlm.thinking_enabled) }));
      setLoaded(true);
    }).catch((error) => { if (active) setMessage(errorText(error)); });
    return () => { active = false; };
  }, []);
  const set = <K extends keyof ConfigForm>(key: K, value: ConfigForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setTestResult(undefined); setMessage("");
  };
  const changeOcrSource = (source: ConfigForm["ocrSource"]) => {
    setForm((current) => ({ ...current, ocrSource: source, ocrEngine: source === "dedicated" ? dedicatedOcrEngine : toolboxOcrEngine }));
    setTestResult(undefined); setMessage("");
  };
  const changeDedicatedOcrEngine = (engine: string) => {
    setDedicatedOcrEngine(engine);
    set("ocrEngine", engine);
  };
  const llmSettings = () => ({ mode: form.mode, enabled: form.enabled, api_type: form.apiType, base_url: form.baseUrl.trim(), model: form.model.trim(), auth_mode: form.authMode, timeout: Number(form.timeout) || 120, thinking_enabled: form.thinkingEnabled });
  const ocrLlmSettings = () => ({ mode: "dedicated", enabled: form.ocrLlmEnabled, api_type: form.ocrApiType, base_url: form.ocrBaseUrl.trim(), model: form.ocrModel.trim(), auth_mode: form.ocrAuthMode, timeout: Number(form.ocrTimeout) || 120, thinking_enabled: form.ocrThinkingEnabled });
  const bailianSettings = () => ({ bailian_base_url: form.bailianOcrUrl.trim() || BAILIAN_OCR_BASE_URL, bailian_model: form.bailianOcrModel.trim() || BAILIAN_OCR_MODEL });
  function validateDedicated() {
    if (form.mode !== "dedicated") return;
    if (!/^https?:\/\//i.test(form.baseUrl.trim())) throw new Error("请填写以 HTTP 或 HTTPS 开头的 Base URL。");
    if (form.apiType !== "dify_chat" && !form.model.trim()) throw new Error("请填写 AudiPick 专用模型名称。");
    if (!Number.isFinite(Number(form.timeout)) || Number(form.timeout) < 10 || Number(form.timeout) > 300) throw new Error("超时秒数须在 10 至 300 之间。");
  }
  function validateOcrDedicated() {
    if (form.ocrSource !== "dedicated" || form.ocrEngine !== "ai") return;
    if (!/^https?:\/\//i.test(form.ocrBaseUrl.trim())) throw new Error("请填写以 HTTP 或 HTTPS 开头的 OCR AI Base URL。");
    if (form.ocrApiType !== "dify_chat" && !form.ocrModel.trim()) throw new Error("请填写专用 OCR AI 模型名称。");
    if (!Number.isFinite(Number(form.ocrTimeout)) || Number(form.ocrTimeout) < 10 || Number(form.ocrTimeout) > 300) throw new Error("OCR AI 超时秒数须在 10 至 300 之间。");
  }
  async function save() {
    setBusy(true); setMessage("");
    try {
      const current = await settingsGet();
      if (tab === "ocr") {
        validateOcrDedicated();
        if (form.ocrSource === "dedicated") {
          if (form.ocrEngine === "baidu") {
            if (form.ocrApiKey.trim()) await secretSet("audipick_ocr_baidu_key", form.ocrApiKey.trim());
            if (form.ocrSecret.trim()) await secretSet("audipick_ocr_baidu_secret", form.ocrSecret.trim());
          }
          if (form.ocrEngine === "bailian" && form.bailianOcrKey.trim()) await secretSet("audipick_ocr_bailian_key", form.bailianOcrKey.trim());
          if (form.ocrEngine === "ai" && form.ocrLlmApiKey.trim()) await secretSet(form.ocrApiType === "dify_chat" ? "audipick_ocr_dify_api_key" : "audipick_ocr_llm_api_key", form.ocrLlmApiKey.trim());
          await settingsSet({
            audipickOcr: { ...((current.audipickOcr as object) ?? {}), mode: "dedicated", engine: form.ocrEngine, ...(form.ocrEngine === "bailian" ? bailianSettings() : {}) },
            audipickOcrLlm: { ...((current.audipickOcrLlm as object) ?? {}), ...ocrLlmSettings() },
          });
        } else {
          // `legacy` is an explicit compatibility marker. Do not rewrite the
          // shared OCR settings or move legacy/global credentials.
          await settingsSet({ audipickOcr: { ...((current.audipickOcr as object) ?? {}), mode: form.ocrSource } });
        }
      } else {
        validateDedicated();
        if (form.mode === "dedicated" && form.apiKey.trim()) await secretSet(form.apiType === "dify_chat" ? "audipick_dify_api_key" : "audipick_llm_api_key", form.apiKey.trim());
        await settingsSet({ audipickLlm: { ...(current.audipickLlm as object ?? {}), ...llmSettings() } });
      }
      setMessage(tab === "ocr" ? (form.ocrSource === "dedicated" ? "AudiPick专用OCR配置已保存，未更改工具箱OCR或合同提取模型；本次输入已保留。" : form.ocrSource === "legacy" ? "已保存旧版兼容来源，维持当前 OCR 行为；本次输入已保留。" : "OCR来源已保存：继承工具箱 OCR 配置；本次输入已保留。") : `配置已保存，${form.mode === "dedicated" ? "仅 AudiPick 使用专用模型，不改变工具箱模型" : "AudiPick 继承工具箱模型"}；本次输入已保留。`);
      onSaved();
    } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setTestResult(undefined);
    try {
      let result;
      if (tab === "ocr") {
        const image = createOcrTestImage();
        const source = form.ocrSource;
        validateOcrDedicated();
        const profile = source === "dedicated" && form.ocrEngine === "ai" ? ocrLlmSettings() : undefined;
        const config = { source, ...(source === "dedicated" && form.ocrEngine === "bailian" ? bailianSettings() : {}), ...(profile ? { profile } : {}) };
        const apiKey = source === "dedicated" ? (form.ocrEngine === "ai" ? form.ocrLlmApiKey : form.ocrEngine === "bailian" ? form.bailianOcrKey : form.ocrEngine === "baidu" ? form.ocrApiKey : "") : "";
        const secret = source === "dedicated" && form.ocrEngine === "baidu" ? form.ocrSecret : "";
        result = await audipickOcrTest(form.ocrEngine, image, apiKey, secret, config, source === "inherit");
      } else {
        validateDedicated();
        result = await audipickLlmTest(llmSettings(), form.mode === "dedicated" ? form.apiKey : "");
      }
      setTestResult({ ok: true, text: `${result.message} 响应耗时 ${result.elapsedMs} 毫秒。` });
    } catch (error) { setTestResult({ ok: false, text: errorText(error) }); } finally { setBusy(false); }
  }
  const ocrLabel = ocrEngineLabel(form.ocrEngine);
  const sourceOcr = form.ocrSource === "dedicated" ? "AudiPick 专用 OCR" : form.ocrSource === "legacy" ? "兼容旧版配置" : "工具箱 OCR";
  const savedOcrSource = status.ocr?.source === "dedicated" ? "AudiPick 专用 OCR" : status.ocr?.source === "legacy" ? "兼容旧版配置" : "工具箱 OCR";
  return (
    <div className="apl-page apl-config-page">
      <header className="apl-page-heading"><h1>配置</h1><p>管理 OCR 引擎与 AI 模型。提取模板请前往侧边栏「提取模板库」。</p></header>
      <div className="apl-config-stats"><article><span>提取AI</span><strong className={status.llm?.ready ? "ok" : "bad"}>{status.llm?.ready ? "已配置" : "未配置"}</strong><small>用于条款/底稿提取</small></article><article><span>连接验证</span><strong>按需测试</strong><small>请使用下方测试连接按钮</small></article><article><span>OCR引擎</span><strong>{ocrLabel}</strong><small>扫描件PDF识别方式</small></article><article><span>已保存 OCR 配置</span><strong className={status.ocr?.ready ? "ok" : "warn"}>{status.ocr?.ready ? "已配置" : "待配置"}</strong><small>配置存在不代表连接测试成功</small></article></div>
      <div className="apl-config-tabs"><button disabled={busy} className={tab === "ocr" ? "active" : ""} onClick={() => { setTab("ocr"); setTestResult(undefined); setMessage(""); }}>OCR引擎</button><button disabled={busy} className={tab === "ai" ? "active" : ""} onClick={() => { setTab("ai"); setTestResult(undefined); setMessage(""); }}>AI模型</button></div>
      <fieldset className="apl-config-card" disabled={busy || !loaded}>
        {tab === "ocr" ? <>
          <h3>OCR来源与引擎</h3><p>OCR 与合同提取AI分开选择。当前选择（保存后生效）：<strong>{sourceOcr}</strong>；提取AI来源可在「AI模型」页单独配置。</p>
          <p className="apl-model-source">已保存的实际 OCR 来源：{savedOcrSource} · {ocrEngineLabel(status.ocr?.engine)}{status.ocr?.effectiveModel ? ` · ${status.ocr.effectiveModel}` : ""}。更改来源后请保存。</p>
          <label>OCR配置来源<select aria-label="OCR配置来源" value={form.ocrSource} onChange={(event) => changeOcrSource(event.target.value as ConfigForm["ocrSource"])}><option value="inherit">继承工具箱 OCR</option><option value="dedicated">AudiPick 专用 OCR</option>{legacyOcrAvailable && <option value="legacy">沿用旧版配置（兼容）</option>}</select></label>
          {form.ocrSource === "legacy" && <div className="apl-inherited-model"><strong>沿用旧版配置</strong><p>未自动切换模型：OCR继续读取原有工具箱引擎参数；AI视觉继续按原 AudiPick AI 来源执行。请选择继承工具箱或 AudiPick 专用 OCR 以使用新拆分配置。</p></div>}
          {form.ocrSource === "inherit" && <div className="apl-inherited-model"><strong>继承工具箱 OCR（只读）</strong><p>当前引擎：{ocrEngineLabel(toolboxOcrEngine)}。AI视觉使用工具箱全局 LLM，不受合同提取AI来源影响。</p><p>修改 OCR 引擎及参数请返回工具箱设置；合同提取AI来源独立配置。</p></div>}
          {form.ocrSource === "dedicated" && <>
          {[{ id: "ai", title: "AI视觉识别", note: "速度较快，消耗token", detail: "使用独立的 AudiPick OCR 视觉模型配置。" }, { id: "local", title: "本机OCR", note: "免费离线", detail: "使用本机OCR服务处理扫描件。" }, { id: "baidu", title: "百度OCR", note: "速度取决于接口", detail: "使用仅供 AudiPick OCR 的独立凭据。" }, { id: "bailian", title: "百炼OCR", note: "独立配置，按调用计费", detail: "使用仅供 AudiPick OCR 的 URL、模型和密钥。" }].map((item) => <label key={item.id} className={`apl-ocr-option ${form.ocrEngine === item.id ? "selected" : ""}`}><input type="radio" checked={form.ocrEngine === item.id} onChange={() => changeDedicatedOcrEngine(item.id)} /><span><strong>{item.title} <em>（{item.note}）</em></strong><small>{item.detail}</small></span></label>)}
          <div className="apl-config-warning">AudiPick 专用 OCR 引擎、参数、视觉模型和密钥均独立保存；不修改工具箱 OCR 或合同提取 AI。密钥保存在 Windows 凭据管理器。</div>
          {form.ocrEngine === "ai" && <>
            <div className="apl-config-fields"><label className="apl-config-check"><input type="checkbox" checked={form.ocrLlmEnabled} onChange={(event) => set("ocrLlmEnabled", event.target.checked)} />启用专用 OCR AI</label><label>OCR AI 接口类型<select value={form.ocrApiType} onChange={(event) => set("ocrApiType", event.target.value)}><option value="openai">OpenAI 兼容接口</option><option value="dify_chat">Dify Chat App</option></select></label><label>OCR AI模型 Base URL<input aria-label="OCR AI模型 Base URL" value={form.ocrBaseUrl} onChange={(event) => set("ocrBaseUrl", event.target.value)} placeholder="https://api.xxx.com/v1" /></label><label>OCR AI模型名称<input aria-label="OCR AI模型名称" value={form.ocrModel} onChange={(event) => set("ocrModel", event.target.value)} placeholder="如 gpt-4o" /></label><label>OCR AI API Key<SecretInput label="OCR AI API Key" credentialName={form.ocrApiType === "dify_chat" ? "audipick_ocr_dify_api_key" : "audipick_ocr_llm_api_key"} value={form.ocrLlmApiKey} onChange={(value) => set("ocrLlmApiKey", value)} placeholder="留空表示保留已保存值" /></label><label>OCR AI超时秒数<input value={form.ocrTimeout} onChange={(event) => set("ocrTimeout", event.target.value)} /></label></div>
            <div className="apl-config-fields"><label>OCR AI鉴权方式<select value={form.ocrAuthMode} onChange={(event) => set("ocrAuthMode", event.target.value)}><option value="bearer">Bearer</option><option value="raw">原始 Authorization</option></select></label><label className="apl-config-check"><input type="checkbox" checked={form.ocrThinkingEnabled} onChange={(event) => set("ocrThinkingEnabled", event.target.checked)} />启用思考模式</label></div>
            <p>OCR AI Key：{(form.ocrApiType === "dify_chat" ? status.credentials?.audipickOcrDifyKey : status.credentials?.audipickOcrOpenaiKey) ? "•••••• 已保存" : "未保存"}。Dify Chat 不支持图片，请选 OpenAI 兼容视觉模型。</p>
          </>}
          {form.ocrEngine === "baidu" && <div className="apl-config-fields"><label>百度 API Key<SecretInput label="百度 API Key" credentialName="audipick_ocr_baidu_key" value={form.ocrApiKey} onChange={(value) => set("ocrApiKey", value)} placeholder="留空表示保留已保存值" /></label><label>百度 Secret Key<SecretInput label="百度 Secret Key" credentialName="audipick_ocr_baidu_secret" value={form.ocrSecret} onChange={(value) => set("ocrSecret", value)} placeholder="留空表示保留已保存值" /></label></div>}
          {form.ocrEngine === "baidu" && <p>API Key：{status.credentials?.audipickOcrBaiduApiKey ? "•••••• 已保存" : "未保存"}；Secret Key：{status.credentials?.audipickOcrBaiduSecretKey ? "•••••• 已保存" : "未保存"}。</p>}
          {form.ocrEngine === "bailian" && <>
            <div className="apl-config-fields">
              <label className="apl-config-wide">百炼 OCR URL<input value={form.bailianOcrUrl} onChange={(event) => set("bailianOcrUrl", event.target.value)} placeholder={BAILIAN_OCR_BASE_URL} /></label>
              <label>百炼 OCR 模型<input value={form.bailianOcrModel} onChange={(event) => set("bailianOcrModel", event.target.value)} placeholder={BAILIAN_OCR_MODEL} /></label>
              <label>百炼 OCR API Key<SecretInput label="百炼 OCR API Key" credentialName="audipick_ocr_bailian_key" value={form.bailianOcrKey} onChange={(value) => set("bailianOcrKey", value)} placeholder="留空表示保留已保存值" /></label>
            </div>
            <p className="apl-ocr-url">当前 URL：{form.bailianOcrUrl.trim() || BAILIAN_OCR_BASE_URL}</p>
            <p>填写与 API Key 同一业务空间的兼容接口 URL（通常以 /compatible-mode/v1 结尾），也支持完整 /chat/completions 地址。百炼 OCR 独立于合同提取模型。</p>
            <p>百炼 OCR API Key：{status.credentials?.audipickOcrBailianKey ? "•••••• 已保存" : "未保存"}。点击「显示」可查看已保存密钥。</p>
          </>}
          </>}
          <p>测试仅发送内置示例图片，不发送合同；第三方/AI 测试可能消耗一次额度。继承来源使用工具箱OCR配置；专用来源使用当前专用草稿。</p>
        </> : <>
          <h3>合同提取AI模型配置</h3><p>仅用于合同分类、条款提取与底稿复核。OCR视觉模型来源在「OCR引擎」页独立配置。</p>
          <div className="apl-config-fields"><label>合同提取AI配置来源<select aria-label="合同提取AI配置来源" value={form.mode} onChange={(event) => set("mode", event.target.value as ConfigForm["mode"])}><option value="inherit">继承工具箱模型</option><option value="dedicated">AudiPick 专用模型</option></select></label></div>
          <p className="apl-model-source">已保存的实际来源：{status.llm?.source === "dedicated" ? "AudiPick 专用模型" : "工具箱模型"}{status.llm?.model ? ` · ${status.llm.model}` : ""}。更改来源后请保存。</p>
          {form.mode === "inherit" ? <div className="apl-inherited-model"><strong>继承工具箱模型（只读）</strong><p>模型：{String(toolboxModel.model || "未配置")}；状态：{toolboxModel.enabled ? "已启用" : "未启用"}</p><p>Base URL：{String(toolboxModel.base_url || "未配置")}</p><p>修改共享模型请返回工具箱的「设置」。如需只调整 AudiPick，请选择专用模型。</p></div> : <>
          <div className="apl-config-fields"><label className="apl-config-check"><input type="checkbox" checked={form.enabled} onChange={(event) => set("enabled", event.target.checked)} />启用 AI 模型</label><label>接口类型<select value={form.apiType} onChange={(event) => set("apiType", event.target.value)}><option value="openai">OpenAI 兼容接口</option><option value="dify_chat">Dify Chat App</option></select></label><label>Base URL<input value={form.baseUrl} onChange={(event) => set("baseUrl", event.target.value)} placeholder="https://api.xxx.com/v1" /></label><label>模型名称<input value={form.model} onChange={(event) => set("model", event.target.value)} placeholder="如 gpt-4o / qwen-plus" /></label><label>API Key<SecretInput key={form.apiType} label="API Key" credentialName={form.apiType === "dify_chat" ? "audipick_dify_api_key" : "audipick_llm_api_key"} value={form.apiKey} onChange={(value) => set("apiKey", value)} placeholder="留空表示保留已保存值" /></label><label>超时秒数<input value={form.timeout} onChange={(event) => set("timeout", event.target.value)} /></label></div>
          <div className="apl-config-fields"><label>鉴权方式<select value={form.authMode} onChange={(event) => set("authMode", event.target.value)}><option value="bearer">Bearer</option><option value="raw">原始 Authorization</option></select></label><label className="apl-config-check"><input type="checkbox" checked={form.thinkingEnabled} onChange={(event) => set("thinkingEnabled", event.target.checked)} />启用思考模式</label></div>
          <p>专用 API Key：{(form.apiType === "dify_chat" ? status.credentials?.audipickDifyKey : status.credentials?.audipickOpenaiKey) ? "•••••• 已保存" : "未保存"}。留空保留原密钥，点击「显示」可查看。</p><p>专用模型失败时会说明原因，不会静默切换至工具箱模型。Dify Chat 不支持 AI 图片 OCR，请选百炼、百度或本机 OCR。</p>
          </>}
          <p>测试仅发送内置连接测试文字，不发送合同；测试可能消耗额度，不会保存草稿。</p>
        </>}
        <div className="apl-config-row"><button onClick={() => void test()}>{tab === "ocr" ? "测试 OCR 连接" : "检测可用性"}</button>{testResult && <span role="status" className={testResult.ok ? "ok" : "bad"}>{testResult.text}</span>}</div>
        <div className="apl-config-save"><button className="primary" disabled={busy} onClick={() => void save()}>{busy ? "处理中…" : "保存设置"}</button>{message && <span>{message}</span>}</div>
      </fieldset>
    </div>
  );
}

export function AudiPickLegacyGuide({ onClose }: { onClose: () => void }) {
  return <div className="apl-guide"><header><span>新手引导</span><button onClick={onClose}>关闭</button></header><h1>从项目到审计底稿，只需三步</h1><div><article><b>1</b><h2>建立项目并上传 PDF</h2><p>创建客户项目，可一次选择多个 PDF 或导入整个文件夹。</p></article><article><b>2</b><h2>确认文件与提取模板</h2><p>系统读取文字并推荐模板，你可以逐份确认或批量处理。</p></article><article><b>3</b><h2>提取、复核并导出</h2><p>核对原文证据、编辑结果、标记复核，再导出 Excel 底稿。</p></article></div><button className="primary" onClick={onClose}>开始使用</button></div>;
}
