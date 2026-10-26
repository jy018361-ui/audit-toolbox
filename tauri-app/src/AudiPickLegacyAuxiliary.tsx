import { useEffect, useState } from "react";
import { audipickOcrTest, audipickLlmTest, secretSet, settingsGet, settingsSet } from "./api";
import { errorText } from "@/lib/errors";
import { SecretInput } from "./components/SecretInput";
import { BAILIAN_OCR_BASE_URL, BAILIAN_OCR_MODEL, ocrEngineLabel } from "./ocrConfig";
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
};

const DEFAULT_FORM: ConfigForm = {
  mode: "inherit",
  enabled: false, apiType: "openai", baseUrl: "", model: "", apiKey: "",
  authMode: "bearer", timeout: "120", thinkingEnabled: false,
  ocrEngine: "ai", ocrApiKey: "", ocrSecret: "",
  bailianOcrUrl: BAILIAN_OCR_BASE_URL, bailianOcrModel: BAILIAN_OCR_MODEL, bailianOcrKey: "",
};

export type AudiPickConfigStatus = {
  llm?: { ready: boolean; source?: "dedicated" | "toolbox"; model?: string };
  ocr?: { ready: boolean; engine: string };
  credentials?: { baiduApiKey: boolean; baiduSecretKey: boolean; llmApiKey: boolean; audipickOpenaiKey?: boolean; audipickDifyKey?: boolean; bailianOcrKey?: boolean };
};

export function AudiPickLegacyConfig({ status, onSaved }: {
  status: AudiPickConfigStatus;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<"ocr" | "ai">("ocr");
  const [form, setForm] = useState(DEFAULT_FORM);
  const [toolboxModel, setToolboxModel] = useState<Record<string, unknown>>({});
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
      setForm((current) => ({ ...current, mode: llm.mode === "dedicated" ? "dedicated" : "inherit", enabled: llm.enabled !== false, apiType: String(llm.api_type ?? current.apiType), baseUrl: String(llm.base_url ?? ""), model: String(llm.model ?? ""), authMode: String(llm.auth_mode ?? current.authMode), timeout: String(llm.timeout ?? current.timeout), thinkingEnabled: Boolean(llm.thinking_enabled), ocrEngine: String(ocr.engine ?? current.ocrEngine), bailianOcrUrl: String(ocr.bailian_base_url ?? "").trim() || BAILIAN_OCR_BASE_URL, bailianOcrModel: String(ocr.bailian_model ?? "").trim() || BAILIAN_OCR_MODEL }));
      setLoaded(true);
    }).catch((error) => { if (active) setMessage(errorText(error)); });
    return () => { active = false; };
  }, []);
  const set = <K extends keyof ConfigForm>(key: K, value: ConfigForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setTestResult(undefined); setMessage("");
  };
  const llmSettings = () => ({ mode: form.mode, enabled: form.enabled, api_type: form.apiType, base_url: form.baseUrl.trim(), model: form.model.trim(), auth_mode: form.authMode, timeout: Number(form.timeout) || 120, thinking_enabled: form.thinkingEnabled });
  const bailianSettings = () => ({ bailian_base_url: form.bailianOcrUrl.trim() || BAILIAN_OCR_BASE_URL, bailian_model: form.bailianOcrModel.trim() || BAILIAN_OCR_MODEL });
  function validateDedicated() {
    if (form.mode !== "dedicated") return;
    if (!/^https?:\/\//i.test(form.baseUrl.trim())) throw new Error("请填写以 HTTP 或 HTTPS 开头的 Base URL。");
    if (form.apiType !== "dify_chat" && !form.model.trim()) throw new Error("请填写 AudiPick 专用模型名称。");
    if (!Number.isFinite(Number(form.timeout)) || Number(form.timeout) < 10 || Number(form.timeout) > 300) throw new Error("超时秒数须在 10 至 300 之间。");
  }
  async function save() {
    setBusy(true); setMessage("");
    try {
      const current = await settingsGet();
      if (tab === "ocr") {
        if (form.ocrEngine === "baidu") {
          if (form.ocrApiKey.trim()) await secretSet("baidu_ocr_key", form.ocrApiKey.trim());
          if (form.ocrSecret.trim()) await secretSet("baidu_ocr_secret", form.ocrSecret.trim());
        }
        if (form.ocrEngine === "bailian" && form.bailianOcrKey.trim()) await secretSet("bailian_ocr_key", form.bailianOcrKey.trim());
        await settingsSet({ ocr: { ...(current.ocr as object ?? {}), engine: form.ocrEngine, ...(form.ocrEngine === "bailian" ? bailianSettings() : {}) } });
      } else {
        validateDedicated();
        if (form.mode === "dedicated" && form.apiKey.trim()) await secretSet(form.apiType === "dify_chat" ? "audipick_dify_api_key" : "audipick_llm_api_key", form.apiKey.trim());
        await settingsSet({ audipickLlm: { ...(current.audipickLlm as object ?? {}), ...llmSettings() } });
      }
      setMessage(tab === "ocr" ? "OCR 配置已保存，与工具箱共用；本次输入已保留。留空不会删除已保存的密钥。" : `配置已保存，${form.mode === "dedicated" ? "仅 AudiPick 使用专用模型，不改变工具箱模型" : "AudiPick 继承工具箱模型"}；本次输入已保留。`);
      onSaved();
    } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setTestResult(undefined);
    try {
      let result;
      if (tab === "ocr") {
        const canvas = document.createElement("canvas");
        canvas.width = 480; canvas.height = 100;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法创建 OCR 测试图片。");
        context.fillStyle = "white"; context.fillRect(0, 0, 480, 100);
        context.fillStyle = "black"; context.font = "32px sans-serif";
        context.fillText("AudiPick OCR 12345", 20, 62);
        const image = canvas.toDataURL("image/png").split(",")[1];
        result = form.ocrEngine === "bailian"
          ? await audipickOcrTest("bailian", image, form.bailianOcrKey, "", bailianSettings())
          : await audipickOcrTest(form.ocrEngine, image, form.ocrEngine === "baidu" ? form.ocrApiKey : "", form.ocrEngine === "baidu" ? form.ocrSecret : "");
      } else {
        validateDedicated();
        result = await audipickLlmTest(llmSettings(), form.mode === "dedicated" ? form.apiKey : "");
      }
      setTestResult({ ok: true, text: `${result.message} 响应耗时 ${result.elapsedMs} 毫秒。` });
    } catch (error) { setTestResult({ ok: false, text: errorText(error) }); } finally { setBusy(false); }
  }
  const ocrLabel = ocrEngineLabel(form.ocrEngine);
  return (
    <div className="apl-page apl-config-page">
      <header className="apl-page-heading"><h1>配置</h1><p>管理 OCR 引擎与 AI 模型。提取模板请前往侧边栏「提取模板库」。</p></header>
      <div className="apl-config-stats"><article><span>提取AI</span><strong className={status.llm?.ready ? "ok" : "bad"}>{status.llm?.ready ? "已配置" : "未配置"}</strong><small>用于条款/底稿提取</small></article><article><span>连接验证</span><strong>按需测试</strong><small>请使用下方测试连接按钮</small></article><article><span>OCR引擎</span><strong>{ocrLabel}</strong><small>扫描件PDF识别方式</small></article><article><span>已保存 OCR 配置</span><strong className={status.ocr?.ready ? "ok" : "warn"}>{status.ocr?.ready ? "已配置" : "待配置"}</strong><small>配置存在不代表连接测试成功</small></article></div>
      <div className="apl-config-tabs"><button disabled={busy} className={tab === "ocr" ? "active" : ""} onClick={() => { setTab("ocr"); setTestResult(undefined); setMessage(""); }}>OCR引擎</button><button disabled={busy} className={tab === "ai" ? "active" : ""} onClick={() => { setTab("ai"); setTestResult(undefined); setMessage(""); }}>AI模型</button></div>
      <fieldset className="apl-config-card" disabled={busy || !loaded}>
        {tab === "ocr" ? <>
          <h3>OCR引擎选择</h3><p>选择扫描件 PDF 的文字识别方式，各引擎保留独立配置。</p>
          {[{ id: "ai", title: "AI视觉识别", note: "速度较快，消耗token", detail: "调用已选用的 AudiPick 多模态AI接口识别图片。" }, { id: "local", title: "本机OCR", note: "免费离线", detail: "使用本机OCR服务处理扫描件。" }, { id: "baidu", title: "百度OCR", note: "速度取决于接口", detail: "使用百度OCR密钥识别扫描件。" }, { id: "bailian", title: "百炼OCR", note: "独立配置，按调用计费", detail: "使用 qwen3.5-ocr 等百炼 OCR 模型识别扫描件。" }].map((item) => <label key={item.id} className={`apl-ocr-option ${form.ocrEngine === item.id ? "selected" : ""}`}><input type="radio" checked={form.ocrEngine === item.id} onChange={() => set("ocrEngine", item.id)} /><span><strong>{item.title} <em>（{item.note}）</em></strong><small>{item.detail}</small></span></label>)}
          <div className="apl-config-warning">{form.ocrEngine === "bailian" ? "百炼 OCR 使用独立 URL、模型和密钥；合同提取仍使用「AI模型」页的配置。" : "AI视觉与合同提取使用同一模型：优先使用已选用的 AudiPick 专用模型，否则继承工具箱。"}密钥统一加密保存，不写入项目数据库。</div>
          {form.ocrEngine === "baidu" && <div className="apl-config-fields"><label>百度 API Key<SecretInput label="百度 API Key" credentialName="baidu_ocr_key" value={form.ocrApiKey} onChange={(value) => set("ocrApiKey", value)} placeholder="留空表示保留已保存值" /></label><label>百度 Secret Key<SecretInput label="百度 Secret Key" credentialName="baidu_ocr_secret" value={form.ocrSecret} onChange={(value) => set("ocrSecret", value)} placeholder="留空表示保留已保存值" /></label></div>}
          {form.ocrEngine === "baidu" && <p>API Key：{status.credentials?.baiduApiKey ? "•••••• 已保存" : "未保存"}；Secret Key：{status.credentials?.baiduSecretKey ? "•••••• 已保存" : "未保存"}。点击对应的「显示」可查看已保存密钥；可输入新值替换。</p>}
          {form.ocrEngine === "bailian" && <>
            <div className="apl-config-fields">
              <label className="apl-config-wide">百炼 OCR URL<input value={form.bailianOcrUrl} onChange={(event) => set("bailianOcrUrl", event.target.value)} placeholder={BAILIAN_OCR_BASE_URL} /></label>
              <label>百炼 OCR 模型<input value={form.bailianOcrModel} onChange={(event) => set("bailianOcrModel", event.target.value)} placeholder={BAILIAN_OCR_MODEL} /></label>
              <label>百炼 OCR API Key<SecretInput label="百炼 OCR API Key" credentialName="bailian_ocr_key" value={form.bailianOcrKey} onChange={(value) => set("bailianOcrKey", value)} placeholder="留空表示保留已保存值" /></label>
            </div>
            <p className="apl-ocr-url">当前 URL：{form.bailianOcrUrl.trim() || BAILIAN_OCR_BASE_URL}</p>
            <p>填写与 API Key 同一业务空间的兼容接口 URL（通常以 /compatible-mode/v1 结尾），也支持完整 /chat/completions 地址。百炼 OCR 独立于合同提取模型。</p>
            <p>百炼 OCR API Key：{status.credentials?.bailianOcrKey ? "•••••• 已保存" : "未保存"}。点击「显示」可查看已保存密钥。</p>
          </>}
          <p>测试仅发送内置示例图片，不发送合同；第三方/AI 测试可能消耗一次额度。AI 视觉使用已保存的 AI 模型配置。</p>
        </> : <>
          <h3>AI模型配置</h3><p>用于合同分类、条款提取、底稿复核与 AI 视觉。配置和密钥仍由工具箱统一管理。</p>
          <div className="apl-config-fields"><label>模型来源<select value={form.mode} onChange={(event) => set("mode", event.target.value as ConfigForm["mode"])}><option value="inherit">继承工具箱模型</option><option value="dedicated">AudiPick 专用模型</option></select></label></div>
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
