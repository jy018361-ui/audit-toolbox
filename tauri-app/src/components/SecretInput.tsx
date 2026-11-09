import { useEffect, useRef, useState } from "react";
import { secretGet } from "../api";
import { errorText } from "../lib/errors";
import "./SecretInput.css";

/** 查看凭据不修改表单草稿；只有用户编辑才交给父级保存。 */
export function SecretInput({
  label,
  credentialName,
  value,
  onChange,
  autoSave = false,
  placeholder = "留空表示不修改",
}: {
  label: string;
  credentialName: string;
  value: string;
  onChange: (value: string) => void;
  autoSave?: boolean;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [storedValue, setStoredValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const requestVersion = useRef(0);
  useEffect(
    () => () => {
      requestVersion.current += 1;
    },
    [],
  );

  async function toggleVisibility() {
    const version = ++requestVersion.current;
    setMessage("");
    setStoredValue("");
    if (visible) {
      setVisible(false);
      return;
    }
    setVisible(true);
    if (value) return;
    setLoading(true);
    try {
      const saved = await secretGet(credentialName);
      if (requestVersion.current !== version) return;
      setStoredValue(saved ?? "");
      if (!saved) setMessage(autoSave ? "尚未设置密钥。" : "尚未保存该密钥，请填写后保存。");
    } catch (error) {
      if (requestVersion.current === version) setMessage(errorText(error));
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }

  return (
    <span className="secret-field">
      <span className="secret-input">
        <input
          aria-label={label}
          type={visible ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={value || storedValue}
          placeholder={placeholder}
          onChange={(event) => {
            requestVersion.current += 1;
            setLoading(false);
            setStoredValue("");
            setMessage("");
            onChange(event.target.value);
          }}
        />
        <button
          type="button"
          className="secondary secret-visibility"
          aria-label={`${visible ? "隐藏" : "显示"}${label}`}
          aria-pressed={visible}
          disabled={loading}
          onClick={() => void toggleVisibility()}
        >
          {loading ? "读取中…" : visible ? "隐藏" : "显示"}
        </button>
      </span>
      {message && (
        <span className="secret-message" role="status">
          {message}
        </span>
      )}
    </span>
  );
}
