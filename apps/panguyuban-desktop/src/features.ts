import { useState } from "react";

export type FeatureKey = "tickets" | "prs" | "agents" | "meetings" | "prototypes" | "requests";

export const FEATURES: { key: FeatureKey; label: string; what: string; cost?: string }[] = [
  { key: "tickets", label: "Tickets", what: "Plane tickets in the sidebar and on Overview." },
  { key: "prs", label: "Pull requests", what: "GitHub pull requests, reviews and merges." },
  {
    key: "agents",
    label: "Agents",
    what: "Live Claude Code and Antigravity sessions.",
    cost: "Checks for sessions every 3 seconds.",
  },
  {
    key: "meetings",
    label: "Meetings",
    what: "Today's meetings and the calendar on Overview.",
    cost: "Reads the Calendar app every 5 minutes.",
  },
  {
    key: "prototypes",
    label: "Prototypes",
    what: "The guided prototype builder.",
    cost: "Looks for installed agents when the app opens.",
  },
  { key: "requests", label: "Requests", what: "HTTP client for your endpoints." },
];

const KEY = "panguyuban.features";

function load(): Record<FeatureKey, boolean> {
  let saved: Partial<Record<FeatureKey, unknown>> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    // storage unavailable or corrupt: everything on
  }
  // Unknown or missing keys stay on.
  return Object.fromEntries(FEATURES.map((f) => [f.key, saved[f.key] !== false])) as Record<FeatureKey, boolean>;
}

/** Which features are on (all, by default), remembered on this machine. */
export function useFeatures(): [Record<FeatureKey, boolean>, (key: FeatureKey, on: boolean) => void] {
  const [features, setFeatures] = useState(load);
  function set(key: FeatureKey, on: boolean) {
    const next = { ...features, [key]: on };
    setFeatures(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // storage unavailable: the choice lasts until the app closes
    }
  }
  return [features, set];
}
