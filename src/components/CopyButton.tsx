import { CheckCircle2, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type CopyState = "idle" | "copied" | "failed";

export function CopyButton({ text, ariaLabel }: { text: string; ariaLabel: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimeoutRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimeoutRef.current !== null) window.clearTimeout(resetTimeoutRef.current);
    },
    [],
  );

  const scheduleReset = () => {
    if (resetTimeoutRef.current !== null) window.clearTimeout(resetTimeoutRef.current);
    resetTimeoutRef.current = window.setTimeout(() => {
      setCopyState("idle");
      resetTimeoutRef.current = null;
    }, 2000);
  };

  const buttonLabel =
    copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy";

  return (
    <button
      className="copyButton"
      type="button"
      data-copy-state={copyState}
      aria-label={ariaLabel}
      onClick={() => {
        void copyText(text)
          .then((didCopy) => {
            setCopyState(didCopy ? "copied" : "failed");
            scheduleReset();
          })
          .catch(() => {
            setCopyState("failed");
            scheduleReset();
          });
      }}
    >
      {copyState === "copied" ? (
        <CheckCircle2 size={16} aria-hidden="true" />
      ) : (
        <Copy size={16} aria-hidden="true" />
      )}
      <span aria-live="polite">{buttonLabel}</span>
    </button>
  );
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  if (typeof document.execCommand !== "function") return false;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}
