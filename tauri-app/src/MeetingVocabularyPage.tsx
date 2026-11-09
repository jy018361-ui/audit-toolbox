import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  meetingVocabularyDelete,
  meetingVocabularyList,
  meetingVocabularySave,
  runningInDesktopApp,
} from "./api";
import type { MeetingVocabularyEntry } from "./types";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { confirmDialog } from "@/components/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { SwitchInput } from "@/components/SwitchInput";
import { meetingErrorText } from "@/lib/errors";
import "./meeting-vocabulary.css";

const CATEGORIES = {
  company: "公司",
  industry: "行业",
  other: "其他",
} as const;
const GROUP_HINTS = {
  company: "公司、部门、产品及内部项目名称",
  industry: "行业术语、工作缩写和常用表达",
  other: "其他需要特别识别的名称与词汇",
};
const emptyEntry = (
  category: MeetingVocabularyEntry["category"] = "company",
): MeetingVocabularyEntry => ({
  id: "",
  term: "",
  category,
  aliases: [],
  definition: "",
  enabled: true,
});

export function MeetingVocabularyPage() {
  const [entries, setEntries] = useState<MeetingVocabularyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<MeetingVocabularyEntry>();
  const [aliases, setAliases] = useState("");
  const termInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const loadVersion = useRef(0);
  const desktop = runningInDesktopApp();

  async function load() {
    const version = ++loadVersion.current;
    setLoading(true);
    setError("");
    try {
      const rows = await meetingVocabularyList();
      if (mounted.current && version === loadVersion.current) {
        setEntries(rows);
        setLoaded(true);
      }
    } catch (cause) {
      if (mounted.current && version === loadVersion.current) {
        setError(meetingErrorText(cause));
        setLoaded(false);
      }
    } finally {
      if (mounted.current && version === loadVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      loadVersion.current += 1;
    };
  }, []);

  async function mutate(
    action: () => Promise<MeetingVocabularyEntry[]>,
    message: string,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const rows = await action();
      if (mounted.current) {
        setEntries(rows);
        setNotice(message);
        setDraft(undefined);
      }
    } catch (cause) {
      if (mounted.current) setError(meetingErrorText(cause));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function edit(entry: MeetingVocabularyEntry) {
    setDraft({ ...entry, aliases: [...entry.aliases] });
    setAliases(entry.aliases.join("、"));
    setError("");
    setNotice("");
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || busyRef.current) return;
    const parsedAliases = [
      ...new Set(
        aliases
          .split(/[、,，;；\n]+/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (!draft.term.trim()) {
      setError("请填写标准名称。");
      return;
    }
    if (
      parsedAliases.length > 5 ||
      parsedAliases.some((value) => Array.from(value).length > 40)
    ) {
      setError("每条最多填写 5 个简称，每个简称最多 40 字。");
      return;
    }
    const entry = {
      ...draft,
      term: draft.term.trim(),
      definition: draft.definition.trim(),
      aliases: parsedAliases,
    };
    void mutate(
      () => meetingVocabularySave(entry),
      "词条已保存，将用于后续新任务。",
    );
  }

  async function remove(entry: MeetingVocabularyEntry) {
    if (busyRef.current) return;
    if (
      await confirmDialog({
        title: "删除词条",
        message: `确定删除「${entry.term}」？已生成的纪要不会改变。`,
        tone: "danger",
      })
    ) {
      if (mounted.current)
        await mutate(() => meetingVocabularyDelete(entry.id), "词条已删除。");
    }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = entries.filter((entry) =>
    [entry.term, ...entry.aliases, entry.definition].some((text) =>
      text.toLocaleLowerCase().includes(normalizedQuery),
    ),
  );
  const canEdit = desktop && loaded && !loading && !busy;

  return (
    <main className="tool-page meeting-vocabulary-page">
      <PageHeader
        eyebrow="会议纪要"
        title="专有词库"
        detail="常用词汇按区域收纳，点击词块查看和维护。"
        actions={<Link to="/tools/meeting_minutes">返回会议纪要</Link>}
      />
      {!desktop && (
        <p role="note" className="tool-trial-notice">
          浏览器预览模式：请在桌面应用中查看和维护本机词库。
        </p>
      )}
      <div className="meeting-vocabulary-toolbar">
        <label className="meeting-vocabulary-search">
          <span className="sr-only">搜索词库</span>
          <input
            type="search"
            placeholder="搜索名称、简称或含义"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span className="meeting-vocabulary-count">
          {entries.length} 个词条 ·{" "}
          {entries.filter((entry) => entry.enabled).length} 个启用
        </span>
        <Button disabled={!canEdit} onClick={() => edit(emptyEntry())}>
          新增词条
        </Button>
      </div>
      {error && !draft && (
        <div role="alert" className="meeting-vocabulary-error">
          {error}
          {!loaded && !loading && (
            <Button variant="ghost" onClick={() => void load()}>
              重新加载
            </Button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="meeting-vocabulary-notice">
          {notice}
        </p>
      )}
      <div className="meeting-vocabulary-groups" aria-busy={loading}>
        {loading ? (
          <p role="status">正在加载词库…</p>
        ) : (
          loaded &&
          (
            Object.entries(CATEGORIES) as [
              MeetingVocabularyEntry["category"],
              string,
            ][]
          ).map(([category, label]) => {
            const group = filtered.filter(
              (entry) => entry.category === category,
            );
            return (
              <section
                key={category}
                className="meeting-vocabulary-group"
                aria-labelledby={`vocabulary-${category}`}
              >
                <div className="meeting-vocabulary-group-header">
                  <div>
                    <h2 id={`vocabulary-${category}`}>
                      {label}词汇 <span>{group.length}</span>
                    </h2>
                    <p>{GROUP_HINTS[category]}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canEdit}
                    aria-label={`添加${label}词汇`}
                    onClick={() => edit(emptyEntry(category))}
                  >
                    ＋ 添加
                  </Button>
                </div>
                <div
                  className="meeting-vocabulary-words"
                  aria-label={`${label}词汇词块`}
                >
                  {group.length ? (
                    group.map((entry) => (
                      <button
                        type="button"
                        key={entry.id}
                        className={`meeting-vocabulary-word${entry.enabled ? "" : " is-disabled"}`}
                        disabled={!canEdit}
                        aria-label={`编辑 ${entry.term}`}
                        title={[
                          entry.term,
                          entry.aliases.length
                            ? `简称：${entry.aliases.join("、")}`
                            : "",
                          entry.definition,
                        ]
                          .filter(Boolean)
                          .join("\n")}
                        onClick={() => edit(entry)}
                      >
                        <span>{entry.term}</span>
                        {!entry.enabled && <small>停用</small>}
                      </button>
                    ))
                  ) : (
                    <p className="meeting-vocabulary-empty">
                      {normalizedQuery ? "没有匹配的词条" : "尚未添加词汇"}
                    </p>
                  )}
                </div>
              </section>
            );
          })
        )}
      </div>
      <details className="meeting-vocabulary-help">
        <summary>词库如何生效</summary>
        <p>
          保存后用于后续新任务，正在处理及已生成的纪要不受影响。启用词条及含义将随任务发送至配置的云端服务。
        </p>
        <p>
          Qwen ASR Flash
          3.0／3.1（含文件转写）支持热词；其他模型用于纪要理解。含非英文字符的热词最多
          15 字，纯英文最多 7 个单词；超长名称仍用于纪要理解，可补充较短简称。
        </p>
      </details>
      <Dialog
        open={!!draft}
        onOpenChange={(open) => {
          if (!open && !busyRef.current) {
            setDraft(undefined);
            setError("");
          }
        }}
      >
        {draft && (
          <DialogContent
            className="meeting-vocabulary-editor"
            showCloseButton={!busy}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              termInput.current?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>{draft.id ? "编辑词条" : "新增词条"}</DialogTitle>
              <DialogDescription>
                名称保留标准写法，含义用于解释缩写或特定业务语境。
              </DialogDescription>
            </DialogHeader>
            <form
              className="meeting-vocabulary-form"
              onSubmit={save}
              aria-label={draft.id ? "编辑词条" : "新增词条"}
            >
              <fieldset disabled={busy}>
                <label>
                  标准名称
                  <input
                    ref={termInput}
                    required
                    maxLength={40}
                    value={draft.term}
                    onChange={(event) =>
                      setDraft({ ...draft, term: event.target.value })
                    }
                    placeholder="公司全称、产品名或专业术语"
                  />
                </label>
                <label>
                  分类
                  <select
                    value={draft.category}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        category: event.target
                          .value as MeetingVocabularyEntry["category"],
                      })
                    }
                  >
                    {Object.entries(CATEGORIES).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="meeting-vocabulary-wide">
                  简称 / 别名
                  <input
                    value={aliases}
                    onChange={(event) => setAliases(event.target.value)}
                    placeholder="最多 5 个，用顿号或逗号分隔"
                  />
                </label>
                <label className="meeting-vocabulary-wide">
                  含义 / 使用语境
                  <textarea
                    rows={3}
                    maxLength={200}
                    value={draft.definition}
                    onChange={(event) =>
                      setDraft({ ...draft, definition: event.target.value })
                    }
                    placeholder="解释缩写、所属业务或特定含义（选填，最多 200 字）"
                  />
                </label>
                <div className="meeting-vocabulary-enabled">
                  <SwitchInput
                    ariaLabel="启用该词条"
                    checked={draft.enabled}
                    disabled={busy}
                    onChange={(enabled) => setDraft({ ...draft, enabled })}
                  />
                  <span>启用该词条</span>
                </div>
              </fieldset>
              {error && (
                <p role="alert" className="meeting-vocabulary-error">
                  {error}
                </p>
              )}
              <div className="meeting-vocabulary-editor-actions">
                {draft.id && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    aria-label={`删除 ${draft.term}`}
                    onClick={() => void remove(draft)}
                  >
                    删除词条
                  </Button>
                )}
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setDraft(undefined);
                      setError("");
                    }}
                  >
                    取消
                  </Button>
                  <Button type="submit" disabled={busy}>
                    {busy ? "正在保存…" : "保存词条"}
                  </Button>
                </div>
              </div>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </main>
  );
}
