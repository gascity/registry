import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@gascity/shell/styles.css"; // shared product chrome (pulls in @gascity/tokens)
import App from "./App";
import { initOpenPanel } from "./lib/openpanel";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element #root was not found.");
}

initOpenPanel();

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
