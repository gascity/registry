const host = process.env.DEV_HOST ?? "127.0.0.1";
const frontendPort = process.env.VITE_DEV_PORT ?? "5173";
const apiPort = process.env.REGISTRY_API_PORT ?? "8081";
const frontendOrigin = `http://${host}:${frontendPort}`;
const apiOrigin = `http://${host}:${apiPort}`;

const env = {
  ...process.env,
  APP_URL: process.env.APP_URL ?? frontendOrigin,
  PORT: apiPort,
  REGISTRY_API_URL: process.env.REGISTRY_API_URL ?? apiOrigin,
  REGISTRY_DATA_PATH: process.env.REGISTRY_DATA_PATH ?? ".registry-data/registry.local.json",
  REGISTRY_DEV_AUTH: process.env.REGISTRY_DEV_AUTH ?? "1",
};

const children = [
  Bun.spawn({
    cmd: ["bun", "server/index.ts"],
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
  Bun.spawn({
    cmd: ["bunx", "vite", "--host", host, "--port", frontendPort, "--strictPort"],
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
];

console.log(`[registry] local app: ${frontendOrigin}`);
console.log(`[registry] local API: ${apiOrigin}`);
console.log(`[registry] local state: ${env.REGISTRY_DATA_PATH}`);

let shuttingDown = false;

async function shutdown(code: number) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  await Promise.allSettled(children.map((child) => child.exited));
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(0);
  });
}

void Promise.race(children.map((child) => child.exited)).then((code) => {
  void shutdown(typeof code === "number" ? code : 1);
});
