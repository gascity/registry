import type {
  PublishRequestRow,
  PublishRequestStatus,
  PublishSubmissionMethod,
} from "./api";

export type PublishRequestAudience = "publisher" | "staff";
export type PublishProofKind = "repo_proven" | "claim_only";

export type PublishRequestPresentation = {
  submission: {
    label: string;
  };
  proof: {
    kind: PublishProofKind;
    label: string;
    detail: string;
  };
  nextStep: string;
};

export function publishRequestPresentation(
  request: PublishRequestRow,
  audience: PublishRequestAudience = "publisher",
): PublishRequestPresentation {
  const submission = submissionPresentation(request.submissionMethod);
  const proof = proofPresentation(request, submission.proofKind);

  return {
    submission: { label: submission.label },
    proof,
    nextStep: nextStepFor(request.status, proof.kind, audience),
  };
}

function submissionPresentation(method: PublishSubmissionMethod | undefined) {
  switch (method) {
    case "github_import":
      return { label: "GitHub App import", proofKind: "repo_proven" as const };
    case "github_actions_oidc":
      return { label: "GitHub Actions OIDC", proofKind: "repo_proven" as const };
    case "web_session":
      return { label: "Manual web form", proofKind: "claim_only" as const };
    case "api_token":
      return { label: "Personal or CLI token", proofKind: "claim_only" as const };
    default:
      return { label: "Legacy or unknown", proofKind: "claim_only" as const };
  }
}

function proofPresentation(
  request: PublishRequestRow,
  kind: PublishProofKind,
): PublishRequestPresentation["proof"] {
  if (kind === "repo_proven") {
    const stableIdentityRecorded =
      Boolean(request.sourceGithubRepositoryId) && Boolean(request.sourceGithubOwnerId);
    return {
      kind,
      label: "Repository proven",
      detail: stableIdentityRecorded
        ? "GitHub authenticated the repository and owner, and the recorded numeric-ID proof survives GitHub renames."
        : "GitHub authenticated control of the source repository. This request does not show both rename-stable GitHub IDs.",
    };
  }

  const alreadyApproved = request.status === "approved" || request.status === "withdrawn";
  return {
    kind,
    label: "Claim only",
    detail: alreadyApproved
      ? "This submission did not carry repository proof. Approval relied on another allowed basis, such as verified ownership, organization membership, or an audited staff override."
      : "This submission does not carry repository proof. Approval needs verified ownership, organization membership, an audited staff override, or a replacement submitted through a repo-proven path.",
  };
}

function nextStepFor(
  status: PublishRequestStatus,
  proofKind: PublishProofKind,
  audience: PublishRequestAudience,
) {
  if (audience === "staff") return staffNextStep(status, proofKind);
  switch (status) {
    case "pending_validation":
      return "Validation has not completed. Open the Account page and choose Validate to run or retry it.";
    case "validation_failed":
      return "Fix the reported validation error and submit the corrected commit. Retry validation only when the failure was transient.";
    case "pending_review":
      return proofKind === "repo_proven"
        ? "Validation passed and the request is waiting for registry staff review; repository proof is already attached."
        : "Validation passed and the request is waiting for registry staff review. Staff will confirm verified ownership or organization membership; otherwise resubmit through a repo-proven path or coordinate an audited override.";
    case "approved":
      return "The release is approved and served from the registry catalog.";
    case "rejected":
      return "Read the review reason, fix the release, and submit a corrected request.";
    case "withdrawn":
      return "This release is no longer served. Reinstatement requires a fresh request with the same release provenance.";
  }
}

function staffNextStep(status: PublishRequestStatus, proofKind: PublishProofKind) {
  switch (status) {
    case "pending_validation":
      return "Run validation before reviewing ownership or the release.";
    case "validation_failed":
      return "Ask the publisher to fix the reported error; retry validation only for a transient failure.";
    case "pending_review":
      return proofKind === "repo_proven"
        ? "Review the namespace and release; the source-repository ownership gate is satisfied."
        : "Confirm verified ownership or organization membership, or record an audited override before approving this claim-only request.";
    case "approved":
      return "The release is approved and served; use Withdraw for a takedown.";
    case "rejected":
      return "The request is terminal. The publisher must submit a corrected request.";
    case "withdrawn":
      return "The release is no longer served. Review any fresh reinstatement request against its retained provenance.";
  }
}
