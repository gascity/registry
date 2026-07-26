export const PACK_TIERS = ["maintained", "community"] as const;
export type PackTier = (typeof PACK_TIERS)[number];

export const UNKNOWN_PUBLISHER = "Unknown publisher";

export type PackAttribution = {
  tier: PackTier;
  publisher: string;
};

export function tierForTrusted(value: unknown): PackTier {
  return value === true ? "maintained" : "community";
}

export function normalizePackAttribution(
  rawTier: unknown,
  rawPublisher: unknown,
): PackAttribution {
  const publisher =
    typeof rawPublisher === "string" && rawPublisher.trim() && rawPublisher.trim() !== UNKNOWN_PUBLISHER
      ? rawPublisher.trim()
      : UNKNOWN_PUBLISHER;
  return {
    tier:
      rawTier === "maintained" && publisher !== UNKNOWN_PUBLISHER
        ? "maintained"
        : "community",
    publisher,
  };
}

export function compareByCodepoint(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
