import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import { engineCall } from "@/api";

type AliasEntry = { source: string; target: string };

/** 「我的对照表」管理：查看人工确认过的列名配对并删除——拖错又勾了
 * 「记住」的条目必须能清掉，否则它会一直以高置信度自动生效。 */
export function HeaderAliasManager(props: { onClose: () => void }) {
  const [aliases, setAliases] = useState<AliasEntry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setBusy(true);
    engineCall("excel_merger.alias_list", {})
      .then((value) => {
        if (active) setAliases(((value as { aliases?: AliasEntry[] }).aliases ?? []));
      })
      .catch((e) => active && setError(errorText(e)))
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, []);

  async function remove(entry: AliasEntry) {
    setBusy(true);
    setError("");
    try {
      const value = (await engineCall("excel_merger.alias_delete", {
        source: entry.source,
        target: entry.target,
      })) as { aliases?: AliasEntry[] };
      setAliases(value.aliases ?? []);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hmg-overlay" onClick={props.onClose}>
      <div className="hmg-panel alias-panel" onClick={(event) => event.stopPropagation()}>
        <div className="hmg-topbar">
          <div className="hmg-title">
            <strong>我的对照表</strong>
            <span className="hmg-stats">
              记住的人工配对会在以后的匹配中自动采信
            </span>
          </div>
        </div>
        <div className="alias-list">
          {busy && !aliases.length ? (
            <p className="alias-empty">正在读取…</p>
          ) : aliases.length ? (
            aliases.map((entry) => (
              <div className="alias-row" key={`${entry.source}=>${entry.target}`}>
                <span className="alias-source" title={entry.source}>
                  {entry.source}
                </span>
                <span className="alias-arrow">→</span>
                <span className="alias-target" title={entry.target}>
                  {entry.target}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void remove(entry)}
                  aria-label={`删除 ${entry.source} 到 ${entry.target} 的对照`}
                >
                  删除
                </Button>
              </div>
            ))
          ) : (
            <p className="alias-empty">
              还没有记住的对照关系。在匹配网格勾选「记住本次手动对应关系」并完成合并后，
              人工配对会保存在这里。
            </p>
          )}
        </div>
        {error && <div className="error-box">{error}</div>}
        <div className="hmg-bottombar">
          <div className="hmg-main-actions">
            <Button onClick={props.onClose}>关闭</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
