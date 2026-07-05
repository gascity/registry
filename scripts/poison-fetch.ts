// Preload helper for hermetic subprocess tests. Any network fetch becomes a hard
// failure so a test that accidentally reaches the network fails loudly instead of
// silently depending on live upstream. Wire it in with:
//   bun --preload ./scripts/poison-fetch.ts scripts/generate-registry.ts <args...>
globalThis.fetch = (async (input: unknown): Promise<Response> => {
  const target =
    typeof input === "string" ? input : String((input as { url?: unknown })?.url ?? input);
  throw new Error(`network fetch is forbidden in this context: ${target}`);
}) as typeof fetch;
