import { describe, expect, test } from "bun:test";
import { parsePublisherTrustArgs } from "./set-publisher-trust";

describe("publisher trust operator command", () => {
  test("maps the user-facing maintained tier to trusted=true", () => {
    expect(
      parsePublisherTrustArgs([
        "--github-owner-id",
        "owner_123",
        "--tier",
        "maintained",
        "--operator",
        "ops@example.com",
        "--reason",
        "Gas City publisher review",
      ]),
    ).toEqual({
      githubOwnerId: "owner_123",
      trusted: true,
      operator: "ops@example.com",
      reason: "Gas City publisher review",
    });
  });

  test("maps the emergency community downgrade to trusted=false", () => {
    expect(
      parsePublisherTrustArgs([
        "--github-owner-id=owner_123",
        "--tier=community",
        "--operator=ops@example.com",
        "--reason=Emergency downgrade",
      ]),
    ).toMatchObject({ trusted: false });
  });

  test("rejects unknown tiers and missing audit context", () => {
    expect(() =>
      parsePublisherTrustArgs([
        "--github-owner-id",
        "owner_123",
        "--tier",
        "official",
        "--operator",
        "ops@example.com",
        "--reason",
        "no",
      ]),
    ).toThrow(/--tier must be maintained or community/);
    expect(() =>
      parsePublisherTrustArgs([
        "--github-owner-id",
        "owner_123",
        "--tier",
        "maintained",
      ]),
    ).toThrow(/--operator requires a value/);
  });
});
