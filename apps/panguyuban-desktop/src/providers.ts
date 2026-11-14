import { useEffect, useSyncExternalStore } from "react";
import { appDataGet, appDataSet, providerDeleteKey, providerModels } from "./api";
import { setAgentModel, setProviderAgents } from "./builder_flow";

/** An OpenAI-compatible API. Its key is in the system keychain, never here. */
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
}

export const PROVIDER_PRESETS = [
  { value: "openrouter", label: "OpenRouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { value: "9router", label: "9router (local)", name: "9router", baseUrl: "http://localhost:20128/v1" },
  { value: "custom", label: "Custom", name: "", baseUrl: "" },
];

let providers: Provider[] = [];
let started = false;
const listeners = new Set<() => void>();

function publish(next: Provider[]) {
  providers = next;
  setProviderAgents(next);
  listeners.forEach((l) => l());
}

function parse(raw: string | null): Provider[] {
  try {
    const list = JSON.parse(raw ?? "[]");
    return Array.isArray(list)
      ? list.filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && typeof p.baseUrl === "string")
      : [];
  } catch {
    return [];
  }
}

/** The saved providers, shared by Settings and the builder. Loaded once. */
export function useProviders() {
  useEffect(() => {
    if (started) return;
    started = true;
    appDataGet("providers")
      .then((raw) => publish(parse(raw)))
      .catch((err) => {
        started = false;
        console.error("could not load providers", err);
      });
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => providers
  );
}

async function save(next: Provider[]) {
  await appDataSet("providers", JSON.stringify(next));
  publish(next);
}

export async function addProvider(name: string, baseUrl: string): Promise<Provider> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 16) || "provider";
  const added = { id: `${slug}-${Math.random().toString(36).slice(2, 8)}`, name: name.trim(), baseUrl: baseUrl.trim() };
  await save([...providers, added]);
  return added;
}

/** Removes the provider, its key and any model chosen for it. */
export async function removeProvider(id: string) {
  await providerDeleteKey(id);
  await save(providers.filter((p) => p.id !== id));
  setAgentModel(`provider-${id}`, null);
}

/** Models for a `provider:<id>` harness; rejects if the provider is not saved. */
export function modelsForHarness(harness: string) {
  const p = providers.find((p) => `provider:${p.id}` === harness);
  return p ? providerModels(p.id, p.baseUrl) : Promise.reject("Provider not saved");
}
