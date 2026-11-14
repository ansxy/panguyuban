import { useEffect, useRef, useState } from "react";
import { appDataGet, appDataSet } from "./api";

const SAVE_DELAY_MS = 400;

/**
 * State kept in the app database under `key`. It starts as `initial` with `loaded` false and is
 * never saved until the stored value (or the old localStorage copy, migrated once) has been read,
 * so the empty start cannot overwrite saved data.
 */
export function usePersisted<T>(key: string, legacyKey: string, parse: (raw: string) => T, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  // Set when the saved value cannot be read; the view says so instead of loading forever.
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const dirty = useRef(false);

  useEffect(() => {
    // Read before awaiting: a remount must not see the key a first run already migrated away.
    let legacy: string | null = null;
    try {
      legacy = legacyKey ? window.localStorage.getItem(legacyKey) : null; // "" = nothing to migrate
    } catch {
      /* storage unavailable: nothing to migrate */
    }
    (async () => {
      const stored = await appDataGet(key);
      if (stored !== null) {
        setValue(parse(stored));
      } else if (legacy !== null) {
        setValue(parse(legacy));
        try {
          await appDataSet(key, legacy);
          window.localStorage.removeItem(legacyKey); // only once the database has it
        } catch (err) {
          console.error(`could not migrate ${key}`, err);
        }
      }
      setLoaded(true);
    })().catch((err) => {
      console.error(`could not load ${key}`, err);
      setError(String(err)); // stays unloaded, so nothing is overwritten
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flush() {
    if (!dirty.current) return;
    dirty.current = false;
    appDataSet(key, JSON.stringify(latest.current)).catch((err) => console.error(`could not save ${key}`, err));
  }

  useEffect(() => {
    if (!loaded) return;
    dirty.current = true;
    const timer = window.setTimeout(flush, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [value, loaded]);

  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, []);

  return [value, setValue, loaded, error] as const;
}
