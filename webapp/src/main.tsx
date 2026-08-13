import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { applyInitialTheme } from "./lib/theme";
// Self-hosted fonts: the boat may have no internet, so nothing loads from a CDN.
// Subsets on purpose. Archivo carries UI text (boat and port names, so latin plus
// latin-ext for European accents); the mono is digits and coordinates only, where
// latin suffices. Vietnamese is dropped: it never renders here and only bloats the
// tarball the AppStore installs onto disk-tight devices.
import "@fontsource/archivo/latin-300.css";
import "@fontsource/archivo/latin-ext-300.css";
import "@fontsource/archivo/latin-400.css";
import "@fontsource/archivo/latin-ext-400.css";
import "@fontsource/archivo/latin-500.css";
import "@fontsource/archivo/latin-ext-500.css";
import "@fontsource/archivo/latin-600.css";
import "@fontsource/archivo/latin-ext-600.css";
import "@fontsource/archivo/latin-700.css";
import "@fontsource/archivo/latin-ext-700.css";
import "@fontsource/archivo/latin-800.css";
import "@fontsource/archivo/latin-ext-800.css";
import "@fontsource/jetbrains-mono/latin-300.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "siparu-ui/swiss.css";

applyInitialTheme();

// HashRouter: Signal K serves the webapp from a static subpath
// (/signalk-siparu/) with no SPA fallback - path routing would 404 on
// refresh. Hash routing needs nothing from the server.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>
);
