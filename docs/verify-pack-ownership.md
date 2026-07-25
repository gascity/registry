# Verify Pack Ownership

Pack ownership verification connects a registry pack to the GitHub repository
that publishes its source `registry.toml`.

## Requirements

- The pack's source URL must be a GitHub repository URL in the aggregate
  catalog.
- You must be signed in to `registry.gascity.com`.
- The Gas City Registry Verifier GitHub App must be installed on the source
  repository.
- Your GitHub account must have admin permission on that repository.

## GitHub App

Use the official GitHub App:

```text
https://github.com/apps/gas-city-registry-verifier/installations/select_target
```

The app only needs repository metadata. Registry verification discards the
temporary GitHub user token after each verification and stores the immutable
GitHub repository and owner IDs with the local publisher mapping.

## Flow

1. Open the pack detail page.
2. Open the Trust tab.
3. Install the Gas City Registry Verifier GitHub App on the source repository
   if it is not installed yet.
4. Click Verify ownership.
5. Authorize GitHub.
6. Return to the Trust tab and confirm the source is shown as verified.

If the app is removed from a source repository, GitHub webhooks revoke the
corresponding registry ownership records.

## Unattended approval of repeat releases

Once a pack name has been claimed by a staff-approved release, further releases
of that name published from the same repository through GitHub Actions OIDC can
merge without a staff click. Nothing else does: a personal API token, a browser
session, a GitHub import and a verified pack-ownership record all still queue
for review.

Understand the trust boundary before you rely on it. **A GitHub Actions OIDC
token proves push access, not admin.** Registry checks that the workflow lives
in the publishing repository's `.github/workflows/`, that the token's repository
and commit match the release, and that the runner is GitHub-hosted — a workflow
file on any branch satisfies that. So unattended publishing is available to
everyone who can run a workflow in the claimed repository, which is already
everyone with write access to it.

Registry deliberately does not gate on which ref the release was cut from:
"release only from a tag" or "only from `main`" is your control, not ours to
guess. Use GitHub's own mechanisms if you need it:

- Branch protection and required reviews on the release branch.
- A [deployment environment](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment)
  with required reviewers, and `environment:` on the publishing job — the OIDC
  token is only issued after the environment's approval.
- Restrict who can run the workflow, and keep the publish job separate from
  build jobs that run untrusted contributor code.

The ref and event name of every unattended approval are recorded in the registry
audit log, and each auto-approved release is labelled as such in the staff queue
and on your account page. Registry staff can take any release down at any time,
and either refusal is durable: once staff have taken a release down or rejected
a queued one, every later release of that pack goes back to human review — a
re-run of the same workflow will not merge it, and neither will bumping the
version. Fix what the refusal was about and ask staff to approve the next
release; that approval re-arms unattended publishing.
