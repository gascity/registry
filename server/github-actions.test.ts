import { describe, expect, test } from "bun:test";
import {
  assertGitHubActionsCanMintPublishToken,
  type GitHubActionsIdentity,
} from "./github-actions";
import { RequestError } from "./http";

const commit = "a".repeat(40);
const input = {
  repoUrl: "https://github.com/acme/packs",
  commit,
  packPath: "tools",
  requestedName: "acme/tools",
  requestedVersion: "1.2.3",
};

function identity(overrides: Partial<GitHubActionsIdentity> = {}): GitHubActionsIdentity {
  return {
    repository: "acme/packs",
    sha: commit,
    workflowRef: "acme/packs/.github/workflows/publish.yml@refs/tags/v1.2.3",
    ...overrides,
  };
}

describe("GitHub Actions publish workflow boundary", () => {
  test("accepts a caller and reusable workflow owned by the publishing repository", () => {
    expect(
      assertGitHubActionsCanMintPublishToken(
        identity({
          jobWorkflowRef:
            "acme/packs/.github/workflows/reusable-publish.yml@refs/heads/main",
        }),
        input,
      ).requestedName,
    ).toBe("acme/tools");
  });

  test("refuses an organization-owned reusable workflow even when the caller is local", () => {
    try {
      assertGitHubActionsCanMintPublishToken(
        identity({
          jobWorkflowRef:
            "acme/shared-workflows/.github/workflows/publish.yml@refs/heads/main",
        }),
        input,
      );
      throw new Error("Expected the reusable workflow boundary to reject.");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError);
      expect((error as RequestError).status).toBe(403);
      expect((error as RequestError).code).toBe("GITHUB_ACTIONS_WORKFLOW_DENIED");
    }
  });

  test("continues to refuse a caller workflow outside the publishing repository", () => {
    expect(() =>
      assertGitHubActionsCanMintPublishToken(
        identity({
          workflowRef:
            "acme/shared-workflows/.github/workflows/publish.yml@refs/heads/main",
        }),
        input,
      ),
    ).toThrow("caller and reusable workflows");
  });
});
