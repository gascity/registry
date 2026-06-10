import { OpenPanel } from "@openpanel/web";

const defaultApiUrl = "https://events.gascity.com/api";
const defaultClientId = "0a41a871-6b2f-5a4a-97a5-38a696eae20b";
const productionHosts = new Set(["registry.gascity.com"]);

let openPanel: OpenPanel | null = null;

function hasTrackingOptOut(): boolean {
  try {
    return window.localStorage.getItem("disable_tracking") === "1";
  } catch {
    return false;
  }
}

function isOpenPanelEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (import.meta.env.VITE_OPENPANEL_ENABLED === "true") {
    return true;
  }
  return productionHosts.has(window.location.hostname);
}

export function initOpenPanel(): OpenPanel | null {
  if (openPanel) {
    return openPanel;
  }
  if (!isOpenPanelEnabled() || hasTrackingOptOut()) {
    return null;
  }

  openPanel = new OpenPanel({
    apiUrl: import.meta.env.VITE_OPENPANEL_API_URL || defaultApiUrl,
    clientId: import.meta.env.VITE_OPENPANEL_CLIENT_ID || defaultClientId,
    trackScreenViews: true,
    trackOutgoingLinks: true,
    trackAttributes: true,
    filter: () => !hasTrackingOptOut(),
  });
  openPanel.setGlobalProperties({
    app: "registry",
    environment: import.meta.env.MODE,
  });

  return openPanel;
}
