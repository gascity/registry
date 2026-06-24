import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PanelProvider } from "@gascity/panel-sdk";
import "@gascity/shell/styles.css"; // shared product chrome (pulls in @gascity/tokens)
import App from "./App";
import { initOpenPanel } from "./lib/openpanel";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element #root was not found.");
}

initOpenPanel();

// PanelProvider OUTSIDE the app so the apex bridge handshake stays stable for the
// iframe lifetime; it auto-detects iframe-vs-standalone and no-ops when standalone.
// panelId MUST equal the apex slug ("registry").
createRoot(rootElement).render(
  <StrictMode>
    <PanelProvider panelId="registry">
      <App />
    </PanelProvider>
  </StrictMode>,
);
