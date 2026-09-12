import { useEffect, useState } from "react";
import { engineCall } from "@/api";
import {
  STRICT_ENTITY_SCOPE,
  candidateKey,
  selectionFromCandidates,
  type EntityScopeSelection,
  type EntityScopeSuggestions,
} from "@/entityScope";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import "./entity-scope-confirmation.css";

const clean = (values: readonly string[]) =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();

export function useEntityScopeConfirmation({
  tbEntities,
  jeEntities,
  onInvalidate,
}: {
  tbEntities: readonly string[];
  jeEntities: readonly string[];
  onInvalidate: () => void;
}) {
  const tb = clean(tbEntities);
  const je = clean(jeEntities);
  const signature = `${tb.join("\u001e")}\u001d${je.join("\u001e")}`;
  const [suggestions, setSuggestions] = useState<EntityScopeSuggestions>();
  const [selection, setSelection] = useState<EntityScopeSelection>(STRICT_ENTITY_SCOPE);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSelection(STRICT_ENTITY_SCOPE);
    setSuggestions(undefined);
    if (!tb.length || !je.length) return;
    let active = true;
    setLoading(true);
    void engineCall("ledger.entity_scope_suggestions", {
      tbEntities: tb,
      jeEntities: je,
    })
      .then((value) => {
        if (!active) return;
        const next = value as Partial<EntityScopeSuggestions>;
        setSuggestions({
          anchors: Array.isArray(next.anchors) ? next.anchors.map(String) : [],
          candidates: Array.isArray(next.candidates) ? next.candidates : [],
        });
      })
      .catch(() => {
        // 兼容旧版 Rust：没有候选接口时保持严格区分，不阻断原业务。
        if (active) setSuggestions({ anchors: [], candidates: [] });
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [signature]);

  const update = (next: EntityScopeSelection) => {
    setSelection(next);
    onInvalidate();
  };
  return {
    selection,
    panel:
      loading || suggestions?.candidates.length ? (
        <EntityScopeConfirmation
          loading={loading}
          suggestions={suggestions}
          value={selection}
          onChange={update}
        />
      ) : null,
  };
}

export function EntityScopeConfirmation({
  suggestions,
  value,
  loading = false,
  onChange,
}: {
  suggestions?: EntityScopeSuggestions;
  value: EntityScopeSelection;
  loading?: boolean;
  onChange: (value: EntityScopeSelection) => void;
}) {
  const candidates = suggestions?.candidates ?? [];
  const selected = new Set(
    value.mappings.map((mapping) =>
      [mapping.side, mapping.source, mapping.target].join("\u001f"),
    ),
  );
  const chooseMode = (mode: EntityScopeSelection["mode"]) =>
    onChange(mode === "strict" ? STRICT_ENTITY_SCOPE : selectionFromCandidates(candidates, selected));
  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(selectionFromCandidates(candidates, next));
  };
  return (
    <Card className="entity-scope-card">
      <CardHeader>
        <div className="entity-scope-heading">
          <div>
            <CardTitle>确认主体口径</CardTitle>
            <p>检测到 TB 与 JE 的主体名称不完全一致，请在首次测算前确认。</p>
          </div>
          <Badge variant="secondary">{loading ? "检测中" : `${candidates.length} 项候选`}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="entity-scope-modes" role="radiogroup" aria-label="主体处理方式">
          <label className={value.mode === "strict" ? "is-active" : ""}>
            <input type="radio" name="entity-scope-mode" checked={value.mode === "strict"} onChange={() => chooseMode("strict")} />
            <span><strong>严格区分</strong><small>不同主体分别核对，不自动合并。</small></span>
          </label>
          <label className={value.mode === "aggregate" ? "is-active" : ""}>
            <input type="radio" name="entity-scope-mode" checked={value.mode === "aggregate"} onChange={() => chooseMode("aggregate")} />
            <span><strong>部分归集</strong><small>只合并下方人工勾选的主体。</small></span>
          </label>
        </div>
        {value.mode === "aggregate" && (
          <div className="entity-scope-candidates">
            {candidates.map((candidate) => {
              const key = candidateKey(candidate);
              return (
                <label key={key}>
                  <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                  <span className="entity-scope-side">{candidate.sourceSide.toUpperCase()}</span>
                  <span><strong>{candidate.sourceEntity}</strong><small>归集至 {candidate.targetEntity}{candidate.reason ? ` · ${candidate.reason}` : ""}</small></span>
                </label>
              );
            })}
          </div>
        )}
        {suggestions?.anchors.length ? <p className="entity-scope-anchor">双方已完全匹配主体：{suggestions.anchors.join("、")}</p> : null}
      </CardContent>
    </Card>
  );
}
