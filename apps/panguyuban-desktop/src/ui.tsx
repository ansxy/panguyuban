import React from "react";

export function padCount(count: number): string {
  return String(count).padStart(2, "0");
}

/** Segmented filter above a list (replaces the old per-filter sidebar menu). */
export function FilterTabs<T extends string>(props: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; count: number }[];
}) {
  return (
    <div className="filter-tabs" role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="filter-tab"
          aria-pressed={props.value === o.value}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
          <span className="measured">{o.count}</span>
        </button>
      ))}
    </div>
  );
}
