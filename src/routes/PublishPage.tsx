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

const stampReleaseCommand = `PACK_COMMIT="$(git rev-parse HEAD)"

gc pack release stamp registry.toml my-pack \\
  --version 0.1.0 \\
  --ref main \\
  --commit "$PACK_COMMIT" \\
  --source "https://github.com/example/gascity-packs/tree/main/my-pack" \\
  --pack-description "Short description shown in search results." \\
  --description "Initial release."`;

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
          Pack authors keep their canonical `registry.toml` in their own repository. Gas City
          Registry accepts one pointer to that file, then CI generates the aggregate
          `registry.toml` and website JSON.
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
          <h2>Author-Owned Registry, Aggregated By CI</h2>
        </div>
        <div className="docsCallout">
          <PackagePlus size={22} aria-hidden="true" />
          <p>
            You publish releases by updating your repo's `registry.toml`. The Gas City registry repo
            stores only source pointers in `sources.toml`; CI fetches those pointers and regenerates
            `/registry.toml`, `/catalog.json`, and Open Graph preview assets.
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
            <span>Commit and push the pack content before stamping a release.</span>
          </li>
          <li>
            <strong>Stamp your canonical `registry.toml` with `gc`.</strong>
            <span>
              Run `gc pack release stamp` so the release commit, pack name, and content hash are
              generated from the exact tracked GitHub source.
            </span>
          </li>
          <li>
            <strong>Validate the registry file.</strong>
            <span>Run `gc pack release validate registry.toml` before opening the pointer PR.</span>
          </li>
          <li>
            <strong>Add one pointer to `gascity/registry`.</strong>
            <span>Edit `sources.toml` in this repository and point at your raw `registry.toml` URL.</span>
          </li>
          <li>
            <strong>Let CI regenerate the aggregate.</strong>
            <span>The PR must include generated `public/registry.toml`, `public/catalog.json`, and `public/og/` updates.</span>
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
          <p className="eyebrow">Release command</p>
          <h2>Stamp The Release</h2>
          <p className="mutedText">
            Run this from the repository that owns `registry.toml`, after the pack commit has been
            pushed to GitHub. `gc` clones the source, checks the pack name in `pack.toml`, resolves
            the full commit SHA, and writes the canonical `sha256:` content hash.
          </p>
        </div>
        <pre className="docsCode">
          <code>{stampReleaseCommand}</code>
        </pre>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <p className="eyebrow">Validation</p>
          <h2>Check The Registry File</h2>
          <p className="mutedText">
            Validation re-fetches the recorded source and verifies every active release hash before
            you open the pointer PR.
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
          <p className="eyebrow">Pointer PR</p>
          <h2>sources.toml Entry</h2>
          <p className="mutedText">
            The only hand-authored change in `gascity/registry` should be a source pointer. The
            generated aggregate files are committed alongside it.
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
            Local validation: `gc pack release validate registry.toml`
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
