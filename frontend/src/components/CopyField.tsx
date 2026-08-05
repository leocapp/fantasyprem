"use client";

import { useState } from "react";

/**
 * Shows a value with a copy button. Falls back to selecting the text if the
 * clipboard API is unavailable (older browsers, or a page served over plain
 * HTTP on a local network).
 */
export default function CopyField({
  value,
  label,
  mono = false,
}: {
  value: string;
  label?: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {label ? <span className="text-xs text-[var(--text-dim)]">{label}</span> : null}
      <div className="flex gap-2">
        <input
          readOnly
          value={value}
          onFocus={(event) => event.currentTarget.select()}
          className={`input flex-1 ${mono ? "numeric tracking-widest" : ""}`}
        />
        <button type="button" onClick={copy} className="btn btn-ghost">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
