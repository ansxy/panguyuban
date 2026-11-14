import React, { useEffect, useState } from "react";
import { providerHasKey, providerModels, providerSetKey } from "./api";
import { addProvider, PROVIDER_PRESETS, removeProvider, type Provider, useProviders } from "./providers";

/** Settings section: OpenAI-compatible APIs whose models can run Prototypes agent turns. */
export function ProvidersSection() {
  const providers = useProviders();
  const [preset, setPreset] = useState(PROVIDER_PRESETS[0].value);
  const [name, setName] = useState(PROVIDER_PRESETS[0].name);
  const [baseUrl, setBaseUrl] = useState(PROVIDER_PRESETS[0].baseUrl);
  const [key, setKey] = useState("");
  const [status, setStatus] = useState("");

  function choosePreset(value: string) {
    const p = PROVIDER_PRESETS.find((p) => p.value === value) ?? PROVIDER_PRESETS[2];
    setPreset(p.value);
    setName(p.name);
    setBaseUrl(p.baseUrl);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    try {
      const added = await addProvider(name, baseUrl);
      // Saved before the key so a keychain refusal leaves a provider the user can fix with "Save key".
      if (key.trim()) await providerSetKey(added.id, key);
      setKey("");
      choosePreset("custom");
      setStatus(`${added.name} added.`);
    } catch (err) {
      setStatus(`Could not add the provider: ${String(err)}`);
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-aside">
        <h2>Providers</h2>
        <p>Use models from OpenRouter, 9router or any OpenAI-compatible API in Prototypes. Keys stay in your system keychain.</p>
      </div>
      <div className="settings-body">
        {providers.length > 0 && (
          <ul className="feature-list">
            {providers.map((p) => (
              <ProviderRow key={p.id} provider={p} />
            ))}
          </ul>
        )}
        <form className="settings-body" onSubmit={handleAdd}>
          <div className="field-group">
            <label className="field-label" htmlFor="provider-preset">
              Preset
            </label>
            <select id="provider-preset" className="input-field" value={preset} onChange={(e) => choosePreset(e.target.value)}>
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="provider-name">
              Name
            </label>
            <input id="provider-name" type="text" autoComplete="off" className="input-field" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="provider-url">
              Base URL
            </label>
            <input
              id="provider-url"
              type="text"
              autoComplete="off"
              className="input-field"
              placeholder="https://example.com/v1"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="field-group">
            <label className="field-label" htmlFor="provider-key">
              API key
            </label>
            <input
              id="provider-key"
              type="password"
              autoComplete="off"
              className="input-field"
              placeholder="Optional for local servers"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </div>
          <div className="settings-save">
            <button type="submit" className="btn btn--primary" disabled={!name.trim() || !baseUrl.trim()}>
              Add provider
            </button>
            <span className="measured" role="status">
              {status}
            </span>
          </div>
        </form>
      </div>
    </section>
  );
}

function ProviderRow({ provider }: { provider: Provider }) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [key, setKey] = useState("");

  useEffect(() => {
    providerHasKey(provider.id)
      .then(setHasKey)
      .catch(() => setHasKey(false));
  }, [provider.id]);

  // An armed "Remove" disarms itself rather than waiting forever for the second click.
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  async function test() {
    setBusy(true);
    setStatus("Loading models…");
    try {
      const list = await providerModels(provider.id, provider.baseUrl);
      setCount(list.length);
      setStatus(`${list.length} models available.`);
    } catch (err) {
      setCount(null);
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    try {
      await providerSetKey(provider.id, key);
      setHasKey(key.trim() !== "");
      setKey("");
      setStatus("Key saved.");
    } catch (err) {
      setStatus(`Could not save the key: ${String(err)}`);
    }
  }

  async function remove() {
    if (!confirming) return setConfirming(true);
    try {
      await removeProvider(provider.id);
    } catch (err) {
      setStatus(`Could not remove: ${String(err)}`);
      setConfirming(false);
    }
  }

  return (
    <li className="feature-row provider-row">
      <div className="feature-text">
        <span className="feature-name">{provider.name}</span>
        <span className="provider-url">{provider.baseUrl}</span>
        <span className="feature-note">
          {hasKey === null ? "" : hasKey ? "Key saved" : "No key"}
          {count !== null && ` · ${count} models`}
        </span>
        <div className="provider-key">
          <input
            type="password"
            autoComplete="off"
            className="input-field"
            aria-label={`API key for ${provider.name}`}
            placeholder={hasKey ? "Replace the saved key" : "API key"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button type="button" className="btn" disabled={!key.trim()} onClick={saveKey}>
            Save key
          </button>
        </div>
        <span className="feature-note" role="status">
          {status}
        </span>
      </div>
      <div className="provider-actions">
        <button type="button" className="btn" disabled={busy} onClick={test}>
          Test &amp; load models
        </button>
        <button type="button" className={confirming ? "btn btn--danger" : "btn"} onClick={remove}>
          {confirming ? "Click again to remove" : "Remove"}
        </button>
      </div>
    </li>
  );
}
