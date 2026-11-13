/**
 * Reads a Postman v2.1 collection — the file the endpoint-requests skill keeps in
 * each project — into flat requests for the Requests view.
 */

export interface Row {
  key: string;
  value: string;
  enabled: boolean;
}

export interface ImportedRequest {
  name: string;
  method: string;
  url: string;
  params: Row[];
  headers: Row[];
  contentType: string;
  body: string;
}

interface PmPair {
  key?: string;
  value?: unknown;
  disabled?: boolean;
}

interface PmRequest {
  method?: string;
  url?: string | { raw?: string };
  header?: PmPair[];
  body?: {
    mode?: string;
    raw?: string;
    urlencoded?: PmPair[];
    options?: { raw?: { language?: string } };
  };
}

interface PmItem {
  name?: string;
  item?: PmItem[];
  request?: PmRequest | string;
}

const LANGUAGE_TYPES: Record<string, string> = {
  json: "application/json",
  xml: "application/xml",
  text: "text/plain",
};

/** Folders become a "Folder / Request" name prefix. `{{vars}}` with a value in the collection are filled in; the rest stay as typed so they stand out. */
export function parseCollection(text: string): ImportedRequest[] {
  const json = JSON.parse(text) as { item?: PmItem[]; variable?: PmPair[] };
  if (!Array.isArray(json?.item)) throw new Error("Not a Postman collection: no item list");

  const vars = new Map<string, string>();
  for (const v of json.variable ?? []) {
    if (v.key && !v.disabled && v.value !== undefined && v.value !== "") vars.set(v.key, String(v.value));
  }
  const fill = (s: string) => s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, key: string) => vars.get(key) ?? whole);
  const rows = (pairs: PmPair[] | undefined): Row[] =>
    (pairs ?? [])
      .filter((p) => p.key)
      .map((p) => ({ key: fill(p.key!), value: fill(String(p.value ?? "")), enabled: !p.disabled }));

  const out: ImportedRequest[] = [];
  const walk = (items: PmItem[], prefix: string) => {
    for (const item of items) {
      const name = `${prefix}${item.name ?? "Untitled"}`;
      if (Array.isArray(item.item)) {
        walk(item.item, `${name} / `);
        continue;
      }
      if (!item.request) continue;
      const req: PmRequest = typeof item.request === "string" ? { url: item.request } : item.request;
      const url = typeof req.url === "string" ? req.url : (req.url?.raw ?? "");
      const headers = rows(req.header);

      let contentType = "none";
      let body = "";
      if (req.body?.mode === "raw" && req.body.raw) {
        contentType = LANGUAGE_TYPES[req.body.options?.raw?.language ?? "text"] ?? "text/plain";
        body = fill(req.body.raw);
      } else if (req.body?.mode === "urlencoded") {
        contentType = "application/x-www-form-urlencoded";
        body = new URLSearchParams(
          rows(req.body.urlencoded)
            .filter((r) => r.enabled)
            .map((r) => [r.key, r.value])
        ).toString();
      }
      // ponytail: formdata, file and graphql bodies are skipped; add when a collection needs them.

      out.push({ name, method: (req.method ?? "GET").toUpperCase(), url: fill(url), params: [], headers, contentType, body });
    }
  };
  walk(json.item, "");
  return out;
}
