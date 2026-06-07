import { useEffect, useRef, useState } from "react";

// ============================================================================
// funky 룩 커스텀 컨트롤 — funky-ui엔 Slider/Toggle이 없어 토큰 스타일로 자작.
// ============================================================================

export function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="fx-row">
      <div>
        <div className="fx-row-label">{label}</div>
        {desc && <div className="fx-row-desc">{desc}</div>}
      </div>
      <div className="fx-row-control">{children}</div>
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    let v = parseFloat(draft);
    if (!Number.isNaN(v)) {
      v = Math.min(max, Math.max(min, v));
      if (step >= 1) v = Math.round(v); // 정수 필드(너비/NEXT 등) 보호. step<1이면 세밀값 허용
      onChange(v);
    }
    setEditing(false);
  };

  return (
    <>
      <input
        className="fx-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      {editing ? (
        <input
          ref={inputRef}
          className="fx-slider-input"
          type="number"
          step="any"
          min={min}
          max={max}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span
          className="fx-slider-val fx-slider-val--editable"
          title="클릭해서 직접 입력"
          onClick={() => {
            setDraft(String(value));
            setEditing(true);
          }}
        >
          {format ? format(value) : value}
        </span>
      )}
    </>
  );
}

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={`fx-toggle ${value ? "on" : ""}`} onClick={() => onChange(!value)} role="switch" aria-checked={value}>
      <div className="knob" />
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { label: string; value: T }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="fx-seg">
      {options.map((o) => (
        <button key={String(o.value)} className={value === o.value ? "active" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const KEY_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Space: "Space",
  ShiftLeft: "L-Shift",
  ShiftRight: "R-Shift",
  ControlLeft: "L-Ctrl",
  ControlRight: "R-Ctrl",
  AltLeft: "L-Alt",
  AltRight: "R-Alt",
  Escape: "Esc",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "⌫",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Slash: "/",
  Comma: ",",
  Period: ".",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

export function keyLabel(code: string): string {
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "N" + code.slice(6);
  return code;
}

/** 단일 키 슬롯 — 한 버튼에 키 1개. 클릭 후 키 입력으로 지정, Backspace/Delete로 해제, Esc로 취소. */
export function KeySlot({ code, onSet, onClear }: { code: string | null; onSet: (code: string) => void; onClear: () => void }) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setListening(false);
        return;
      }
      if (e.code === "Backspace" || e.code === "Delete") {
        onClear();
        setListening(false);
        return;
      }
      onSet(e.code);
      setListening(false);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true } as EventListenerOptions);
  }, [listening, onSet, onClear]);

  return (
    <button className={`fx-key fx-key--slot ${listening ? "listening" : ""} ${code ? "" : "fx-key--empty"}`} onClick={() => setListening(true)}>
      {listening ? "..." : code ? keyLabel(code) : "+"}
    </button>
  );
}
