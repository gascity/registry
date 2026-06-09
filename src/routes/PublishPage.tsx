import { ExternalLink, FileCode2, GitPullRequest, PackagePlus, ShieldCheck } from "lucide-react";
import { REGISTRY_SOURCE_URL } from "../lib/links";

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
            <span>Commit the pack content and README before stamping a release.</span>
          </li>
          <li>
            <strong>Stamp or update your canonical `registry.toml`.</strong>
            <span>
              Prefer `gc pack release stamp` or your repo's `make registry-publish` wrapper so the
              commit and content hash are generated from tracked content.
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
          <p className="eyebrow">Preferred release command</p>
          <h2>Stamp The Release</h2>
          <p className="mutedText">
            Existing pack repos can wrap this with `make registry-publish`. `REGISTRY_COMMIT`
            defaults to `HEAD`, and only tracked files at that commit are hashed.
          </p>
        </div>
        <pre className="docsCode">
          <code>{`GC=/path/to/gc make registry-publish \\
  PACK=my-pack \\
  VERSION=0.1.0 \\
  DESCRIPTION="Initial release." \\
  PACK_DESCRIPTION="Short description shown in search results."`}</code>
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
