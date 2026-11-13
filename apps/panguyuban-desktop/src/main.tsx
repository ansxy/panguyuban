import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/host-grotesk/400.css";
import "@fontsource/host-grotesk/500.css";
import "@fontsource/atkinson-hyperlegible-mono/400.css";
import "@fontsource/atkinson-hyperlegible-mono/500.css";
import "./styles/app.css";
import { App } from "./App";
import { applyTheme, savedTheme } from "./theme";

applyTheme(savedTheme()); // before first render: no flash of the default theme
const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
