import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import "./AudiPickFieldSelectionDialog.css";

export type AudiPickSelectableField = {
  key: string;
  label: string;
  required?: boolean;
};

export type AudiPickFieldSelectionGroup = {
  ruleId: string;
  ruleName: string;
  ruleVersion?: string;
  fields: AudiPickSelectableField[];
  selectedFieldKeys?: string[];
  /** Batch callers can provide the files represented by this template group. */
  documentNames?: string[];
  /** Some templates, such as the revenue workpaper, require every field. */
  allFieldsRequired?: boolean;
  description?: string;
};

export type AudiPickFieldSelectionResult = {
  fieldKeysByRuleId: Record<string, string[]>;
  skipExistingMatchingFieldSet: boolean;
};

export type AudiPickFieldSelectionDialogProps = {
  open: boolean;
  mode: "single" | "batch";
  groups: AudiPickFieldSelectionGroup[];
  submitting?: boolean;
  onClose: () => void;
  onConfirm: (result: AudiPickFieldSelectionResult) => void;
};

function requiredKeys(group: AudiPickFieldSelectionGroup) {
  return group.fields
    .filter((field) => group.allFieldsRequired || field.required)
    .map((field) => field.key);
}

function initialSelection(groups: AudiPickFieldSelectionGroup[]) {
  return Object.fromEntries(
    groups.map((group) => {
      const knownKeys = new Set(group.fields.map((field) => field.key));
      const selected = (group.selectedFieldKeys ?? group.fields.map((field) => field.key))
        .filter((key) => knownKeys.has(key));
      return [group.ruleId, [...new Set([...selected, ...requiredKeys(group)])]];
    }),
  );
}

export function AudiPickFieldSelectionDialog({
  open,
  mode,
  groups,
  submitting = false,
  onClose,
  onConfirm,
}: AudiPickFieldSelectionDialogProps) {
  const [selection, setSelection] = useState<Record<string, string[]>>(() =>
    initialSelection(groups),
  );
  const [skipExisting, setSkipExisting] = useState(true);

  useEffect(() => {
    if (!open) return;
    setSelection(initialSelection(groups));
    setSkipExisting(true);
  }, [groups, open]);

  const selectedCount = useMemo(
    () => Object.values(selection).reduce((sum, keys) => sum + keys.length, 0),
    [selection],
  );
  const hasEmptyGroup = groups.some(
    (group) => (selection[group.ruleId]?.length ?? 0) === 0,
  );

  function setAll(selectAll: boolean) {
    setSelection(Object.fromEntries(groups.map((group) => [
      group.ruleId,
      selectAll ? group.fields.map((field) => field.key) : requiredKeys(group),
    ])));
  }

  function toggleField(group: AudiPickFieldSelectionGroup, field: AudiPickSelectableField) {
    if (group.allFieldsRequired || field.required) return;
    setSelection((current) => {
      const keys = current[group.ruleId] ?? [];
      const next = keys.includes(field.key)
        ? keys.filter((key) => key !== field.key)
        : [...keys, field.key];
      return { ...current, [group.ruleId]: next };
    });
  }

  function confirm() {
    if (!groups.length || hasEmptyGroup || submitting) return;
    onConfirm({
      fieldKeysByRuleId: Object.fromEntries(groups.map((group) => [
        group.ruleId,
        group.fields
          .map((field) => field.key)
          .filter((key) => selection[group.ruleId]?.includes(key)),
      ])),
      skipExistingMatchingFieldSet: mode === "batch" && skipExisting,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && !submitting) onClose();
    }}>
      <DialogContent
        showCloseButton={!submitting}
        className="ap-field-dialog"
        aria-describedby="ap-field-dialog-description"
      >
        <div className="ap-field-dialog__heading">
          <DialogTitle>选择提取字段</DialogTitle>
          <DialogDescription id="ap-field-dialog-description">
            {mode === "batch"
              ? `按模板确认本批次的字段，共 ${groups.length} 组模板。`
              : "确认本次需要提取的字段；必选字段会始终保留。"}
          </DialogDescription>
        </div>

        <div className="ap-field-dialog__toolbar" aria-label="字段快捷选择">
          <Button type="button" variant="secondary" size="sm" disabled={submitting} onClick={() => setAll(true)}>
            全选
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={submitting} onClick={() => setAll(false)}>
            仅必选
          </Button>
          <span aria-live="polite">已选 {selectedCount} 个字段</span>
        </div>

        <div className="ap-field-dialog__groups">
          {groups.map((group) => {
            const keys = selection[group.ruleId] ?? [];
            return (
              <section className="ap-field-group" key={group.ruleId} aria-labelledby={`ap-field-group-${group.ruleId}`}>
                <header className="ap-field-group__header">
                  <div>
                    <h3 id={`ap-field-group-${group.ruleId}`}>{group.ruleName}</h3>
                    <p>
                      {group.ruleVersion ? `v${group.ruleVersion}` : "当前版本"}
                      {mode === "batch" && group.documentNames?.length
                        ? ` · ${group.documentNames.length} 份文件`
                        : ""}
                    </p>
                  </div>
                  <span>{keys.length}/{group.fields.length}</span>
                </header>
                {group.description && <p className="ap-field-group__description">{group.description}</p>}
                {mode === "batch" && group.documentNames?.length ? (
                  <p className="ap-field-group__documents" title={group.documentNames.join("、")}>
                    {group.documentNames.join("、")}
                  </p>
                ) : null}
                <div className="ap-field-group__fields">
                  {group.fields.map((field) => {
                    const required = Boolean(group.allFieldsRequired || field.required);
                    const inputId = `ap-field-${group.ruleId}-${field.key}`;
                    return (
                      <label className="ap-field-option" htmlFor={inputId} key={field.key}>
                        <input
                          id={inputId}
                          type="checkbox"
                          checked={required || keys.includes(field.key)}
                          disabled={submitting || required}
                          onChange={() => toggleField(group, field)}
                        />
                        <span>
                          <strong>{field.label}</strong>
                          {required && <em>必选</em>}
                          <small>{field.key}</small>
                        </span>
                      </label>
                    );
                  })}
                  {!group.fields.length && <p className="ap-field-group__empty">该模板没有可选字段。</p>}
                </div>
              </section>
            );
          })}
          {!groups.length && <p className="ap-field-dialog__empty">当前没有可用的模板字段。</p>}
        </div>

        {mode === "batch" && (
          <label className="ap-field-dialog__skip">
            <input
              type="checkbox"
              checked={skipExisting}
              disabled={submitting}
              onChange={(event) => setSkipExisting(event.target.checked)}
            />
            <span>
              <strong>跳过已有相同字段组合的底稿</strong>
              <small>只处理尚未生成该模板和字段组合结果的文件。</small>
            </span>
          </label>
        )}

        {hasEmptyGroup && groups.length > 0 && (
          <p role="alert" className="ap-field-dialog__warning">每组模板至少选择一个字段。</p>
        )}
        <footer className="ap-field-dialog__footer">
          <Button type="button" variant="ghost" disabled={submitting} onClick={onClose}>取消</Button>
          <Button
            type="button"
            disabled={!groups.length || hasEmptyGroup}
            loading={submitting}
            loadingLabel="正在启动…"
            onClick={confirm}
          >
            开始提取
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
