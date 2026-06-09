import {
  CheckCircle2,
  Database,
  ExternalLink,
  GitBranch,
  KeyRound,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { GITHUB_APP_INSTALL_URL } from "../lib/links";

export function VerifierPage({ navigateTo }: { navigateTo: (path: string) => void }) {
  return (
    <main className="docsPage">
      <section className="docsHero">
        <p className="eyebrow">GitHub App verifier</p>
        <h1>Pack Ownership Verification</h1>
        <p>
          Verification connects a registry pack to the canonical GitHub repository that publishes
          its source. It is intentionally narrow: prove repository control, store stable IDs, and
          discard temporary GitHub credentials.
        </p>
        <div className="docsActions">
          <a className="iconTextButton primary" href={GITHUB_APP_INSTALL_URL} rel="noreferrer">
            <GitBranch size={16} aria-hidden="true" />
            Install verifier
            <ExternalLink size={15} aria-hidden="true" />
          </a>
          <a
            className="smallMutedButton"
            href="/publish"
            onClick={(event) => {
              event.preventDefault();
              navigateTo("/publish");
            }}
          >
            Publish a pack
          </a>
        </div>
      </section>

      <section className="docsGrid" aria-label="Verification guarantees">
        <article className="docsPanel">
          <ShieldCheck size={22} aria-hidden="true" />
          <h2>What It Proves</h2>
          <p>
            The signed-in Gas City user can authorize GitHub and has admin access to the source
            repository through the installed Registry Verifier app.
          </p>
        </article>
        <article className="docsPanel">
          <Database size={22} aria-hidden="true" />
          <h2>What We Store</h2>
          <p>
            The registry stores immutable GitHub owner and repository IDs, repository display names,
            verification time, and the local publisher mapping. User access tokens are not retained.
          </p>
        </article>
        <article className="docsPanel">
          <RotateCcw size={22} aria-hidden="true" />
          <h2>What Revokes It</h2>
          <p>
            GitHub installation webhooks remove ownership records when the app is uninstalled from a
            repository or repository access is removed from the app installation.
          </p>
        </article>
      </section>

      <section className="docsSection">
        <div className="sectionTitle">
          <p className="eyebrow">Flow</p>
          <h2>How Verification Works</h2>
        </div>
        <ol className="stepList">
          <li>
            <strong>Sign in to the registry.</strong>
            <span>The app uses the current Gas City account as the publisher identity.</span>
          </li>
          <li>
            <strong>Open a pack's Trust tab.</strong>
            <span>The registry checks the aggregate catalog entry and resolves the GitHub source.</span>
          </li>
          <li>
            <strong>Install the verifier app.</strong>
            <span>The app needs metadata access on the source repository; it does not need code write access.</span>
          </li>
          <li>
            <strong>Authorize GitHub verification.</strong>
            <span>The callback state is signed, short-lived, and bound to the current registry user.</span>
          </li>
          <li>
            <strong>Registry checks repository admin access.</strong>
            <span>GitHub must return the source repository in the user's app-installation repository list.</span>
          </li>
          <li>
            <strong>Ownership becomes verified.</strong>
            <span>The Trust tab shows the verified publisher and future webhook removals can revoke it.</span>
          </li>
        </ol>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <p className="eyebrow">Security boundaries</p>
          <h2>What The Verifier Does Not Do</h2>
        </div>
        <ul className="checkList">
          <li>
            <CheckCircle2 size={16} aria-hidden="true" />
            It does not publish packs or mutate source repositories.
          </li>
          <li>
            <CheckCircle2 size={16} aria-hidden="true" />
            It does not store GitHub user access tokens after verification.
          </li>
          <li>
            <CheckCircle2 size={16} aria-hidden="true" />
            It does not replace registry review; it only attributes a pack to a controlled source.
          </li>
        </ul>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <p className="eyebrow">Prerequisites</p>
          <h2>Before You Verify</h2>
        </div>
        <ul className="checkList">
          <li>
            <KeyRound size={16} aria-hidden="true" />
            The pack source must be a GitHub repository URL in the aggregate catalog.
          </li>
          <li>
            <KeyRound size={16} aria-hidden="true" />
            The GitHub App must be installed on that source repository.
          </li>
          <li>
            <KeyRound size={16} aria-hidden="true" />
            Your GitHub account must have admin permission on the source repository.
          </li>
        </ul>
      </section>

      <section className="docsSection twoColumnDocs">
        <div>
          <p className="eyebrow">Public metadata</p>
          <h2>Verifier App Values</h2>
        </div>
        <dl className="docsDefinitionList">
          <div>
            <dt>GitHub App slug</dt>
            <dd>gas-city-registry-verifier</dd>
          </div>
          <div>
            <dt>GitHub App client id</dt>
            <dd>Iv23libht048ujfs7SL4</dd>
          </div>
          <div>
            <dt>Callback URL</dt>
            <dd>https://registry.gascity.com/api/ownership/github/callback</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
