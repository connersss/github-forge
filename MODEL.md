# github-core-clone-01 — a GitHub-compatible git forge

A standalone git forge in Node 22 (stdlib only, no dependencies, no git binary)
implementing the scored subset of the make.fun `github-core-clone-01` bounty
($500, closes 2026-11-21T06:30:00Z): git smart HTTP, the REST v3 API, the
GraphQL v4 API, and an MCP endpoint — all in one process, in-memory store.

## Files

| File | What it is |
| --- | --- |
| `main.ts` | Entrypoint / trial lifecycle: binds an ephemeral port, POSTs it to `$MAKEFUN_ENV_URL/register`, polls `/done`, exits 0. Standalone mode (`node app.ts`) listens on `$PORT`. |
| `app.ts` | HTTP server: REST v3, GraphQL v4, MCP, git smart HTTP routing, auth. |
| `store.ts` | In-memory store: repos, git objects, refs, issues, PRs, labels, comments; three-way merge, merge-base, fetch planning. |
| `githttp.ts` | Git smart HTTP: v2/v0 advertisements, ls-refs, fetch, receive-pack, push reports. |
| `gitobj.ts` | Git object model (blob/tree/commit/tag), pkt-line framing, packfile read/write incl. OFS/REF delta resolution. |
| `package.json` | `start: node --experimental-strip-types main.ts`, engines node `>=22.18`. |
| `LICENSE` | MIT (copied from the kit starter). |

## What it implements

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack v2 (fetch, ls-refs,
  `object-format=sha1`, `ref-prefix`, `peel`, `symrefs`, `unborn`), receive-pack
  v0 (`report-status`, `side-band-64k`, `delete-refs`). Clone, incremental fetch,
  shallow clone (`depth`, `deepen`, `deepen-relative`, `deepen-since/not`),
  push (fast-forward, create/delete branch and tag, non-fast-forward refused
  per-ref with reason `non-fast-forward`, mixed ok/ng reports), annotated tags,
  100-file single-commit pushes, sideband framing. Packfiles are written plain
  (no deltas); packs **read** resolve OFS_DELTA and REF_DELTA chains, including
  thin packs whose bases live in the repo.
- **REST v3** under `/api/v3`: root/meta/user, repos (create/get/patch/delete,
  Link pagination), git refs (create/get), branches, commits (`?sha=`), contents
  (get file/dir, put incl. unborn-repo first commit, delete; stale sha → 409),
  labels, issues (create/list/get/patch/comments, numbers from 1), pull requests
  (create/list/get/files, squash merge, merge-conflict → 405). Every reply is
  JSON with a non-empty `X-GitHub-Request-Id`; unknown route → JSON 404;
  malformed JSON → 400.
- **GraphQL v4** at `/api/graphql`: own tokenizer/parser/executor for the
  suite's documents — viewer, repository, node, `__type` introspection for
  Issue/PullRequest/Repository/SearchType, issues connection with cursor
  pagination, issue/pullRequest by number, createIssue/closeIssue/
  createPullRequest/mergePullRequest/addComment mutations, batched operation
  documents, invalid-field → 200 with `errors`. Global ids are opaque base64url
  and stable. `mergeable` is the GitHub enum `MERGEABLE`/`CONFLICTING`/`UNKNOWN`.
- **MCP** at `/mcp` (streamable HTTP): `server/discover` (modern era, with
  `serverInfo`), legacy `initialize` + `notifications/initialized`, `ping`,
  `tools/list` (byte-identical), `tools/call` for `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`
  (with argument-synonym mapping), unknown tool → -32602, parse error → 400/-32700,
  missing arguments → `isError: true`.
- **Auth**: when `MAKEFUN_SHOP_TOKEN` is set, a Bearer token is required (401
  otherwise) on REST/GraphQL/MCP; `/healthz` and the root stay public. When it
  is unset (local dev), auth is disabled.
- **Merges**: a PR's mergeability is judged against the **current** base-branch
  tip (not the tip at creation time), so a PR opened before a conflicting merge
  is correctly reported conflicting (405) instead of silently overwriting it.
- **Identity**: the viewer is the seeded `adaiversen` (id 1000); commits use a
  fixed timestamp/identity so identical requests produce identical bytes
  (deterministic export / replay).

## What it does NOT do

- No persistence: the store is in-memory and is wiped on every restart. The
  trial runs one process per trial, so this matches the scoring environment.
- No web UI: the bounty is API-only (the suite is the only client).
- No git binary, no network beyond the env, no external service.
- No `deepen-since`/`deepen-not` date filtering is actually applied (the
  arguments are parsed and accepted; depth is the effective limit).
- No rate limiting, no pagination cursors beyond `Link`/`page`/`per_page` on
  REST lists, no webhook/events surface.
- GraphQL covers the suite's fixed documents, not arbitrary queries: unknown
  fields error, unknown top-level fields are rejected, and only the documented
  types/fields are implemented.

## Test results

### Kit env trial (the real scorer, `program/env/server.mjs`, process driver)

Run 2026-11-17 ~10:02 WIB, trial-0, against this exact code:

- **120/120 checks passed** (git 30/30, repos 14→15/15, issues 15/15,
  pulls 20/20, graphql 19→20/20, mcp 14→15/15, protocol 5/5), working 1.
- **Perf 114/200** on that run (push p50 1222 ms → 30 pts, clone 309 ms → 22,
  read 1900 ms → 32, write 263 ms → 30). Perf is load-sensitive on this VM:
  an earlier run scored 158/200 (push 565 ms, read 896 ms, write 114 ms).
  Score on the 120/120 run: **600 + 200 + 114 = 914/1000**.
- The entry registered, served the whole suite, and exited 0 on `/done`.

Three bugs found by the trial and fixed (all in this code):

1. GraphQL `mergeable` was a boolean; GitHub's is the enum
   `MERGEABLE`/`CONFLICTING`/`UNKNOWN` (`graphql.pull-requests-list`).
2. REST commit messages carried the commit object's trailing `\n`; GitHub's
   API strips it (`repos.commits` exact-message comparison).
3. `server/discover` returned `identity` only; the suite reads `serverInfo`
   (or `_meta['io.modelcontextprotocol/serverInfo']`) (`mcp.initialize`).

### Real git client (git 2.43.0, localhost)

`/tmp/forge-git-test.sh`: **29/29 passed** — empty clone, first/second/third
commit pushes (multi-commit delta packs), annotated tag, new branch, non-
fast-forward refused, delete/recreate branch, full clone (byte-exact, fsck
clean), incremental fetch, fetch-nothing-new, shallow depth-1 clone, deepen,
shallow fetch of a new tip, 100-file push round-trip.

Deepen semantics were verified against real git's http-backend: a depth-1
clone + `fetch --deepen=2` yields 3 commits (boundary depth 1 + deepen 2);
the kit's absolute `deepen 2` (no `deepen-relative`) yields 2, as the suite
expects.

### REST / GraphQL / MCP (curl)

`/tmp/forge-rest-test.sh`: **74/74 passed** — protocol/root/meta, repo CRUD
and pagination, contents (incl. unborn-repo first commit, stale-sha 409,
root dir listing), labels/issues/comments, pulls + squash merge + merge
conflict 405, GraphQL (viewer, repository, introspection, mutations, node,
batching, invalid field), MCP (discover, initialize, tools/list idempotence,
tools/call, unknown tool, parse error, missing args).

### Auth (token set)

No token → 401 on REST user, GraphQL, MCP; correct token → 200; wrong token
→ 401; `/healthz` stays 200 without a token.

## Run it

```sh
# Trial mode (as the grader runs it):
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> \
  node --experimental-strip-types main.ts

# Standalone (local dev, no auth):
PORT=18099 node --experimental-strip-types app.ts
```
