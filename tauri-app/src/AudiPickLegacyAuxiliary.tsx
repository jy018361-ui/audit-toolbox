import { useEffect, useState } from "react";
import { llmTest, secretSet, settingsGet, settingsSet } from "./api";
import { errorText } from "@/lib/errors";
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
};

const DEFAULT_FORM: ConfigForm = {
  enabled: false, apiType: "openai", baseUrl: "", model: "", apiKey: "",
  authMode: "bearer", timeout: "120", thinkingEnabled: false,
  ocrEngine: "ai", ocrApiKey: "", ocrSecret: "",
};

export function AudiPickLegacyConfig({ status, onSaved }: {
  status: { llm?: { ready: boolean }; ocr?: { ready: boolean; engine: string } };
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<"ocr" | "ai">("ocr");
  const [form, setForm] = useState(DEFAULT_FORM);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string }>();
  useEffect(() => {
    void settingsGet().then((value) => {
      const llm = (value.llm ?? {}) as Record<string, unknown>;
      const ocr = (value.ocr ?? {}) as Record<string, unknown>;
      setForm((current) => ({ ...current, enabled: Boolean(llm.enabled), apiType: String(llm.api_type ?? current.apiType), baseUrl: String(llm.base_url ?? ""), model: String(llm.model ?? ""), authMode: String(llm.auth_mode ?? current.authMode), timeout: String(llm.timeout ?? current.timeout), thinkingEnabled: Boolean(llm.thinking_enabled), ocrEngine: String(ocr.engine ?? current.ocrEngine) }));
    }).catch((error) => setMessage(errorText(error)));
  }, []);
  const set = <K extends keyof ConfigForm>(key: K, value: ConfigForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const llmSettings = () => ({ enabled: form.enabled, api_type: form.apiType, base_url: form.baseUrl.trim(), model: form.model.trim(), auth_mode: form.authMode, timeout: Number(form.timeout) || 120, thinking_enabled: form.thinkingEnabled });
  async function save() {
    setBusy(true); setMessage("");
    try {
      await settingsSet({ llm: llmSettings(), ocr: { engine: form.ocrEngine } });
      if (form.apiKey) await secretSet(form.apiType === "dify_chat" ? "dify_api_key" : "llm_api_key", form.apiKey);
      if (form.ocrApiKey) await secretSet("baidu_ocr_key", form.ocrApiKey);
      if (form.ocrSecret) await secretSet("baidu_ocr_secret", form.ocrSecret);
      setForm((current) => ({ ...current, apiKey: "", ocrApiKey: "", ocrSecret: "" }));
      setMessage("配置已保存，AudiPick 与工具箱将共同使用这些设置。");
      onSaved();
    } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setTestResult(undefined);
    try {
      const result = await llmTest({ llm: llmSettings() }, form.apiKey);
      setTestResult({ ok: true, text: `${result.message} 响应耗时 ${result.elapsedMs} 毫秒。` });
    } catch (error) { setTestResult({ ok: false, text: errorText(error) }); } finally { setBusy(false); }
  }
  const ocrLabel = form.ocrEngine === "baidu" ? "百度OCR" : form.ocrEngine === "local" ? "本机OCR" : "AI视觉";
  return (
    <div className="apl-page apl-config-page">
      <header className="apl-page-heading"><h1>配置</h1><p>管理 OCR 引擎与 AI 模型。提取模板请前往侧边栏「提取模板库」。</p></header>
      <div className="apl-config-stats"><article><span>提取AI</span><strong className={status.llm?.ready ? "ok" : "bad"}>{status.llm?.ready ? "已配置" : "未配置"}</strong><small>用于条款/底稿提取</small></article><article><span>桌面网络</span><strong className="ok">可用</strong><small>工具箱安全代理通道</small></article><article><span>OCR引擎</span><strong>{ocrLabel}</strong><small>扫描件PDF识别方式</small></article><article><span>OCR状态</span><strong className={status.ocr?.ready ? "ok" : "warn"}>{status.ocr?.ready ? "可用" : "待配置"}</strong><small>{status.ocr?.ready ? "识别服务已就绪" : "请完成下方配置"}</small></article></div>
      <div className="apl-config-tabs"><button className={tab === "ocr" ? "active" : ""} onClick={() => setTab("ocr")}>OCR引擎</button><button className={tab === "ai" ? "active" : ""} onClick={() => setTab("ai")}>AI模型</button></div>
      <section className="apl-config-card">
        {tab === "ocr" ? <>
          <h3>OCR引擎选择</h3><p>扫描件PDF的文字识别方式（括号内为识别速度参考）</p>
          {[{ id: "ai", title: "AI视觉识别", note: "速度较快，消耗token", detail: "调用工具箱统一多模态AI接口识别图片。" }, { id: "local", title: "本机OCR", note: "免费离线", detail: "使用本机OCR服务处理扫描件。" }, { id: "baidu", title: "第三方OCR", note: "速度取决于接口，如百度OCR", detail: "使用百度OCR密钥识别扫描件。" }].map((item) => <label key={item.id} className={`apl-ocr-option ${form.ocrEngine === item.id ? "selected" : ""}`}><input type="radio" checked={form.ocrEngine === item.id} onChange={() => set("ocrEngine", item.id)} /><span><strong>{item.title} <em>（{item.note}）</em></strong><small>{item.detail}</small></span></label>)}
          <div className="apl-config-warning">⚠ AI视觉与「AI模型」页共用工具箱加密保存的模型配置，密钥不会写入项目数据库。</div>
          {form.ocrEngine === "baidu" && <div className="apl-config-fields"><label>百度 API Key<input type="password" value={form.ocrApiKey} onChange={(event) => set("ocrApiKey", event.target.value)} placeholder="留空表示保留已保存值" /></label><label>百度 Secret Key<input type="password" value={form.ocrSecret} onChange={(event) => set("ocrSecret", event.target.value)} placeholder="留空表示保留已保存值" /></label></div>}
        </> : <>
          <h3>AI模型配置</h3><p>用于合同分类、条款提取与底稿复核，设置与工具箱共用。</p>
          <div className="apl-config-fields"><label className="apl-config-check"><input type="checkbox" checked={form.enabled} onChange={(event) => set("enabled", event.target.checked)} />启用 AI 模型</label><label>接口类型<select value={form.apiType} onChange={(event) => set("apiType", event.target.value)}><option value="openai">OpenAI 兼容接口</option><option value="dify_chat">Dify Chat App</option></select></label><label>Base URL<input value={form.baseUrl} onChange={(event) => set("baseUrl", event.target.value)} placeholder="https://api.xxx.com/v1" /></label><label>模型名称<input value={form.model} onChange={(event) => set("model", event.target.value)} placeholder="如 gpt-4o / qwen-plus" /></label><label>API Key<input type="password" value={form.apiKey} onChange={(event) => set("apiKey", event.target.value)} placeholder="留空表示保留已保存值" /></label><label>超时秒数<input value={form.timeout} onChange={(event) => set("timeout", event.target.value)} /></label></div>
          <div className="apl-config-row"><button disabled={busy} onClick={() => void test()}>检测可用性</button>{testResult && <span className={testResult.ok ? "ok" : "bad"}>{testResult.text}</span>}</div>
        </>}
        <div className="apl-config-save"><button className="primary" disabled={busy} onClick={() => void save()}>{busy ? "处理中…" : "保存设置"}</button>{message && <span>{message}</span>}</div>
      </section>
    </div>
  );
}

export function AudiPickLegacyGuide({ onClose }: { onClose: () => void }) {
  return <div className="apl-guide"><header><span>新手引导</span><button onClick={onClose}>关闭</button></header><h1>从项目到审计底稿，只需三步</h1><div><article><b>1</b><h2>建立项目并上传 PDF</h2><p>创建客户项目，可一次选择多个 PDF 或导入整个文件夹。</p></article><article><b>2</b><h2>确认文件与提取模板</h2><p>系统读取文字并推荐模板，你可以逐份确认或批量处理。</p></article><article><b>3</b><h2>提取、复核并导出</h2><p>核对原文证据、编辑结果、标记复核，再导出 Excel 底稿。</p></article></div><button className="primary" onClick={onClose}>开始使用</button></div>;
}
