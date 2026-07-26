import { describe, expect, test } from "bun:test";
import type { PublishRequestRow, PublishSubmissionMethod } from "./api";
import { publishRequestPresentation } from "./publishRequestPresentation";

describe("publish request presentation", () => {
  test.each([
    ["github_import", "GitHub App import", "repo_proven"],
    ["github_actions_oidc", "GitHub Actions OIDC", "repo_proven"],
    ["web_session", "Manual web form", "claim_only"],
    ["api_token", "Personal or CLI token", "claim_only"],
  ] as const)(
    "labels %s submissions and their proof basis",
    (submissionMethod, submissionLabel, proofKind) => {
      const presentation = publishRequestPresentation(request({ submissionMethod }));

      expect(presentation.submission.label).toBe(submissionLabel);
      expect(presentation.proof.kind).toBe(proofKind);
      expect(presentation.proof.label).toBe(
        proofKind === "repo_proven" ? "Repository proven" : "Claim only",
      );
    },
  );

  test("fails closed for legacy requests whose submission method is missing", () => {
    const presentation = publishRequestPresentation(request({ submissionMethod: undefined }));

    expect(presentation.submission.label).toBe("Legacy or unknown");
    expect(presentation.proof.kind).toBe("claim_only");
    expect(presentation.proof.detail).toContain("does not carry repository proof");
  });

  test("explains when rename-stable GitHub identities were recorded", () => {
    const presentation = publishRequestPresentation(
      request({
        submissionMethod: "github_import",
        sourceGithubRepositoryId: "repo_123",
        sourceGithubOwnerId: "owner_123",
      }),
    );

    expect(presentation.proof.detail).toContain("survives GitHub renames");
  });

  test.each([
    ["pending_validation", "Validate"],
    ["validation_failed", "Fix"],
    ["pending_review", "staff review"],
    ["approved", "served"],
    ["rejected", "corrected request"],
    ["withdrawn", "no longer served"],
  ] as const)("gives publishers a next step for %s", (status, expectedText) => {
    const presentation = publishRequestPresentation(request({ status }), "publisher");

    expect(presentation.nextStep).toContain(expectedText);
  });

  test("gives staff an actionable ownership instruction for claim-only review", () => {
    const presentation = publishRequestPresentation(
      request({ status: "pending_review", submissionMethod: "api_token" }),
      "staff",
    );

    expect(presentation.nextStep).toContain("verified ownership");
    expect(presentation.nextStep).toContain("audited override");
  });

  test("gives claim-only publishers every supported path through ownership review", () => {
    const presentation = publishRequestPresentation(
      request({ status: "pending_review", submissionMethod: "web_session" }),
      "publisher",
    );

    expect(presentation.nextStep).toContain("verified ownership");
    expect(presentation.nextStep).toContain("organization membership");
    expect(presentation.nextStep).toContain("repo-proven");
    expect(presentation.nextStep).toContain("audited override");
  });

  test("tells a pending publisher to start validation instead of implying background work", () => {
    const presentation = publishRequestPresentation(
      request({ status: "pending_validation" }),
      "publisher",
    );

    expect(presentation.nextStep).toContain("Account");
    expect(presentation.nextStep).toContain("Validate");
    expect(presentation.nextStep).not.toContain("running");
    expect(presentation.nextStep).not.toContain("Refresh");
  });

  test("tells staff that repo-proven review already satisfies the ownership gate", () => {
    const presentation = publishRequestPresentation(
      request({ status: "pending_review", submissionMethod: "github_actions_oidc" }),
      "staff",
    );

    expect(presentation.nextStep).toContain("ownership gate is satisfied");
  });
});

function request(
  overrides: Partial<PublishRequestRow> & { submissionMethod?: PublishSubmissionMethod } = {},
): PublishRequestRow {
  return {
    id: "request_1",
    status: "pending_review",
    repository: {
      host: "github.com",
      owner: "acme",
      name: "packs",
      fullName: "acme/packs",
    },
    repoUrl: "https://github.com/acme/packs",
    sourceUrl: `https://github.com/acme/packs/tree/${"a".repeat(40)}/my-pack`,
    packPath: "my-pack",
    commit: "a".repeat(40),
    requestedName: "acme/my-pack",
    requestedVersion: "1.2.3",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    submittedBy: {
      id: "user_1",
      handle: "publisher",
      displayName: "Publisher",
      role: "user",
    },
    submissionMethod: "web_session",
    ...overrides,
  };
}
