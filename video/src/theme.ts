import { continueRender, delayRender, staticFile } from "remotion";

export const C = {
  bg: "#0a0a0b",
  raise: "#151517",
  line: "#26262a",
  text: "#f2f2ef",
  muted: "#8d8f96",
  accent: "#ff8a1f",
  ink: "#140900",
  ok: "#3ddc84",
  danger: "#ff5a52",
};

export const DISPLAY = "'Barlow Condensed', 'Arial Narrow', sans-serif";
export const BODY = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// Load the same display face the app uses before any frame renders.
let loaded = false;
export const loadFonts = () => {
  if (loaded || typeof document === "undefined") return;
  loaded = true;
  const handle = delayRender("Loading Barlow Condensed");
  Promise.all(
    [500, 700, 800].map((w) =>
      new FontFace("Barlow Condensed", `url(${staticFile(`fonts/barlow-condensed-latin-${w}-normal.woff2`)})`, {
        weight: String(w),
      })
        .load()
        .then((f) => document.fonts.add(f)),
    ),
  ).then(() => continueRender(handle));
};

export const formatTime = (ms: number) => {
  const t = Math.max(0, Math.floor(ms));
  const s = Math.floor(t / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}.${Math.floor((t % 1000) / 100)}`;
};
