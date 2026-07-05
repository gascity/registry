import { readFileSync } from "node:fs";
import { createRegistryServer } from "./app";
import { loadConfig } from "./config";
import { createStore } from "./store";

const config = loadConfig();

// Bind the runtime mount prefix to what the built client actually serves: the dist
// asset prefix is the single source of truth, so the session-cookie Path can never
// silently disagree with the asset prefix on the shared apex origin (which would
// leak the cookie to sibling products). Falls back to REGISTRY_MOUNT_BASE in dev
// (no dist build).
const builtBase = deriveMountBaseFromDist();
if (builtBase !== null) config.mountBase = builtBase;

const store = createStore(config.databaseUrl, config.localDataPath);
await store.init();

const server = createRegistryServer({ config, store });

console.log(
  `[registry] listening on :${server.port} with ${store.kind} store, auth ${
    config.authProvider ?? "unconfigured"
  } (${config.devAuthEnabled ? "dev auth ON" : "dev auth off"})`,
);

process.on("SIGTERM", () => {
  void store.close().finally(() => process.exit(0));
});

function deriveMountBaseFromDist(): string | null {
  try {
    const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
    const match = html.match(/(?:src|href)="(\/[^"]*?)assets\//);
    return match ? match[1].replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}
