import postgres from "postgres";

export type TestDatabase = { url: string; drop: () => Promise<void> };

// Mint a uniquely named database on the admin connection so each suite gets a pristine
// schema — store.init() runs the real migrate-on-boot DDL against it — and suites can't
// leak global state (listApprovedPublishRequests / catalog reads) into each other. The
// `registry_test_` prefix guarantees a valid unquoted identifier (never starts with a digit).
export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `registry_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await admin.end(); // always release the admin connection, even if DROP fails
      }
    },
  };
}
