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
