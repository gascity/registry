import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { normalizePublishRequestInput } from "./publish";
import type { NormalizedPublishRequestInput, PublishRequestInput } from "./types";
import { RequestError } from "./http";

export const GITHUB_ACTIONS_OIDC_AUDIENCE = "gascity-registry";
const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const githubActionsJwks = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks"),
);

export type GitHubActionsIdentity = {
  repository: string;
  repositoryId?: string;
  repositoryOwner?: string;
  repositoryOwnerId?: string;
  workflowRef?: string;
  jobWorkflowRef?: string;
  runId?: string;
  runAttempt?: string;
  sha: string;
  ref?: string;
  actor?: string;
  actorId?: string;
  eventName?: string;
};

export async function verifyGitHubActionsOidcToken(token: string): Promise<GitHubActionsIdentity> {
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > 20_000) {
    throw new RequestError(422, "VALIDATION_ERROR", "GitHub Actions OIDC token is required.");
  }
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(trimmed, githubActionsJwks, {
      issuer: GITHUB_ACTIONS_ISSUER,
      audience: GITHUB_ACTIONS_OIDC_AUDIENCE,
      clockTolerance: 60,
    });
    payload = verified.payload;
  } catch {
    throw new RequestError(401, "GITHUB_ACTIONS_OIDC_INVALID", "GitHub Actions OIDC token is invalid.");
  }

  const repository = requiredStringClaim(payload, "repository");
  const sha = requiredStringClaim(payload, "sha");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new RequestError(401, "GITHUB_ACTIONS_OIDC_INVALID", "GitHub Actions repository claim is invalid.");
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new RequestError(401, "GITHUB_ACTIONS_OIDC_INVALID", "GitHub Actions sha claim is invalid.");
  }

  const runnerEnvironment = optionalStringClaim(payload, "runner_environment");
  if (runnerEnvironment && runnerEnvironment !== "github-hosted") {
    throw new RequestError(
      403,
      "GITHUB_ACTIONS_RUNNER_DENIED",
      "Only GitHub-hosted Actions runners can mint registry publish tokens.",
    );
  }
  const eventName = optionalStringClaim(payload, "event_name");
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    throw new RequestError(
      403,
      "GITHUB_ACTIONS_EVENT_DENIED",
      "Pull request workflows cannot mint registry publish tokens.",
    );
  }

  return {
    repository,
    repositoryId: optionalStringClaim(payload, "repository_id"),
    repositoryOwner: optionalStringClaim(payload, "repository_owner"),
    repositoryOwnerId: optionalStringClaim(payload, "repository_owner_id"),
    workflowRef: optionalStringClaim(payload, "workflow_ref"),
    jobWorkflowRef: optionalStringClaim(payload, "job_workflow_ref"),
    runId: optionalStringClaim(payload, "run_id"),
    runAttempt: optionalStringClaim(payload, "run_attempt"),
    sha,
    ref: optionalStringClaim(payload, "ref"),
    actor: optionalStringClaim(payload, "actor"),
    actorId: optionalStringClaim(payload, "actor_id"),
    eventName,
  };
}

export function assertGitHubActionsCanMintPublishToken(
  identity: GitHubActionsIdentity,
  input: PublishRequestInput,
): NormalizedPublishRequestInput {
  const normalized = normalizePublishRequestInput(input);
  if (identity.repository.toLowerCase() !== normalized.repository.fullName.toLowerCase()) {
    throw new RequestError(
      403,
      "GITHUB_ACTIONS_REPOSITORY_MISMATCH",
      "GitHub Actions token repository does not match the publish request repository.",
    );
  }
  if (identity.sha !== normalized.commit) {
    throw new RequestError(
      403,
      "GITHUB_ACTIONS_COMMIT_MISMATCH",
      "GitHub Actions token commit does not match the publish request commit.",
    );
  }
  const localWorkflowPrefix = `${identity.repository}/.github/workflows/`;
  if (
    (identity.workflowRef && !identity.workflowRef.startsWith(localWorkflowPrefix)) ||
    (identity.jobWorkflowRef && !identity.jobWorkflowRef.startsWith(localWorkflowPrefix))
  ) {
    throw new RequestError(
      403,
      "GITHUB_ACTIONS_WORKFLOW_DENIED",
      "GitHub Actions caller and reusable workflows must run from the publishing repository.",
    );
  }
  return normalized;
}

function requiredStringClaim(payload: JWTPayload, name: string) {
  const value = payload[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new RequestError(401, "GITHUB_ACTIONS_OIDC_INVALID", `GitHub Actions ${name} claim is missing.`);
  }
  return value.trim();
}

function optionalStringClaim(payload: JWTPayload, name: string) {
  const value = payload[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
