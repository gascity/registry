import { createStore } from "../server/store";

export type PublisherTrustArgs = {
  githubOwnerId: string;
  trusted: boolean;
  operator: string;
  reason: string;
};

export function parsePublisherTrustArgs(argv: string[]): PublisherTrustArgs {
  const values = new Map<string, string>();
  const supported = new Set([
    "--github-owner-id",
    "--tier",
    "--operator",
    "--reason",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const equals = argument.indexOf("=");
    const flag = equals >= 0 ? argument.slice(0, equals) : argument;
    if (!supported.has(flag)) {
      throw new Error(`unknown argument ${JSON.stringify(argument)}`);
    }
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    values.set(flag, value.trim());
  }

  for (const flag of supported) {
    if (!values.get(flag)) throw new Error(`${flag} requires a value`);
  }
  const tier = values.get("--tier");
  if (tier !== "maintained" && tier !== "community") {
    throw new Error("--tier must be maintained or community");
  }

  return {
    githubOwnerId: values.get("--github-owner-id")!,
    trusted: tier === "maintained",
    operator: values.get("--operator")!,
    reason: values.get("--reason")!,
  };
}

async function main() {
  const options = parsePublisherTrustArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for publisher trust changes");
  }
  const store = createStore(databaseUrl);
  if (store.kind !== "postgres") {
    throw new Error("publisher trust changes require the Postgres production store");
  }
  await store.init();
  try {
    const publisher = await store.setPublisherTrustByGithubOwnerId(
      options.githubOwnerId,
      options.trusted,
      {
        operator: options.operator,
        reason: options.reason,
      },
    );
    console.log(
      JSON.stringify({
        publisher: publisher.displayName,
        githubOwnerId: publisher.githubOwnerId,
        tier: publisher.trusted ? "maintained" : "community",
      }),
    );
  } finally {
    await store.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      `set-publisher-trust: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
