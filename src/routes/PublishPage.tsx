import {
  ExternalLink,
  FileCode2,
  GitPullRequest,
  PackagePlus,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { REGISTRY_SOURCE_URL } from "../lib/links";

const installGcCommand = `brew install gastownhall/gascity/gascity
gc version`;

const directPublishCommand = `cd path/to/your-pack
git status --short
git push

gc registry publish .`;

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

export function PublishPage({ navigateTo }: { navigateTo: (path: string) => void }) {
  return (
    <main className="docsPage">
      <section className="docsHero">
        <p className="eyebrow">Publishing</p>
        <h1>Publish A Pack</h1>
        <p>
          Direct publishing is moving to clean Git checkouts. `gc registry publish` will send an
          immutable GitHub repo, commit, and pack path to Gas City Registry; the registry then
          derives the catalog entry and synthetic aggregate from upstream contents.
        </p>
        <div className="docsActions">
          <a className="iconTextButton primary" href={REGISTRY_SOURCE_URL} rel="noreferrer">
            <GitPullRequest size={16} aria-hidden="true" />
            Open registry source
            <ExternalLink size={15} aria-hidden="true" />
          </a>
          <a
            className="smallMutedButton"
            href="/verify"
            onClick={(event) => {
              event.preventDefault();
              navigateTo("/verify");
            }}
          >
            Verification flow
          </a>
        </div>
      </section>

      <section className="docsSection">
        <div className="sectionTitle">
          <p className="eyebrow">Model</p>
          <h2>Author-Owned Source, Aggregated By Registry</h2>
        </div>
        <div className="docsCallout">
          <PackagePlus size={22} aria-hidden="true" />
          <p>
            The source repository stays canonical. The registry stores publish requests keyed to a
            full commit SHA, then server-side validation can fetch the upstream pack and regenerate
            `/registry.toml`, `/catalog.json`, and Open Graph preview assets from approved releases.
          </p>
        </div>
      </section>

      <section className="docsSection">
        <div className="sectionTitle">
          <p className="eyebrow">Steps</p>
          <h2>Submit A New Pack</h2>
        </div>
        <ol className="stepList">
          <li>
            <strong>Put the pack in a GitHub repository.</strong>
            <span>Commit and push the pack content before publishing.</span>
          </li>
          <li>
            <strong>Run `gc registry publish` from the pack root when available.</strong>
            <span>
              The CLI verifies the checkout is clean, confirms `HEAD` is pushed, and submits the
              repo, commit, pack path, name, and version to the registry.
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
          <p className="eyebrow">Install gc</p>
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
          <p className="eyebrow">Direct publish target</p>
          <h2>Submit The Request</h2>
          <p className="mutedText">
            This is the target CLI shape for the low-friction path. Run it from the pack root after
            the commit is pushed to GitHub.
          </p>
        </div>
        <pre className="docsCode">
          <code>{directPublishCommand}</code>
        </pre>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <p className="eyebrow">Validation</p>
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
          <p className="eyebrow">Canonical registry.toml</p>
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
          <p className="eyebrow">Manual fallback</p>
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
          <p className="eyebrow">After merge</p>
          <h2>Where It Appears</h2>
        </div>
        <ul className="checkList">
          <li>
            <TerminalSquare size={16} aria-hidden="true" />
            Direct submission: `gc registry publish .`
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
    </main>
  );
}
