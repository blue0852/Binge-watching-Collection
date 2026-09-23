import { useEffect, useRef, useState } from 'react';
import { formatSourceLatency, sourceLatencyClass } from '../utils/sourceLatency.js';
import type { SourceInfo } from '../types.js';

interface Props {
  sources: SourceInfo[];
  value: string;
  latencies: Record<string, number | null>;
  latencyLoading: boolean;
  onChange: (key: string) => void;
}

function latencyText(key: string, latencies: Record<string, number | null>, loading: boolean): string {
  if (loading && !(key in latencies)) return '…';
  return formatSourceLatency(latencies[key]);
}

export default function SourceSelect({
  sources,
  value,
  latencies,
  latencyLoading,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = sources.find((s) => s.key === value) ?? sources[0];

  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!current) return null;

  return (
    <div className="source-picker" ref={rootRef}>
      <button
        type="button"
        className="source-picker-trigger"
        aria-label="选择资源站"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="source-picker-name">{current.name}</span>
        <span
          className={`source-latency ${sourceLatencyClass(latencies[current.key], latencyLoading && !(current.key in latencies))}`}
        >
          {latencyText(current.key, latencies, latencyLoading)}
        </span>
        <span className="source-picker-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul className="source-picker-menu" role="listbox" aria-label="资源站列表">
          {sources.map((s) => {
            const selected = s.key === value;
            const pending = latencyLoading && !(s.key in latencies);
            return (
              <li key={s.key} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`source-picker-item${selected ? ' active' : ''}`}
                  onClick={() => {
                    onChange(s.key);
                    setOpen(false);
                  }}
                >
                  <span className="source-picker-item-name">{s.name}</span>
                  <span className={`source-latency ${sourceLatencyClass(latencies[s.key], pending)}`}>
                    {latencyText(s.key, latencies, latencyLoading)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
