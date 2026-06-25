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
import { AppPage, Button, Card, CardHeader, Eyebrow, Input, Text } from "@gascity/ui";
import {
  apiRequest,
  type AuthState,
  type GitHubPublishCandidate,
  type GitHubPublishImportRow,
  type PublishRequestRow,
} from "../lib/api";
import { GITHUB_APP_INSTALL_URL, REGISTRY_SOURCE_URL } from "../lib/links";

const installGcCommand = `brew install gastownhall/gascity/gascity
gc version`;

const directPublishCommand = `cd path/to/your-pack
git status --short
git push

gc pack registry login
gc pack registry publish .`;

const githubActionsCommand = `permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v4
  - run: gc pack registry publish path/to/your-pack`;

const validateRegistryCommand = `gc pack release validate registry.toml --pack my-pack`;

const registryTomlExample = `schema = 1

[[pack]]
name = "my-pack"
description = "Short description shown in search results."
source = "https://github.com/example/gascity-packs/tree/main/my-pack"
source_kind = "git"

[[pack.release]]
version = "0.1.0"
ref = "main"
commit = "0123456789abcdef0123456789abcdef01234567"
hash = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
description = "Initial release."`;

const sourcesTomlExample = `[[source]]
name = "example-packs"
url = "https://raw.githubusercontent.com/example/gascity-packs/main/registry.toml"`;

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
      setSubmitError(err instanceof Error ? err.message : "Unable to submit publish request.");
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
      setGitHubError(err instanceof Error ? err.message : "Unable to submit GitHub candidate.");
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
      title="Publish A Pack"
      subtitle="Direct publishing uses clean Git checkouts. The CLI sends an immutable GitHub repo, commit, and pack path to Gas City Registry; the registry then derives the catalog entry and synthetic aggregate from upstream contents."
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
          <Eyebrow>Submit</Eyebrow>
          <h2>Publish From GitHub</h2>
        </div>
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
                  <Eyebrow>Fast path</Eyebrow>
                  <h3>Find Packs From GitHub</h3>
                  <Text tone="muted">
                    Scan public repositories where the Registry GitHub App is installed and your
                    GitHub account can publish changes.
                  </Text>
                </div>
                <div className="githubImportActions">
                  <Button
                    accent
                    type="button"
                    onClick={() => void startGitHubImport()}
                    loading={isStartingGitHubImport}
                    iconStart={<GitBranch size={15} />}
                  >
                    {isStartingGitHubImport ? "Opening GitHub" : "Find packs"}
                  </Button>
                  <a className="smallMutedButton" href={GITHUB_APP_INSTALL_URL} rel="noreferrer">
                    Install app
                    <ExternalLink size={14} aria-hidden="true" />
                  </a>
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
                {publishRequest.statusReason ? <p>{publishRequest.statusReason}</p> : null}
              </div>
            ) : null}
            {submitError ? <p className="formError" role="alert">{submitError}</p> : null}
          </div>
        )}
      </section>

      <section className="docsSection">
        <div className="sectionTitle">
          <Eyebrow>Model</Eyebrow>
          <h2>Author-Owned Source, Aggregated By Registry</h2>
        </div>
        <Card variant="surface" className="docsCallout">
          <PackagePlus size={22} aria-hidden="true" />
          <p>
            The source repository stays canonical. The registry stores publish requests keyed to a
            full commit SHA, then server-side validation can fetch the upstream pack and regenerate
            `/registry.toml`, `/catalog.json`, and Open Graph preview assets from approved releases.
          </p>
        </Card>
      </section>

      <section className="docsSection">
        <div className="sectionTitle">
          <Eyebrow>Steps</Eyebrow>
          <h2>Submit A New Pack</h2>
        </div>
        <ol className="stepList">
          <li>
            <strong>Put the pack in a GitHub repository.</strong>
            <span>Commit and push the pack content before publishing.</span>
          </li>
          <li>
            <strong>Log in with the CLI.</strong>
            <span>
              <code>gc pack registry login</code> uses the registry sign-in provider and stores a local
              revocable token.
            </span>
          </li>
          <li>
            <strong>Run the publish command from the pack root.</strong>
            <span>
              The CLI reads the stored login token, verifies the checkout is clean, confirms{" "}
              <code>HEAD</code> is pushed, and submits the repo, commit, pack path, name, and
              version to the registry.
            </span>
          </li>
          <li>
            <strong>Let the registry derive release metadata.</strong>
            <span>The server validates the exact commit and manufactures the registry entry.</span>
          </li>
          <li>
            <strong>Review the request status.</strong>
            <span>Your account page shows whether the release is validating, queued, approved, or rejected.</span>
          </li>
          <li>
            <strong>Let CI regenerate the aggregate.</strong>
            <span>Approved releases are folded into the synthetic aggregate consumed by the CLI.</span>
          </li>
          <li>
            <strong>Verify ownership after merge.</strong>
            <span>Use the pack Trust tab to connect the published source to your Gas City account.</span>
          </li>
        </ol>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <Eyebrow>Install gc</Eyebrow>
          <h2>Use The Canonical Tool</h2>
          <p className="mutedText">
            `gc` owns the release hash format. Install it first, then use the `pack release`
            commands below instead of hand-editing release metadata.
          </p>
        </div>
        <pre className="docsCode">
          <code>{installGcCommand}</code>
        </pre>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <Eyebrow>Direct publish target</Eyebrow>
          <h2>Submit The Request</h2>
          <p className="mutedText">
            Run this from the pack root after signing in and pushing the commit to GitHub.
          </p>
        </div>
        <pre className="docsCode">
          <code>{directPublishCommand}</code>
        </pre>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <Eyebrow>Automated releases</Eyebrow>
          <h2>Use GitHub Actions OIDC</h2>
          <p className="mutedText">
            CI can publish without a stored secret. The workflow grants `id-token: write`; the CLI
            exchanges GitHub's repository identity for a short-lived registry publish token.
          </p>
        </div>
        <pre className="docsCode">
          <code>{githubActionsCommand}</code>
        </pre>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <Eyebrow>Validation</Eyebrow>
          <h2>Check The Registry File</h2>
          <p className="mutedText">
            Manual registry files remain useful as a fallback and for debugging aggregate output.
            Validation re-fetches the recorded source and verifies active release hashes.
          </p>
        </div>
        <pre className="docsCode">
          <code>{validateRegistryCommand}</code>
        </pre>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <Eyebrow>Canonical registry.toml</Eyebrow>
          <h2>File Shape</h2>
          <p className="mutedText">
            The aggregator currently accepts `source_kind = "git"`, version strings shaped as
            `major.minor[.patch]`, full lowercase commit SHAs, and `sha256:` release hashes.
          </p>
        </div>
        <pre className="docsCode">
          <code>{registryTomlExample}</code>
        </pre>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <Eyebrow>Manual fallback</Eyebrow>
          <h2>sources.toml Entry</h2>
          <p className="mutedText">
            During the transition, authors can still submit a source pointer. The preferred path is
            direct publishing from a pushed GitHub commit.
          </p>
        </div>
        <pre className="docsCode">
          <code>{sourcesTomlExample}</code>
        </pre>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <Eyebrow>After merge</Eyebrow>
          <h2>Where It Appears</h2>
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
            Trust tab ownership verification once the source is visible.
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
  }
}
