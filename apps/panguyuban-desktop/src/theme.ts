// Colour themes: tokens.css has one :root[data-theme] block per slug; "" is the default Console theme.
export const THEMES = [
  { value: "", label: "Console" },
  { value: "dracula", label: "Dracula" },
  { value: "gruvbox", label: "Gruvbox" },
  { value: "nord", label: "Nord" },
  { value: "tokyo-night", label: "Tokyo Night" },
];

const KEY = "panguyuban.theme";

export function savedTheme(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function applyTheme(value: string) {
  if (value) document.documentElement.dataset.theme = value;
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // storage can throw (private mode); the theme still applies for this session
  }
  window.dispatchEvent(new Event("panguyuban:theme"));
}

// xterm can't parse oklch(), so paint the token on a 1x1 canvas and read the pixel back as hex.
const swatch = document.createElement("canvas");
swatch.width = swatch.height = 1;
export function tokenColor(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ctx = swatch.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = raw;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}
