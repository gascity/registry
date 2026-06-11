import { createRegistryServer } from "./app";
import { loadConfig } from "./config";
import { createStore } from "./store";

const config = loadConfig();
const store = createStore(config.databaseUrl, config.localDataPath);
await store.init();

const server = createRegistryServer({ config, store });

console.log(
  `[registry] listening on :${server.port} with ${store.kind} store (${config.devAuthEnabled ? "dev auth on" : "dev auth off"})`,
);

process.on("SIGTERM", () => {
  void store.close().finally(() => process.exit(0));
});
