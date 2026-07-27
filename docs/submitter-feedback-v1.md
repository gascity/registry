# Pack submitter feedback v1

Status: implementation note
Version: 1

This feature adds a durable, plain-text conversation to an existing pack
publish request. It does not replace validation, ownership proof, moderation,
or the publish-request status machine.

## Scope

A submitter can:

- list publish requests they own;
- read one owned request and its comments;
- reply while the request is nonterminal; and
- acknowledge the exact unread version they observed.

Registry administrators and moderators can:

- read any publish request with its comments;
- add a comment;
- assign the next action to the submitter or Registry staff; and
- continue to use the existing validate, approve, reject, and withdraw actions.

The CLI list and detail commands are read-only. Browser detail views acknowledge
an unread version after the detail loads.

The feature does not add filters, pagination, deep links, background polling,
editable comments, Markdown, HTML, email, push notifications, or per-device
read state.

## Lifecycle

The existing status remains the source of truth:

| Status | Default next step |
| --- | --- |
| `pending_validation` | `await_validation` |
| `validation_failed` | `fix_validation` |
| `pending_review` with submitter action | `respond_to_feedback` |
| `pending_review` otherwise | `await_registry_review` |
| `approved` | `published` |
| `rejected` or `withdrawn` | `resubmit` |

`nextStep` is derived from `status` and `actionRequiredBy`; it is never stored
as a second state machine.

Comments are allowed only while status is:

- `pending_validation`;
- `validation_failed`; or
- `pending_review`.

Approved, rejected, and withdrawn requests are terminal. A corrected release
uses a new publish request.

## Durable data

Each request adds:

- `actionRequiredBy`: `submitter`, `registry`, or null; and
- `submitterUnreadAt`: a nullable timestamp.

Each comment stores:

- an opaque ID;
- its publish-request ID;
- the author user ID when that user still exists;
- an author-handle snapshot;
- author role (`submitter` or `registry`);
- a plain-text body; and
- its creation timestamp.

Comment order is creation timestamp followed by bytewise ID.

There is one unread value:

- null means read;
- a timestamp means unread at that version.

A staff-visible change assigns a timestamp later than the request's prior
`updatedAt`. Reading does not invent a second read clock. An acknowledgement
clears `submitterUnreadAt` only when its `observedUnreadAt` exactly matches the
current value. A stale or fabricated acknowledgement is a successful no-op.

Existing rows migrate with `submitterUnreadAt` null, so deployment does not
create historical notifications. Existing pending-review rows default their
next actor to Registry staff.

## Owner API

Owner endpoints accept either:

- an authenticated browser session; or
- a personal Registry bearer token.

Browser mutations require the existing CSRF token. GitHub Actions publish and
other constrained tokens cannot read account-wide request history.

### List

`GET /api/v1/me/publish-requests`

Response:

```json
{
  "publishRequests": [
    {
      "id": "prq_123",
      "status": "pending_review",
      "nextStep": "respond_to_feedback",
      "actionRequiredBy": "submitter",
      "requestedName": "acme/tools",
      "requestedVersion": "1.2.3",
      "repository": {
        "host": "github.com",
        "owner": "acme",
        "name": "tools",
        "fullName": "acme/tools"
      },
      "packPath": "packs/tools",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "unread": true,
      "submitterUnreadAt": "2026-07-27T12:00:00.000Z",
      "createdAt": "2026-07-27T11:00:00.000Z",
      "updatedAt": "2026-07-27T12:00:00.000Z"
    }
  ],
  "unreadCount": 1
}
```

The collection is unfiltered and bounded by the existing account request list.
Summary rows do not contain comment previews or counts.

### Detail

`GET /api/v1/me/publish-requests/{id}`

The response wraps `publishRequest`. It adds the existing detail fields and an
ordered `comments` array to the owner summary. A request owned by another user
is returned as not found.

### Reply

`POST /api/v1/me/publish-requests/{id}/comments`

```json
{ "body": "The README now documents the runtime requirement." }
```

The response contains only the created comment. A submitter reply assigns the
next action to Registry staff.

### Read acknowledgement

`POST /api/v1/me/publish-requests/{id}/read`

```json
{ "observedUnreadAt": "2026-07-27T12:00:00.000Z" }
```

The response is `204`, including when the version is stale.

## Staff API

Staff endpoints are browser-session-only. A personal bearer token owned by a
staff user is not a moderation credential.

`GET /api/v1/admin/publish-requests/{id}` returns one request and its ordered
comments. Submitter unread state is omitted.

`POST /api/v1/admin/publish-requests/{id}/comments` requires CSRF:

```json
{
  "body": "Please clarify the runtime requirement.",
  "actionRequiredBy": "submitter"
}
```

The response contains only the created comment.

## Comment safety

Comment bodies are trimmed and stored as plain text. They must contain between
1 and 4,000 Unicode characters and cannot contain NUL. React renders them as
text; clients must not interpret them as Markdown or HTML.

Authorization is checked before comments are read or written. Terminal-state
enforcement and comment validation are performed in the store mutation so file
and Postgres implementations share the same rule.

The Postgres comment mutation updates request state and inserts the comment in
one transaction. The file store persists both together and rolls its in-memory
comment/request pair back if that save fails.

## UI behavior

The Account card shows status, centrally derived next-step text, unread count,
and the existing Validate action. Detail is loaded only when a conversation is
opened. After a successful read acknowledgement, summaries reload.

After a reply, the browser performs one durable detail refetch and one summary
reload. It focuses the newly appended comment once.

Staff use the existing publish-request row. Opening the conversation loads one
detail resource. After a staff comment, the browser refetches that detail once
and focuses the new comment once.
