import {
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitPullRequest,
  Loader2,
  PackagePlus,
  SearchCode,
  Send,
  ShieldCheck,
  TerminalSquare,
  UserRound,
} from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { AppPage, Button, Card, Eyebrow, Input, Text } from "@gascity/ui";
import {
  ApiError,
  apiRequest,
  type AuthState,
  type GitHubPublishCandidate,
  type GitHubPublishImportRow,
  type PublishRequestRow,
} from "../lib/api";
import { GITHUB_APP_INSTALL_URL, REGISTRY_SOURCE_URL } from "../lib/links";
import { PublishRequestGuidance } from "../components/PublishRequestGuidance";

const installGcCommand = `brew install gastownhall/gascity/gascity
gc version`;

const directPublishCommand = `cd path/to/your-pack
git status --short
git push

gc pack registry login
gc pack registry publish .`;

const githubActionsCommand = `name: Publish pack

on:
  push:
    tags:
      - "v*"

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - name: Check out the tagged commit
        uses: actions/checkout@v4
      - name: Install gc
        shell: bash
        run: |
          eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
          brew install gastownhall/gascity/gascity
          echo "$HOMEBREW_PREFIX/bin" >> "$GITHUB_PATH"
      - name: Publish
        shell: bash
        run: |
          VERSION="\${GITHUB_REF_NAME#v}"
          gc pack registry publish path/to/your-pack \\
            --version "$VERSION" \\
            --ref "$GITHUB_REF"`;

const publishErrors = [
  {
    code: "PACK_NAME_MISMATCH",
    meaning: "The name requested from the registry differs from [pack].name in pack.toml.",
    action: "Make the two names identical, commit and push, then submit the new commit.",
  },
  {
    code: "UPSTREAM_FETCH_FAILED",
    meaning: "The registry could not fetch pack.toml at the submitted GitHub commit and pack path.",
    action: "Check that the repo is public and that the full commit and pack path exist.",
  },
  {
    code: "PACK_HASH_FAILED",
    meaning: "gc could not clone or hash the submitted repository contents.",
    action: "Check the repo, commit and path; retry only if the upstream failure was transient.",
  },
  {
    code: "OWNERSHIP_NOT_VERIFIED",
    meaning: "A claim-only request reached approval without source-repository proof.",
    action: "Resubmit through GitHub import or Actions, use an existing verified ownership record, or ask staff for an audited override.",
  },
  {
    code: "PUBLISH_TOKEN_SCOPE_DENIED",
    meaning: "The short-lived token is for a different repo, commit, pack, name or version.",
    action: "Mint a fresh token by rerunning gc in the matching workflow; never reuse one for another release.",
  },
  {
    code: "GITHUB_ACTIONS_OIDC_INVALID",
    meaning: "GitHub did not issue a usable OIDC token for the registry audience.",
    action: "Grant id-token: write and let gc mint credentials; do not inject a personal registry token.",
  },
  {
    code: "GITHUB_ACTIONS_RUNNER_DENIED",
    meaning: "The workflow is running somewhere other than a GitHub-hosted runner.",
    action: "Use runs-on: ubuntu-latest for the publish job.",
  },
  {
    code: "GITHUB_ACTIONS_EVENT_DENIED",
    meaning: "Pull-request workflows cannot mint publish tokens.",
    action: "Publish from a push or tag workflow after the change is merged.",
  },
  {
    code: "GITHUB_ACTIONS_REPOSITORY_MISMATCH",
    meaning: "The requested source repository differs from the repository in GitHub's token.",
    action: "Run the workflow in the repository named by the publish request.",
  },
  {
    code: "GITHUB_ACTIONS_COMMIT_MISMATCH",
    meaning: "The requested commit differs from the SHA in GitHub's token.",
    action: "Check out and publish the current workflow commit.",
  },
  {
    code: "GITHUB_ACTIONS_WORKFLOW_DENIED",
    meaning: "The workflow file is not owned by the publishing repository.",
    action: "Keep the publish job in that repo's .github/workflows directory; org-level reusable workflows are not accepted.",
  },
] as const;

type CandidateDraft = {
  requestedName: string;
  requestedVersion: string;
  requestedRef: string;
  requestedDescription: string;
};

export function PublishPage({
  navigateTo,
  auth,
  signIn,
  devSignIn,
}: {
  navigateTo: (path: string) => void;
  auth: AuthState;
  signIn: () => void;
  devSignIn: () => void;
}) {
  const [repoUrl, setRepoUrl] = useState("");
  const [packPath, setPackPath] = useState(".");
  const [commit, setCommit] = useState("");
  const [requestedName, setRequestedName] = useState("");
  const [requestedVersion, setRequestedVersion] = useState("");
  const [requestedRef, setRequestedRef] = useState("");
  const [requestedDescription, setRequestedDescription] = useState("");
  const [publishRequest, setPublishRequest] = useState<PublishRequestRow | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [githubImport, setGitHubImport] = useState<GitHubPublishImportRow | null>(null);
  const [candidateDrafts, setCandidateDrafts] = useState<Record<string, CandidateDraft>>({});
  const [isStartingGitHubImport, setIsStartingGitHubImport] = useState(false);
  const [isLoadingGitHubImport, setIsLoadingGitHubImport] = useState(false);
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(null);
  const [githubError, setGitHubError] = useState<string | null>(null);
  const githubImportId = new URLSearchParams(window.location.search).get("githubImport");

  useEffect(() => {
    if (!auth.csrfToken || !githubImportId) return;
    let active = true;
    setIsLoadingGitHubImport(true);
    setGitHubError(null);
    void apiRequest<{ import: GitHubPublishImportRow }>(
      `/api/publish/github/imports/${encodeURIComponent(githubImportId)}`,
      {},
      auth.csrfToken,
    )
      .then((result) => {
        if (!active) return;
        setGitHubImport(result.import);
        setCandidateDrafts(
          Object.fromEntries(
            result.import.candidates.map((candidate) => [candidate.id, initialCandidateDraft(candidate)]),
          ),
        );
      })
      .catch((err) => {
        if (active) setGitHubError(err instanceof Error ? err.message : "Unable to load GitHub import.");
      })
      .finally(() => {
        if (active) setIsLoadingGitHubImport(false);
      });
    return () => {
      active = false;
    };
  }, [auth.csrfToken, githubImportId]);

  const submitPublishRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!auth.csrfToken) {
      setSubmitError("Sign in again to submit a publish request.");
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    setPublishRequest(null);
    try {
      const result = await apiRequest<{ publishRequest: PublishRequestRow } | PublishRequestRow>(
        "/api/publish-requests?validate=1",
        {
          method: "POST",
          body: JSON.stringify({
            repoUrl,
            commit,
            packPath,
            requestedName,
            requestedVersion,
            requestedRef: requestedRef || undefined,
            requestedDescription: requestedDescription || undefined,
          }),
        },
        auth.csrfToken,
      );
      setPublishRequest("publishRequest" in result ? result.publishRequest : result);
    } catch (err) {
      if (err instanceof ApiError && err.publishRequest) {
        setPublishRequest(err.publishRequest);
      } else {
        setSubmitError(err instanceof Error ? err.message : "Unable to submit publish request.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const startGitHubImport = async () => {
    if (!auth.csrfToken) {
      setGitHubError("Sign in again to find packs from GitHub.");
      return;
    }
    setIsStartingGitHubImport(true);
    setGitHubError(null);
    try {
      const result = await apiRequest<{ authorizationUrl: string }>(
        "/api/publish/github/start",
        { method: "POST" },
        auth.csrfToken,
      );
      window.location.href = result.authorizationUrl;
    } catch (err) {
      setGitHubError(err instanceof Error ? err.message : "Unable to start GitHub import.");
      setIsStartingGitHubImport(false);
    }
  };

  const submitGitHubCandidate = async (candidate: GitHubPublishCandidate) => {
    if (!auth.csrfToken) {
      setGitHubError("Sign in again to submit this GitHub pack.");
      return;
    }
    if (!githubImport) {
      setGitHubError("GitHub import results expired. Start the GitHub scan again.");
      return;
    }
    const draft = candidateDrafts[candidate.id] ?? initialCandidateDraft(candidate);
    setActiveCandidateId(candidate.id);
    setGitHubError(null);
    setPublishRequest(null);
    try {
      const result = await apiRequest<{ publishRequest: PublishRequestRow }>(
        `/api/publish/github/imports/${encodeURIComponent(githubImport.id)}/submit`,
        {
          method: "POST",
          body: JSON.stringify({
            candidateId: candidate.id,
            requestedName: draft.requestedName,
            requestedVersion: draft.requestedVersion,
            requestedRef: draft.requestedRef,
            requestedDescription: draft.requestedDescription || undefined,
          }),
        },
        auth.csrfToken,
      );
      setPublishRequest(result.publishRequest);
    } catch (err) {
      if (err instanceof ApiError && err.publishRequest) {
        setPublishRequest(err.publishRequest);
      } else {
        setGitHubError(err instanceof Error ? err.message : "Unable to submit GitHub candidate.");
      }
    } finally {
      setActiveCandidateId(null);
    }
  };

  const updateCandidateDraft = (
    candidate: GitHubPublishCandidate,
    field: keyof CandidateDraft,
    value: string,
  ) => {
    setCandidateDrafts((current) => ({
      ...current,
      [candidate.id]: {
        ...(current[candidate.id] ?? initialCandidateDraft(candidate)),
        [field]: value,
      },
    }));
  };

  return (
    <AppPage
      className="docsPage"
      eyebrow="Registry · Publish"
      title="Publish a Pack"
      subtitle="Start by installing the Registry GitHub App, then use Find packs. It proves the source repository without a personal token and gives reviewers the strongest ownership evidence."
      actions={
        <>
          <Button
            accent
            iconStart={<GitPullRequest size={16} aria-hidden="true" />}
            onClick={() => {
              window.location.href = REGISTRY_SOURCE_URL;
            }}
          >
            Open registry source
            <ExternalLink size={15} aria-hidden="true" />
          </Button>
          <Button variant="secondary" onClick={() => navigateTo("/verify")}>
            Verification flow
          </Button>
        </>
      }
    >
      <section className="docsSection">
        <div className="sectionTitle">
          <Eyebrow>Recommended path</Eyebrow>
          <h2>Install the GitHub App, then Find packs</h2>
        </div>
        <Card variant="surface" className="docsCallout">
          <GitBranch size={22} aria-hidden="true" />
          <p>
            <a href={GITHUB_APP_INSTALL_URL} rel="noreferrer">
              Install the Registry GitHub App
            </a>{" "}
            on the public repository that owns your pack. Return here, sign in, and choose{" "}
            <strong>Find packs</strong>. Registry scans that repository’s default-branch{" "}
            <code>HEAD</code>, reads <code>pack.toml</code>, and records GitHub’s repository proof
            with the request.
          </p>
        </Card>
        {!auth.user ? (
          <Card variant="surface" className="signInPromptInline">
            <UserRound size={20} />
            <strong>Sign in to submit a pack.</strong>
            <Text tone="muted">Publish requests are tied to your Gas City account.</Text>
            <div className="promptActions">
              {auth.devAuthEnabled ? (
                <Button variant="secondary" onClick={devSignIn}>
                  Dev sign in
                </Button>
              ) : null}
              <Button accent onClick={signIn}>
                Sign in
              </Button>
            </div>
          </Card>
        ) : (
          <div className="publishFormPanel">
            <Card variant="surface" className="githubImportPanel">
              <div className="githubImportIntro">
                <div>
                  <Eyebrow>GitHub App</Eyebrow>
                  <h3>Find Packs From GitHub</h3>
                  <Text tone="muted">
                    Scan public repositories where the App is installed and your GitHub account has
                    push, maintain, or admin permission. The scan uses default-branch HEAD only.
                  </Text>
                </div>
                <div className="githubImportActions">
                  <a className="smallMutedButton" href={GITHUB_APP_INSTALL_URL} rel="noreferrer">
                    Install app
                    <ExternalLink size={14} aria-hidden="true" />
                  </a>
                  <Button
                    accent
                    type="button"
                    onClick={() => void startGitHubImport()}
                    loading={isStartingGitHubImport}
                    iconStart={<GitBranch size={15} />}
                  >
                    {isStartingGitHubImport ? "Opening GitHub" : "Find packs"}
                  </Button>
                </div>
              </div>

              {isLoadingGitHubImport ? (
                <div className="githubImportState" role="status" aria-busy="true">
                  <Loader2 className="spinIcon" size={18} aria-hidden="true" />
                  <span>Loading GitHub results.</span>
                </div>
              ) : null}

              {githubImport ? (
                <div className="githubImportResults">
                  <div className="githubImportSummary">
                    <span>
                      <SearchCode size={14} aria-hidden="true" />
                      {githubImport.repositoriesScanned} repos scanned
                    </span>
                    <span>{githubImport.candidates.length} candidates</span>
                    {githubImport.privateRepositoriesSkipped > 0 ? (
                      <span>{githubImport.privateRepositoriesSkipped} private skipped</span>
                    ) : null}
                    {githubImport.truncated ? <span>Result limit reached</span> : null}
                  </div>

                  {githubImport.candidates.length > 0 ? (
                    <div className="githubCandidateList">
                      {githubImport.candidates.map((candidate) => {
                        const draft = candidateDrafts[candidate.id] ?? initialCandidateDraft(candidate);
                        const isSubmittingCandidate = activeCandidateId === candidate.id;
                        return (
                          <form
                            className="githubCandidate"
                            key={candidate.id}
                            onSubmit={(event) => {
                              event.preventDefault();
                              void submitGitHubCandidate(candidate);
                            }}
                          >
                            <div className="githubCandidateHeader">
                              <div>
                                <strong>{candidate.pack.name}</strong>
                                <span>
                                  {candidate.repository.fullName} / {candidate.packPath}
                                </span>
                              </div>
                              <span className="requestStatus pending_review">{candidate.repository.permission}</span>
                            </div>
                            <div className="githubCandidateMeta">
                              <span>{candidate.branch}</span>
                              <span>{candidate.commit.slice(0, 12)}</span>
                              <a href={candidateSourceUrl(candidate)} rel="noreferrer" target="_blank">
                                Source
                                <ExternalLink size={13} aria-hidden="true" />
                              </a>
                            </div>
                            <div className="formGridTwo">
                              <Input label="Pack name" value={draft.requestedName} readOnly required />
                              <Input
                                label="Version"
                                placeholder="0.1.0"
                                value={draft.requestedVersion}
                                onChange={(event) =>
                                  updateCandidateDraft(candidate, "requestedVersion", event.target.value)
                                }
                                required
                              />
                            </div>
                            <Input
                              label="Ref label"
                              value={draft.requestedRef}
                              onChange={(event) =>
                                updateCandidateDraft(candidate, "requestedRef", event.target.value)
                              }
                              required
                            />
                            <Input
                              label="Description"
                              placeholder="Short description shown in search results."
                              value={draft.requestedDescription}
                              onChange={(event) =>
                                updateCandidateDraft(candidate, "requestedDescription", event.target.value)
                              }
                            />
                            {candidate.warnings.length > 0 ? (
                              <p className="candidateWarning">{candidate.warnings.join(" ")}</p>
                            ) : null}
                            <Button
                              accent
                              type="submit"
                              loading={isSubmittingCandidate}
                              iconStart={<CheckCircle2 size={15} />}
                            >
                              {isSubmittingCandidate ? "Submitting" : "Submit this pack"}
                            </Button>
                          </form>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="emptyState">
                      <strong>No pack.toml files found.</strong>
                      <p>Install the GitHub App on the repo or use the manual form below.</p>
                    </div>
                  )}

                  {githubImport.scanErrors.length > 0 ? (
                    <details className="githubImportErrors">
                      <summary>Some repositories could not be scanned</summary>
                      <ul>
                        {githubImport.scanErrors.map((error) => (
                          <li key={error}>{error}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </div>
              ) : null}

              {githubError ? <p className="formError" role="alert">{githubError}</p> : null}
            </Card>

            <details className="manualPublishDetails">
              <summary>
                <span>
                  <strong>Manual publish request</strong>
                  <small>Use an exact GitHub repo, commit, and pack path.</small>
                </span>
                <ChevronDown size={16} aria-hidden="true" />
              </summary>

              <form onSubmit={(event) => void submitPublishRequest(event)}>
                <div className="formGridTwo">
                  <Input
                    label="GitHub repository"
                    placeholder="https://github.com/org/repo"
                    value={repoUrl}
                    onChange={(event) => setRepoUrl(event.target.value)}
                    required
                  />
                  <Input
                    label="Pack path"
                    placeholder="."
                    value={packPath}
                    onChange={(event) => setPackPath(event.target.value)}
                    required
                  />
                </div>
                <Input
                  label="Commit SHA"
                  placeholder="0123456789abcdef0123456789abcdef01234567"
                  value={commit}
                  onChange={(event) => setCommit(event.target.value)}
                  required
                />
                <div className="formGridTwo">
                  <Input
                    label="Pack name"
                    placeholder="my-pack"
                    value={requestedName}
                    onChange={(event) => setRequestedName(event.target.value)}
                    required
                  />
                  <Input
                    label="Version"
                    placeholder="0.1.0"
                    value={requestedVersion}
                    onChange={(event) => setRequestedVersion(event.target.value)}
                    required
                  />
                </div>
                <Input
                  label="Ref label"
                  placeholder="refs/tags/v0.1.0 or main"
                  value={requestedRef}
                  onChange={(event) => setRequestedRef(event.target.value)}
                />
                <Input
                  label="Description"
                  placeholder="Short description shown in search results."
                  value={requestedDescription}
                  onChange={(event) => setRequestedDescription(event.target.value)}
                />
                <Button accent type="submit" loading={isSubmitting} iconStart={<Send size={15} />}>
                  {isSubmitting ? "Submitting" : "Submit publish request"}
                </Button>
              </form>
            </details>
            {publishRequest ? (
              <div className="requestPreview" role="status">
                <strong>{statusLabel(publishRequest.status)}</strong>
                <p>
                  {publishRequest.requestedName} {publishRequest.requestedVersion} from{" "}
                  {publishRequest.repository.fullName}
                </p>
                <PublishRequestGuidance request={publishRequest} />
                {publishRequest.validationError ? (
                  <p className="formError">Validation: {publishRequest.validationError}</p>
                ) : null}
                {publishRequest.statusReason ? <p>{publishRequest.statusReason}</p> : null}
              </div>
            ) : null}
            {submitError ? <p className="formError" role="alert">{submitError}</p> : null}
          </div>
        )}
      </section>

      <section className="docsSection">
        <div className="sectionTitle">
          <Eyebrow>Proof model</Eyebrow>
          <h2>Know what your submission proves</h2>
        </div>
        <Card variant="surface" className="docsCallout">
          <PackagePlus size={22} aria-hidden="true" />
          <p>
            <strong>GitHub App import and GitHub Actions OIDC are repository-proven:</strong> GitHub
            authenticated the source repository at submission time.{" "}
            <strong>The manual form and personal or CLI tokens are claim-only:</strong> they assert a
            public repo URL but do not prove control of it. A claim-only request needs an existing
            verified ownership record or an audited staff override before approval.
          </p>
        </Card>
        <Text className="mutedText" tone="muted">
          Production currently keeps staff review in the loop. Repository proof clears the ownership
          gate; it does not promise that this or any repeat release will be approved automatically.
          Follow the status shown on the request.
        </Text>
      </section>

      <section className="docsSection">
        <div className="sectionTitle">
          <Eyebrow>Request lifecycle</Eyebrow>
          <h2>From source commit to catalog</h2>
        </div>
        <ol className="stepList">
          <li>
            <strong>Prepare the public source.</strong>
            <span>
              Commit and push <code>pack.toml</code> with a scoped name such as{" "}
              <code>owner/my-pack</code>. The scope must match the GitHub owner.
            </span>
          </li>
          <li>
            <strong>Attach repository proof.</strong>
            <span>
              Use the GitHub App for default-branch <code>HEAD</code>, or the OIDC workflow below for
              a tagged commit. Use the manual or token path only when staff can verify ownership
              separately.
            </span>
          </li>
          <li>
            <strong>Read the validation outcome.</strong>
            <span>
              The registry fetches <code>pack.toml</code> at the exact commit and computes the release
              hash. A failure creates a visible <code>validation_failed</code> request and returns a
              non-2xx response with a machine-readable error code.
            </span>
          </li>
          <li>
            <strong>Wait for registry staff review.</strong>
            <span>
              Repository-proven requests already satisfy the ownership gate. A new claim-only pack
              cannot fix ownership after merge; resubmit through a repo-proven path or coordinate an
              audited override before approval.
            </span>
          </li>
          <li>
            <strong>Confirm the approved status.</strong>
            <span>
              Only an <code>approved</code> request is served in the website catalog and CLI
              aggregate. HTTP creation success alone is never an approval signal.
            </span>
          </li>
        </ol>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <Eyebrow>Tagged releases</Eyebrow>
          <h2>Publish with GitHub Actions OIDC</h2>
          <p className="mutedText">
            Save this as <code>.github/workflows/publish-pack.yml</code>, replace the pack path, then
            push a tag such as <code>v1.2.3</code>. No registry secret is stored: <code>gc</code>{" "}
            exchanges GitHub’s OIDC identity for a short-lived token scoped to this exact release.
          </p>
          <ul className="checkList">
            <li>Keep the publish job in the publishing repository.</li>
            <li>Use a GitHub-hosted runner; self-hosted runners are refused.</li>
            <li>Run after merge from a tag or push, never from a pull request event.</li>
            <li>Do not move this job into an organization-level reusable workflow.</li>
          </ul>
        </div>
        <pre className="docsCode">
          <code>{githubActionsCommand}</code>
        </pre>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <Eyebrow>Tags and versions</Eyebrow>
          <h2>The version is not the tag</h2>
        </div>
        <ul className="checkList">
          <li>
            A tag may be <code>v1.2.3</code>; the workflow strips the leading <code>v</code> and
            submits version <code>1.2.3</code>. The recorded ref remains{" "}
            <code>refs/tags/v1.2.3</code>.
          </li>
          <li>
            Registry currently accepts canonical stable versions only: exactly{" "}
            <code>major.minor.patch</code> with no leading zeros.
          </li>
          <li>
            Prerelease or build suffixes such as <code>1.2.3-rc.1</code> and{" "}
            <code>1.2.3+build.4</code>, shortened versions such as <code>1.2</code>, and versions
            containing a leading <code>v</code> are rejected.
          </li>
          <li>
            <strong>Find packs</strong> can publish only the current default-branch{" "}
            <code>HEAD</code>. Editing its ref label does not select another commit; use Actions or
            the CLI for a tagged or older commit.
          </li>
        </ul>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <Eyebrow>Manual fallback</Eyebrow>
          <h2>Install gc and submit from a clean checkout</h2>
          <p className="mutedText">
            The CLI verifies that <code>HEAD</code> is pushed and sends the immutable repo, commit,
            pack path, name and version. A personal login token makes this a claim-only request, so
            prefer GitHub import or Actions for a new pack.
          </p>
          <pre className="docsCode">
            <code>{installGcCommand}</code>
          </pre>
        </div>
        <pre className="docsCode">
          <code>{directPublishCommand}</code>
        </pre>
      </section>

      <section className="docsSection">
        <div className="sectionTitle">
          <Eyebrow>Rename safety</Eyebrow>
          <h2>Teach the claim stable GitHub IDs before a rename</h2>
        </div>
        <Card variant="surface" className="docsCallout">
          <ShieldCheck size={22} aria-hidden="true" />
          <p>
            Before an owner or repository rename such as <code>cacc-twin-team</code>, get one
            repository-proven release approved through GitHub App import or Actions OIDC. That
            release permanently enriches the pack-name claim with GitHub’s stable repository and
            owner IDs, so later releases still match after the visible login or repo name changes.
            Manual-form and personal-token releases cannot teach those IDs.
          </p>
        </Card>
      </section>

      <section className="docsSection">
        <div className="sectionTitle">
          <Eyebrow>Troubleshooting</Eyebrow>
          <h2>Publisher error codes</h2>
        </div>
        <Text className="mutedText" tone="muted">
          Synchronous validation failures return a non-2xx HTTP status and an{" "}
          <code>error.code</code>. The response also contains the durable{" "}
          <code>publishRequest</code> in <code>validation_failed</code> state, so you can find it on
          the Account page. Scripts should require a 2xx response and then inspect the request status;
          only <code>approved</code> means the release is live.
        </Text>
        <div className="docsTableScroll">
          <table className="docsTable">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">What it means</th>
                <th scope="col">What to do</th>
              </tr>
            </thead>
            <tbody>
              {publishErrors.map((error) => (
                <tr key={error.code}>
                  <th scope="row">
                    <code>{error.code}</code>
                  </th>
                  <td data-label="What it means">{error.meaning}</td>
                  <td data-label="What to do">{error.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <Eyebrow>After approval</Eyebrow>
          <h2>Where it appears</h2>
        </div>
        <ul className="checkList">
          <li>
            <TerminalSquare size={16} aria-hidden="true" />
            Direct submission: `gc pack registry publish .`
          </li>
          <li>
            <FileCode2 size={16} aria-hidden="true" />
            CLI-compatible aggregate: `https://registry.gascity.com/registry.toml`
          </li>
          <li>
            <FileCode2 size={16} aria-hidden="true" />
            Website catalog and search: `https://registry.gascity.com/catalog.json`
          </li>
          <li>
            <ShieldCheck size={16} aria-hidden="true" />
            Account and staff request history with submission method, proof basis, and next step.
          </li>
        </ul>
      </section>
    </AppPage>
  );
}

function initialCandidateDraft(candidate: GitHubPublishCandidate): CandidateDraft {
  return {
    requestedName: candidate.pack.name,
    requestedVersion: candidate.pack.version ?? "",
    requestedRef: candidate.branch,
    requestedDescription: candidate.pack.description ?? "",
  };
}

function candidateSourceUrl(candidate: GitHubPublishCandidate) {
  const base = `${candidate.repository.htmlUrl}/tree/${candidate.commit}`;
  if (candidate.packPath === ".") return base;
  return `${base}/${candidate.packPath.split("/").map(encodeURIComponent).join("/")}`;
}

function statusLabel(status: PublishRequestRow["status"]) {
  switch (status) {
    case "pending_validation":
      return "Pending validation";
    case "validation_failed":
      return "Validation failed";
    case "pending_review":
      return "Pending review";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "withdrawn":
      return "Withdrawn";
  }
}
