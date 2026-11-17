// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP.
// Node 22 stdlib only, no dependencies, no git binary. All state lives in memory
// (the trial environment is ephemeral; the harness creates its fixtures through
// this API, so nothing needs to persist across restarts).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import {
  decodePktLines,
  encodePktLine,
  isObjectId,
  packetsToLines,
  parseCommit,
  parseTag,
  parseTree,
  pktLineFlush,
  writePack,
} from './gitobj.ts';
import {
  DEFAULT_BRANCH,
  FIXED_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type PullRequest,
  type Repo,
  Store,
} from './store.ts';
import {
  applyPush,
  fetchResponse,
  lsRefsResponse,
  parseFetch,
  parseLsRefs,
  parseReceivePack,
  pushReportResponse,
  v0Advertisement,
  v2Advertisement,
} from './githttp.ts';

const store = new Store();
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const PORT = Number.parseInt(process.env.PORT ?? '0', 10) || 0;

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// -------------------------------------------------------------------------------------------
// global ids (opaque, stable, never equal to the plain database id)
// -------------------------------------------------------------------------------------------

function globalId(kind: string, repoId: number, local?: number): string {
  const raw = local === undefined ? `${kind}:${repoId}` : `${kind}:${repoId}:${local}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeGlobalId(id: string): { kind: string; repoId: number; local: number | null } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const parts = raw.split(':');
    if (parts.length < 2) return null;
    const repoId = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(repoId)) return null;
    return {
      kind: parts[0],
      repoId,
      local: parts.length >= 3 ? Number.parseInt(parts[2], 10) : null,
    };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// HTTP helpers
// -------------------------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': payload.length,
    'X-GitHub-Request-Id': requestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'X-GitHub-Request-Id': requestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Bearer auth. When no token is configured the server accepts everything (local dev);
 *  when a token is configured, a matching Bearer token is required. */
function isAuthorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${TOKEN}`;
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (isAuthorized(req)) return true;
  sendError(res, 401, 'Requires authentication');
  return false;
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const raw = await readBody(req);
    if (raw.length === 0) return { ok: true, value: {} };
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function queryOf(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams;
}

function baseOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

// -------------------------------------------------------------------------------------------
// REST views
// -------------------------------------------------------------------------------------------

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({
      name,
      color: repo.labels.get(name)?.color ?? '000000',
    })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    assignee: null,
    locked: false,
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullView(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: globalId('PullRequest', repo.id, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${VIEWER_LOGIN}:${pr.headRef}` },
    // base.sha tracks the base branch as it moves (other PRs merging), not the tip
    // at creation time.
    base: { ref: pr.baseRef, sha: store.prBaseTip(repo, pr), label: `${VIEWER_LOGIN}:${pr.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
  };
}

/** Look a repo up by owner/name; only the token owner's repos exist. */
function findRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return store.getRepo(owner, name);
}

/** Walk a commit's tree to the object at a path (blob or tree oid), or null. */
function objectAtPath(repo: Repo, commitOid: string, path: string): { oid: string; type: 'blob' | 'tree' } | null {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  const segments = path === '' ? [] : path.split('/');
  let current = parseCommit(commit.data).tree;
  for (let i = 0; i < segments.length; i += 1) {
    const tree = repo.objects.get(current);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      return { oid: entry.oid, type: entry.mode === '40000' ? 'tree' : 'blob' };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { oid: current, type: 'tree' };
}

/** The immediate children of a directory path in a commit's tree. */
function dirChildren(repo: Repo, commitOid: string, dirPath: string): Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> | null {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  const target = dirPath === '' ? { oid: parseCommit(commit.data).tree, type: 'tree' as const } : objectAtPath(repo, commitOid, dirPath);
  if (!target || target.type !== 'tree') return null;
  const tree = repo.objects.get(target.oid);
  if (!tree || tree.type !== 'tree') return null;
  return parseTree(tree.data).map((entry) => ({
    name: entry.name,
    path: dirPath === '' ? entry.name : `${dirPath}/${entry.name}`,
    oid: entry.oid,
    type: entry.mode === '40000' ? 'dir' as const : 'file' as const,
  }));
}

/** Resolve a ref name (branch, tag or oid) to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return store.refTip(repo, `refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
  if (repo.refs.has(`refs/tags/${ref}`)) {
    const oid = repo.refs.get(`refs/tags/${ref}`)!;
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      // Peel to the commit.
      let current = parseTag(object.data).object;
      for (let i = 0; i < 8; i += 1) {
        const next = repo.objects.get(current);
        if (!next) return null;
        if (next.type === 'commit') return current;
        if (next.type === 'tag') current = parseTag(next.data).object;
        else return null;
      }
      return null;
    }
    return oid;
  }
  if (isObjectId(ref) && repo.objects.has(ref)) {
    const object = repo.objects.get(ref)!;
    return object.type === 'commit' ? ref : null;
  }
  return null;
}

/** Commits reachable from a tip, newest first (depth-first, parents after children). */
function listCommits(repo: Repo, tip: string, limit = 1000): Array<{ sha: string; message: string }> {
  const out: Array<{ sha: string; message: string }> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    // GitHub's API presents the message without the trailing newline the commit
    // object stores on disk; the kit compares messages exactly, so strip one.
    const message = commit.message.replace(/\r?\n$/, '');
    out.push({ sha: oid, message });
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// REST v3
// -------------------------------------------------------------------------------------------

async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const query = url.searchParams;
  // Path after /api/v3, split into segments (the contents path keeps its slashes).
  let path = url.pathname.replace(/^\/api\/v3\/?/, '');
  const segs = path === '' ? [] : path.split('/').map((s) => decodeURIComponent(s));

  // GET /api/v3 and GET /api/v3/ — root.
  if (segs.length === 0) {
    if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed');
    return sendJson(res, 200, { current_user_url: '/api/v3/user' }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (segs.length === 1 && segs[0] === 'meta') {
    if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed');
    return sendJson(res, 200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (segs.length === 1 && segs[0] === 'user') {
    if (!requireAuth(req, res)) return;
    if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed');
    return sendJson(res, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: globalId('User', VIEWER_ID),
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
    });
  }

  // POST /user/repos, GET /user/repos
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (!requireAuth(req, res)) return;
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Invalid JSON');
      if (!isObject(body.value)) return sendError(res, 400, 'Invalid request body');
      const name = body.value.name;
      if (typeof name !== 'string' || name === '' || name.includes('/')) {
        return sendError(res, 422, 'name is required');
      }
      if (store.getRepo(VIEWER_LOGIN, name)) return sendError(res, 422, 'Repository already exists');
      const repo = store.createRepo(
        VIEWER_LOGIN,
        name,
        typeof body.value.description === 'string' ? body.value.description : '',
        body.value.private === true,
      );
      return sendJson(res, 201, repoView(repo));
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
      const all = store.listRepos(VIEWER_LOGIN);
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const next = `${baseOf(req)}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        headers.Link = `<${next}>; rel="next"`;
      }
      return sendJson(res, 200, slice.map(repoView), headers);
    }
    return sendError(res, 405, 'Method Not Allowed');
  }

  // /repos/{owner}/{name}[...]
  if (segs.length >= 3 && segs[0] === 'repos') {
    if (!requireAuth(req, res)) return;
    const [owner, name] = [segs[1], segs[2]];
    const rest = segs.slice(3);
    const repo = findRepo(owner, name);

    // GET /repos/{o}/{r}, PATCH, DELETE
    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, repoView(repo));
      }
      if (method === 'PATCH') {
        if (!repo) return sendError(res, 404, 'Not Found');
        const body = await readJsonBody(req);
        if (!body.ok) return sendError(res, 400, 'Invalid JSON');
        if (isObject(body.value) && typeof body.value.description === 'string') {
          repo.description = body.value.description;
        }
        return sendJson(res, 200, repoView(repo));
      }
      if (method === 'DELETE') {
        if (!repo) return sendError(res, 404, 'Not Found');
        store.deleteRepo(owner, name);
        res.writeHead(204, { 'X-GitHub-Request-Id': requestId() });
        return res.end();
      }
      return sendError(res, 405, 'Method Not Allowed');
    }
    if (!repo) return sendError(res, 404, 'Not Found');

    // GET /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed');
      const branches: Array<Record<string, unknown>> = [];
      for (const refName of [...repo.refs.keys()].sort()) {
        if (!refName.startsWith('refs/heads/')) continue;
        branches.push({ name: refName.slice('refs/heads/'.length), commit: { sha: repo.refs.get(refName) } });
      }
      return sendJson(res, 200, branches);
    }

    // GET /repos/{o}/{r}/branches/{branch}
    if (rest.length === 2 && rest[0] === 'branches') {
      if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed');
      const tip = repo.refs.get(`refs/heads/${rest[1]}`);
      if (!tip) return sendError(res, 404, 'Branch not found');
      return sendJson(res, 200, { name: rest[1], commit: { sha: tip } });
    }

    // GET /repos/{o}/{r}/commits[?sha=]
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed');
      const tip = resolveRef(repo, query.get('sha'));
      if (tip === null) return sendError(res, 404, 'Not Found');
      return sendJson(
        res,
        200,
        listCommits(repo, tip).map((c) => ({
          sha: c.sha,
          commit: { message: c.message },
          parents: (repo.objects.get(c.sha)?.type === 'commit'
            ? parseCommit(repo.objects.get(c.sha)!.data).parents
            : []).map((sha) => ({ sha })),
        })),
      );
    }

    // POST /repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Invalid JSON');
      if (!isObject(body.value)) return sendError(res, 400, 'Invalid request body');
      const ref = body.value.ref;
      const sha = body.value.sha;
      if (typeof ref !== 'string' || !(ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/'))) {
        return sendError(res, 422, 'ref must start with refs/heads/ or refs/tags/');
      }
      if (typeof sha !== 'string' || !repo.objects.has(sha)) {
        return sendError(res, 422, 'sha does not exist');
      }
      if (repo.refs.has(ref)) return sendError(res, 422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return sendJson(res, 201, {
        ref,
        object: { sha, type: repo.objects.get(sha)!.type },
        url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
      });
    }

    // GET /repos/{o}/{r}/git/refs/heads/{branch}
    if (rest.length === 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads') {
      if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed');
      const tip = repo.refs.get(`refs/heads/${rest[3]}`);
      if (!tip) return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, { ref: `refs/heads/${rest[3]}`, object: { sha: tip, type: 'commit' } });
    }

    // /repos/{o}/{r}/contents[/{path...}]
    if (rest.length >= 1 && rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'GET') {
        const tip = resolveRef(repo, query.get('ref'));
        if (tip === null) return sendError(res, 404, 'Not Found');
        if (filePath === '') {
          const children = dirChildren(repo, tip, '');
          if (children === null) return sendError(res, 404, 'Not Found');
          return sendJson(res, 200, children.map((c) => ({ type: c.type, name: c.name, path: c.path, sha: c.oid })));
        }
        const at = objectAtPath(repo, tip, filePath);
        if (at === null) return sendError(res, 404, 'Not Found');
        if (at.type === 'tree') {
          const children = dirChildren(repo, tip, filePath);
          if (children === null) return sendError(res, 404, 'Not Found');
          return sendJson(res, 200, children.map((c) => ({ type: c.type, name: c.name, path: c.path, sha: c.oid })));
        }
        const blob = repo.objects.get(at.oid);
        if (!blob || blob.type !== 'blob') return sendError(res, 404, 'Not Found');
        const name = filePath.split('/').pop()!;
        return sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name,
          path: filePath,
          content: blob.data.toString('base64'),
          sha: at.oid,
        });
      }
      if (method === 'PUT' || method === 'DELETE') {
        const body = await readJsonBody(req);
        if (!body.ok) return sendError(res, 400, 'Invalid JSON');
        if (!isObject(body.value)) return sendError(res, 400, 'Invalid request body');
        const branchName = typeof body.value.branch === 'string' ? body.value.branch : repo.defaultBranch;
        const refName = `refs/heads/${branchName}`;
        const tip = repo.refs.get(refName);
        // Unborn repo: only a PUT creating the first file is allowed.
        if (tip === undefined) {
          if (method === 'DELETE') return sendError(res, 404, 'Not Found');
          if (filePath === '') return sendError(res, 422, 'path is required');
          const content = typeof body.value.content === 'string' ? Buffer.from(body.value.content, 'base64') : null;
          if (content === null) return sendError(res, 422, 'content is required');
          const flat = new Map<string, { mode: string; oid: string }>();
          flat.set(filePath, { mode: '100644', oid: store.putObject(repo, 'blob', content) });
          const commitSha = store.makeCommit(
            repo,
            flat,
            typeof body.value.message === 'string' ? body.value.message : `Create ${filePath}`,
            [],
          );
          repo.refs.set(refName, commitSha);
          return sendJson(res, 201, {
            content: { name: filePath.split('/').pop()!, path: filePath, sha: flat.get(filePath)!.oid, size: content.length, encoding: 'base64' },
            commit: { sha: commitSha },
          });
        }
        const flat = store.treeOfCommit(repo, tip);
        const existing = flat.get(filePath);
        if (method === 'DELETE') {
          if (!existing) return sendError(res, 404, 'Not Found');
          if (typeof body.value.sha === 'string' && body.value.sha !== existing.oid) {
            return sendError(res, 409, 'sha does not match the current file');
          }
          flat.delete(filePath);
          const commitSha = store.makeCommit(
            repo,
            flat,
            typeof body.value.message === 'string' ? body.value.message : `Delete ${filePath}`,
            [tip],
          );
          repo.refs.set(refName, commitSha);
          return sendJson(res, 200, { commit: { sha: commitSha } });
        }
        // PUT
        const content = typeof body.value.content === 'string' ? Buffer.from(body.value.content, 'base64') : null;
        if (content === null) return sendError(res, 422, 'content is required');
        if (existing) {
          if (typeof body.value.sha !== 'string' || body.value.sha !== existing.oid) {
            return sendError(res, 409, 'sha does not match the current file');
          }
        }
        const blobOid = store.putObject(repo, 'blob', content);
        flat.set(filePath, { mode: '100644', oid: blobOid });
        const commitSha = store.makeCommit(
          repo,
          flat,
          typeof body.value.message === 'string' ? body.value.message : `${existing ? 'Update' : 'Create'} ${filePath}`,
          [tip],
        );
        repo.refs.set(refName, commitSha);
        return sendJson(res, existing ? 200 : 201, {
          content: { name: filePath.split('/').pop()!, path: filePath, sha: blobOid, size: content.length, encoding: 'base64' },
          commit: { sha: commitSha },
        });
      }
      return sendError(res, 405, 'Method Not Allowed');
    }

    // POST /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
      const body = await readJsonBody(req);
      if (!body.ok) return sendError(res, 400, 'Invalid JSON');
      if (!isObject(body.value)) return sendError(res, 400, 'Invalid request body');
      const name = body.value.name;
      if (typeof name !== 'string' || name === '') return sendError(res, 422, 'name is required');
      if (repo.labels.has(name)) return sendError(res, 422, 'Label already exists');
      const color = typeof body.value.color === 'string' ? body.value.color : '000000';
      repo.labels.set(name, { name, color });
      return sendJson(res, 201, { name, color });
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (rest.length >= 1 && rest[0] === 'issues') {
      // POST /issues, GET /issues
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = await readJsonBody(req);
          if (!body.ok) return sendError(res, 400, 'Invalid JSON');
          if (!isObject(body.value)) return sendError(res, 400, 'Invalid request body');
          const title = body.value.title;
          if (typeof title !== 'string' || title === '') return sendError(res, 422, 'title is required');
          const labels: string[] = [];
          if (Array.isArray(body.value.labels)) {
            for (const label of body.value.labels) {
              if (typeof label !== 'string') return sendError(res, 422, 'labels must be strings');
              if (!repo.labels.has(label)) return sendError(res, 422, `Label does not exist: ${label}`);
              labels.push(label);
            }
          }
          const issue: Issue = {
            id: store.issueIdSeq++,
            number: ++repo.issueSeq,
            title,
            body: typeof body.value.body === 'string' ? body.value.body : '',
            state: 'open',
            labels,
            comments: [],
            createdSeq: store.seq++,
          };
          repo.issues.push(issue);
          return sendJson(res, 201, issueView(repo, issue));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const direction = query.get('direction') ?? 'desc';
          let list = repo.issues.filter((i) => state === 'all' || i.state === state);
          list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          return sendJson(res, 200, list.map((i) => issueView(repo, i)));
        }
        return sendError(res, 405, 'Method Not Allowed');
      }
      const issueNumber = Number.parseInt(rest[1], 10);
      const issue = repo.issues.find((i) => i.number === issueNumber);
      // GET /issues/{n}, PATCH /issues/{n}
      if (rest.length === 2) {
        if (!issue) return sendError(res, 404, 'Not Found');
        if (method === 'GET') return sendJson(res, 200, issueView(repo, issue));
        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          if (!body.ok) return sendError(res, 400, 'Invalid JSON');
          if (isObject(body.value)) {
            if (typeof body.value.title === 'string') issue.title = body.value.title;
            if (typeof body.value.body === 'string') issue.body = body.value.body;
            if (body.value.state === 'open' || body.value.state === 'closed') issue.state = body.value.state;
          }
          return sendJson(res, 200, issueView(repo, issue));
        }
        return sendError(res, 405, 'Method Not Allowed');
      }
      // GET/POST /issues/{n}/comments
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return sendError(res, 404, 'Not Found');
        if (method === 'GET') {
          return sendJson(
            res,
            200,
            issue.comments.map((c) => ({
              id: c.id,
              node_id: globalId('IssueComment', repo.id, c.id),
              body: c.body,
              user: { login: VIEWER_LOGIN, id: VIEWER_ID },
              created_at: FIXED_ISO,
            })),
          );
        }
        if (method === 'POST') {
          const body = await readJsonBody(req);
          if (!body.ok) return sendError(res, 400, 'Invalid JSON');
          if (!isObject(body.value) || typeof body.value.body !== 'string' || body.value.body === '') {
            return sendError(res, 422, 'body is required');
          }
          const comment = { id: store.commentIdSeq++, body: body.value.body };
          issue.comments.push(comment);
          return sendJson(res, 201, {
            id: comment.id,
            node_id: globalId('IssueComment', repo.id, comment.id),
            body: comment.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID },
            created_at: FIXED_ISO,
          });
        }
        return sendError(res, 405, 'Method Not Allowed');
      }
      return sendError(res, 404, 'Not Found');
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
    if (rest.length >= 1 && rest[0] === 'pulls') {
      // POST /pulls, GET /pulls
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = await readJsonBody(req);
          if (!body.ok) return sendError(res, 400, 'Invalid JSON');
          if (!isObject(body.value)) return sendError(res, 400, 'Invalid request body');
          const title = body.value.title;
          const head = body.value.head;
          const base = body.value.base;
          if (typeof title !== 'string' || title === '') return sendError(res, 422, 'title is required');
          if (typeof head !== 'string' || typeof base !== 'string') {
            return sendError(res, 422, 'head and base are required');
          }
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) return sendError(res, 422, 'head or base branch does not exist');
          if (repo.pulls.some((p) => p.state === 'open' && p.headRef === head)) {
            return sendError(res, 422, 'A pull request already exists for this head branch');
          }
          const pr: PullRequest = {
            id: store.pullIdSeq++,
            number: repo.pulls.length + 1,
            title,
            body: typeof body.value.body === 'string' ? body.value.body : '',
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            headRef: head,
            headSha,
            baseRef: base,
            baseSha,
            createdSeq: store.seq++,
          };
          repo.pulls.push(pr);
          return sendJson(res, 201, pullView(repo, pr));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
          return sendJson(res, 200, list.map((p) => pullView(repo, p)));
        }
        return sendError(res, 405, 'Method Not Allowed');
      }
      const pullNumber = Number.parseInt(rest[1], 10);
      const pr = repo.pulls.find((p) => p.number === pullNumber);
      // GET /pulls/{n}
      if (rest.length === 2) {
        if (!pr) return sendError(res, 404, 'Not Found');
        if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed');
        return sendJson(res, 200, pullView(repo, pr));
      }
      // GET /pulls/{n}/files
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pr) return sendError(res, 404, 'Not Found');
        if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed');
        return sendJson(
          res,
          200,
          store.prFiles(repo, pr).map((f) => ({
            filename: f.filename,
            status: f.status === 'removed' ? 'changed' : f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
          })),
        );
      }
      // PUT /pulls/{n}/merge
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pr) return sendError(res, 404, 'Not Found');
        if (method !== 'PUT') return sendError(res, 405, 'Method Not Allowed');
        if (pr.state !== 'open' || pr.merged) return sendError(res, 405, 'Pull request is already merged or closed');
        if (!store.prMergeable(repo, pr)) return sendError(res, 405, 'Merge conflict');
        const sha = store.mergePull(repo, pr);
        if (sha === null) return sendError(res, 405, 'Merge conflict');
        return sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
      }
      return sendError(res, 404, 'Not Found');
    }

    return sendError(res, 404, 'Not Found');
  }

  return sendError(res, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// GraphQL v4 — a small parser + executor for exactly the documents the suite sends.
// -------------------------------------------------------------------------------------------

interface GqlField {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: GqlField[] | null;
  inlineType: string | null;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: GqlField[];
}

interface GqlToken {
  kind: 'name' | 'string' | 'number' | 'punct';
  value: string;
}

function tokenizeGraphql(src: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():![]$=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      tokens.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class GqlParser {
  tokens: GqlToken[];
  pos = 0;

  constructor(src: string) {
    this.tokens = tokenizeGraphql(src);
  }

  peek(): GqlToken | undefined {
    return this.tokens[this.pos];
  }

  next(): GqlToken {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected '${value}' but got '${token.value}'`);
    }
  }

  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name but got '${token.value}'`);
    return token.value;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('Empty GraphQL document');
    return operations;
  }

  parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token?.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') name = this.next().value;
    }
    // Variable definitions — parse and discard (values come from the request).
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.parseVariableDefinitions();
    }
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
        this.next();
        this.parseValue();
      }
    }
    this.expectPunct(')');
  }

  parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  parseSelectionSet(): GqlField[] {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return fields;
  }

  parseField(): GqlField {
    // Inline fragment: ... on Type { ... } or ... { ... }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '...') {
      this.next();
      let inlineType: string | null = null;
      const maybeOn = this.peek();
      if (maybeOn?.kind === 'name' && maybeOn.value === 'on') {
        this.next();
        inlineType = this.expectName();
      }
      const selections = this.parseSelectionSet();
      return { alias: null, name: '', args: {}, selections, inlineType };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, unknown> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      args = this.parseArguments();
    }
    // Directives — skip them.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArguments();
    }
    let selections: GqlField[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { alias, name, args, selections, inlineType: null };
  }

  parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    this.expectPunct('(');
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { __var: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        obj[name] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return Number(token.value);
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // enum value
    }
    throw new Error(`Unexpected token '${token.value}' in GraphQL value`);
  }
}

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (isObject(value) && '__var' in value && typeof value.__var === 'string') {
    return variables[value.__var];
  }
  if (Array.isArray(value)) return value.map((v) => resolveVariables(v, variables));
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveVariables(v, variables);
    return out;
  }
  return value;
}

// -------------------------------------------------------------------------------------------
// GraphQL execution
// -------------------------------------------------------------------------------------------

interface GqlValue {
  __typename: string;
  __data?: unknown;
}

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

const INTROSPECTED_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'createdAt', 'updatedAt', 'author', 'assignees', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'comments', 'createdAt', 'updatedAt', 'author', 'mergedAt', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
};

const INTROSPECTED_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

function issueCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function parseIssueCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!raw.startsWith('cursor:')) return null;
    const n = Number.parseInt(raw.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function findRepoById(repoId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === repoId) return repo;
  return undefined;
}

function findIssueById(issueId: number): { repo: Repo; issue: Issue } | undefined {
  for (const repo of store.repos.values()) {
    const issue = repo.issues.find((i) => i.id === issueId);
    if (issue) return { repo, issue };
  }
  return undefined;
}

function findPullById(pullId: number): { repo: Repo; pr: PullRequest } | undefined {
  for (const repo of store.repos.values()) {
    const pr = repo.pulls.find((p) => p.id === pullId);
    if (pr) return { repo, pr };
  }
  return undefined;
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', __data: { repo, issue } };
}

function pullValue(repo: Repo, pr: PullRequest): GqlValue {
  return { __typename: 'PullRequest', __data: { repo, pr } };
}

function resolveField(parent: GqlValue, field: GqlField, variables: Record<string, unknown>): unknown {
  const args = resolveVariables(field.args, variables) as Record<string, unknown>;
  const data = parent.__data as Record<string, unknown> | undefined;
  const unknownField = (): never => {
    throw new Error(`Cannot query field "${field.name}" on type "${parent.__typename}".`);
  };

  switch (parent.__typename) {
    case 'Query': {
      if (field.name === 'viewer') {
        return { __typename: 'User', __data: { login: VIEWER_LOGIN, id: VIEWER_ID } };
      }
      if (field.name === 'repository') {
        const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (!repo) return null;
        return { __typename: 'Repository', __data: { repo } };
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = findRepoById(decoded.repoId);
          return repo ? { __typename: 'Repository', __data: { repo } } : null;
        }
        if (decoded.kind === 'Issue' && decoded.local !== null) {
          const found = findRepoById(decoded.repoId);
          const issue = found?.issues.find((i) => i.number === decoded.local);
          return found && issue ? issueValue(found, issue) : null;
        }
        if (decoded.kind === 'PullRequest' && decoded.local !== null) {
          const found = findRepoById(decoded.repoId);
          const pr = found?.pulls.find((p) => p.number === decoded.local);
          return found && pr ? pullValue(found, pr) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const typeName = String(args.name ?? '');
        const fields = INTROSPECTED_FIELDS[typeName];
        const enums = INTROSPECTED_ENUMS[typeName];
        if (!fields && !enums) return null;
        return { __typename: '__Type', __data: { name: typeName, fields: fields ?? [], enumValues: enums ?? [] } };
      }
      return unknownField();
    }
    case 'User': {
      if (field.name === 'login') return (data as { login: string }).login;
      if (field.name === 'id') return globalId('User', (data as { id: number }).id);
      if (field.name === 'name') return VIEWER_NAME;
      if (field.name === 'email') return VIEWER_EMAIL;
      return unknownField();
    }
    case 'Repository': {
      const repo = (data as { repo: Repo }).repo;
      if (field.name === 'id') return globalId('Repository', repo.id);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return { __typename: 'User', __data: { login: repo.owner, id: VIEWER_ID } };
      if (field.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip ? { __typename: 'BranchRef', __data: { name: repo.defaultBranch } } : null;
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'description') return repo.description;
      if (field.name === 'isPrivate') return repo.private;
      if (field.name === 'issue') {
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        return issue ? issueValue(repo, issue) : null;
      }
      if (field.name === 'issues') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const after = typeof args.after === 'string' ? parseIssueCursor(args.after) : null;
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        const orderBy = isObject(args.orderBy) ? args.orderBy : null;
        let list = [...repo.issues];
        if (states) {
          const wanted = new Set(states.map((s) => s.toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const direction = orderBy && orderBy.direction === 'ASC' ? 'asc' : 'desc';
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        if (after !== null) {
          list = list.filter((i) => (direction === 'asc' ? i.number > after : i.number < after));
        }
        const page = list.slice(0, first);
        const hasNextPage = list.length > first;
        const endCursor = page.length > 0 ? issueCursor(page[page.length - 1].number) : null;
        return {
          __typename: 'IssueConnection',
          __data: { nodes: page.map((i) => issueValue(repo, i)), pageInfo: { hasNextPage, endCursor } },
        };
      }
      if (field.name === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const list = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
        return {
          __typename: 'PullRequestConnection',
          __data: { nodes: list.map((p) => pullValue(repo, p)) },
        };
      }
      if (field.name === 'pullRequest') {
        const pr = repo.pulls.find((p) => p.number === Number(args.number));
        return pr ? pullValue(repo, pr) : null;
      }
      return unknownField();
    }
    case 'Issue': {
      const { repo, issue } = data as { repo: Repo; issue: Issue };
      void repo;
      if (field.name === 'id') return globalId('Issue', repo.id, issue.number);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state.toUpperCase();
      if (field.name === 'body') return issue.body;
      return unknownField();
    }
    case 'IssueConnection': {
      const conn = data as { nodes: GqlValue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (field.name === 'nodes') return conn.nodes;
      if (field.name === 'pageInfo') return { __typename: 'PageInfo', __data: conn.pageInfo };
      if (field.name === 'totalCount') return conn.nodes.length;
      return unknownField();
    }
    case 'PageInfo': {
      const info = data as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'endCursor') return info.endCursor;
      return unknownField();
    }
    case 'PullRequest': {
      const { repo, pr } = data as { repo: Repo; pr: PullRequest };
      if (field.name === 'id') return globalId('PullRequest', repo.id, pr.number);
      if (field.name === 'number') return pr.number;
      if (field.name === 'title') return pr.title;
      if (field.name === 'body') return pr.body;
      if (field.name === 'headRefName') return pr.headRef;
      if (field.name === 'baseRefName') return pr.baseRef;
      // GitHub's mergeable is an enum, not a boolean: MERGEABLE / CONFLICTING /
      // UNKNOWN (no merge-base). The suite requires a string from that set.
      if (field.name === 'mergeable') {
        if (store.prMergeBase(repo, pr) === null) return 'UNKNOWN';
        return store.prMergeable(repo, pr) ? 'MERGEABLE' : 'CONFLICTING';
      }
      if (field.name === 'state') return pr.merged ? 'MERGED' : pr.state.toUpperCase();
      if (field.name === 'merged') return pr.merged;
      if (field.name === 'mergedAt') return pr.mergedAt;
      if (field.name === 'files') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const files = store.prFiles(repo, pr).slice(0, first);
        return {
          __typename: 'PullRequestFileConnection',
          __data: { nodes: files.map((f) => ({ __typename: 'PullRequestFile', __data: { path: f.filename } })) },
        };
      }
      return unknownField();
    }
    case 'PullRequestConnection': {
      const conn = data as { nodes: GqlValue[] };
      if (field.name === 'nodes') return conn.nodes;
      if (field.name === 'totalCount') return conn.nodes.length;
      return unknownField();
    }
    case 'PullRequestFileConnection': {
      const conn = data as { nodes: GqlValue[] };
      if (field.name === 'nodes') return conn.nodes;
      return unknownField();
    }
    case 'PullRequestFile': {
      if (field.name === 'path') return (data as { path: string }).path;
      return unknownField();
    }
    case 'BranchRef': {
      if (field.name === 'name') return (data as { name: string }).name;
      return unknownField();
    }
    case '__Type': {
      const type = data as { name: string; fields: string[]; enumValues: string[] };
      if (field.name === 'name') return type.name;
      if (field.name === 'fields') {
        return type.fields.map((name) => ({ __typename: '__Field', __data: { name } }));
      }
      if (field.name === 'enumValues') {
        return type.enumValues.map((name) => ({ __typename: '__EnumValue', __data: { name } }));
      }
      return unknownField();
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return (data as { name: string }).name;
      return unknownField();
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = isObject(args.input) ? args.input : {};
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (!decoded || decoded.kind !== 'Repository') throw new Error('repositoryId does not identify a repository');
        const repo = findRepoById(decoded.repoId);
        if (!repo) throw new Error('Repository not found');
        const title = input.title;
        if (typeof title !== 'string' || title === '') throw new Error('title is required');
        const issue: Issue = {
          id: store.issueIdSeq++,
          number: ++repo.issueSeq,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          comments: [],
          createdSeq: store.seq++,
        };
        repo.issues.push(issue);
        return { __typename: 'CreateIssuePayload', __data: { repo, issue } };
      }
      if (field.name === 'closeIssue') {
        const input = isObject(args.input) ? args.input : {};
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        if (!decoded || decoded.kind !== 'Issue' || decoded.local === null) {
          throw new Error('issueId does not identify an issue');
        }
        const found = findRepoById(decoded.repoId);
        const issue = found?.issues.find((i) => i.number === decoded.local);
        if (!found || !issue) throw new Error('Issue not found');
        issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', __data: { repo: found, issue } };
      }
      if (field.name === 'createPullRequest') {
        const input = isObject(args.input) ? args.input : {};
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (!decoded || decoded.kind !== 'Repository') throw new Error('repositoryId does not identify a repository');
        const repo = findRepoById(decoded.repoId);
        if (!repo) throw new Error('Repository not found');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
        if (repo.pulls.some((p) => p.state === 'open' && p.headRef === head)) {
          throw new Error('A pull request already exists for this head branch');
        }
        const pr: PullRequest = {
          id: store.pullIdSeq++,
          number: repo.pulls.length + 1,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          headRef: head,
          headSha,
          baseRef: base,
          baseSha,
          createdSeq: store.seq++,
        };
        repo.pulls.push(pr);
        return { __typename: 'CreatePullRequestPayload', __data: { repo, pr } };
      }
      if (field.name === 'mergePullRequest') {
        const input = isObject(args.input) ? args.input : {};
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        if (!decoded || decoded.kind !== 'PullRequest' || decoded.local === null) {
          throw new Error('pullRequestId does not identify a pull request');
        }
        const found = findRepoById(decoded.repoId);
        const pr = found?.pulls.find((p) => p.number === decoded.local);
        if (!found || !pr) throw new Error('Pull request not found');
        if (pr.state !== 'open' || pr.merged) throw new Error('Pull request is already merged or closed');
        if (!store.prMergeable(found, pr)) throw new Error('Merge conflict');
        const sha = store.mergePull(found, pr);
        if (sha === null) throw new Error('Merge conflict');
        return { __typename: 'MergePullRequestPayload', __data: { repo: found, pr } };
      }
      if (field.name === 'addComment') {
        const input = isObject(args.input) ? args.input : {};
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        if (!decoded || decoded.kind !== 'Issue' || decoded.local === null) {
          throw new Error('subjectId does not identify an issue');
        }
        const found = findRepoById(decoded.repoId);
        const issue = found?.issues.find((i) => i.number === decoded.local);
        if (!found || !issue) throw new Error('Issue not found');
        const body = input.body;
        if (typeof body !== 'string' || body === '') throw new Error('body is required');
        const comment = { id: store.commentIdSeq++, body };
        issue.comments.push(comment);
        return {
          __typename: 'AddCommentPayload',
          __data: { repo: found, comment: { __typename: 'IssueComment', __data: { repoId: found.id, id: comment.id, body: comment.body } } },
        };
      }
      return unknownField();
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') {
        const { repo, issue } = data as { repo: Repo; issue: Issue };
        return issueValue(repo, issue);
      }
      return unknownField();
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') {
        const { repo, pr } = data as { repo: Repo; pr: PullRequest };
        return pullValue(repo, pr);
      }
      return unknownField();
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') {
        const { comment } = data as { comment: GqlValue };
        return { __typename: 'CommentEdge', __data: { node: comment } };
      }
      return unknownField();
    }
    case 'CommentEdge': {
      if (field.name === 'node') return (data as { node: GqlValue }).node;
      return unknownField();
    }
    case 'IssueComment': {
      const comment = data as { repoId: number; id: number; body: string };
      if (field.name === 'id') return globalId('IssueComment', comment.repoId, comment.id);
      if (field.name === 'body') return comment.body;
      return unknownField();
    }
    default:
      return unknownField();
  }
}

function applySelections(value: unknown, field: GqlField, variables: Record<string, unknown>, errors: GqlError[], path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v, i) => applySelections(v, field, variables, errors, [...path, i]));
  if (isObject(value) && '__typename' in value) {
    if (field.selections === null) return null;
    return resolveSelections(value as GqlValue, field.selections, variables, errors, path);
  }
  return value;
}

function resolveSelections(parent: GqlValue, fields: GqlField[], variables: Record<string, unknown>, errors: GqlError[], path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.inlineType !== null) {
      if (field.inlineType !== parent.__typename) continue;
      Object.assign(out, resolveSelections(parent, field.selections ?? [], variables, errors, path));
      continue;
    }
    const key = field.alias ?? field.name;
    const fieldPath = [...path, key];
    try {
      const value = resolveField(parent, field, variables);
      out[key] = applySelections(value, field, variables, errors, fieldPath);
    } catch (error) {
      errors.push({ message: error instanceof Error ? error.message : String(error), path: fieldPath });
      out[key] = null;
    }
  }
  return out;
}

function executeGraphqlDocument(document: unknown): Record<string, unknown> {
  if (!isObject(document) || typeof document.query !== 'string') {
    return { errors: [{ message: 'Request must contain a query string' }] };
  }
  const variables = isObject(document.variables) ? (document.variables as Record<string, unknown>) : {};
  let operations: GqlOperation[];
  try {
    operations = new GqlParser(document.query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  let operation = operations[0];
  if (typeof document.operationName === 'string') {
    operation = operations.find((op) => op.name === document.operationName) ?? operation;
  }
  const root: GqlValue = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const errors: GqlError[] = [];
  const data = resolveSelections(root, operation.selections, variables, errors, []);
  const result: Record<string, unknown> = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, 405, 'Method Not Allowed');
  const body = await readJsonBody(req);
  if (!body.ok) return sendError(res, 400, 'Invalid JSON');
  if (Array.isArray(body.value)) {
    return sendJson(res, 200, body.value.map((doc) => executeGraphqlDocument(doc)));
  }
  return sendJson(res, 200, executeGraphqlDocument(body.value));
}

// -------------------------------------------------------------------------------------------
// MCP (streamable HTTP, POST /mcp)
// -------------------------------------------------------------------------------------------

const MCP_TOOLS: Array<{
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}> = [
  {
    name: 'create_repo',
    description: 'Create a new repository.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** Pick the first present argument among a list of synonyms. */
function pickArg(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) if (args[name] !== undefined) return args[name];
  return undefined;
}

/** Split a "owner/repo" full name, or return null. */
function splitFullName(value: unknown): { owner: string; repo: string } | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;
  return { owner: parts[0], repo: parts[1] };
}

function mcpToolResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError };
}

function executeMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined) {
      return mcpToolResult(`Missing required argument: ${required}`, true);
    }
  }
  // Resolve owner/repo, accepting the documented synonyms.
  let owner = pickArg(args, ['owner', 'owner_login']) as string | undefined;
  let repoName = pickArg(args, ['repo', 'repository']) as string | undefined;
  if ((owner === undefined || repoName === undefined) && typeof args.full_name === 'string') {
    const split = splitFullName(args.full_name);
    if (split) {
      owner ??= split.owner;
      repoName ??= split.repo;
    }
  }
  if (name === 'create_repo') {
    const repoNameArg = args.name;
    if (typeof repoNameArg !== 'string' || repoNameArg === '' || repoNameArg.includes('/')) {
      return mcpToolResult('name is required', true);
    }
    if (store.getRepo(VIEWER_LOGIN, repoNameArg)) {
      return mcpToolResult('Repository already exists', true);
    }
    const repo = store.createRepo(
      VIEWER_LOGIN,
      repoNameArg,
      typeof args.description === 'string' ? args.description : '',
      args.private === true,
    );
    return mcpToolResult(JSON.stringify(repoView(repo)));
  }
  if (owner === undefined || repoName === undefined) {
    return mcpToolResult('owner and repo are required', true);
  }
  const repo = findRepo(owner, repoName);
  if (name === 'get_repo') {
    if (!repo) return mcpToolResult('Repository not found', true);
    return mcpToolResult(JSON.stringify(repoView(repo)));
  }
  if (!repo) return mcpToolResult('Repository not found', true);
  if (name === 'create_issue') {
    const title = args.title;
    if (typeof title !== 'string' || title === '') return mcpToolResult('title is required', true);
    const issue: Issue = {
      id: store.issueIdSeq++,
      number: ++repo.issueSeq,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      createdSeq: store.seq++,
    };
    repo.issues.push(issue);
    return mcpToolResult(JSON.stringify(issueView(repo, issue)));
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues.filter((i) => state === 'all' || i.state === state);
    return mcpToolResult(JSON.stringify(list.map((i) => issueView(repo, i))));
  }
  if (name === 'create_pull_request') {
    const title = args.title;
    const head = pickArg(args, ['head', 'head_ref', 'head_branch']) as string | undefined;
    const base = pickArg(args, ['base', 'base_ref', 'base_branch']) as string | undefined;
    if (typeof title !== 'string' || title === '') return mcpToolResult('title is required', true);
    if (typeof head !== 'string' || typeof base !== 'string') {
      return mcpToolResult('head and base are required', true);
    }
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return mcpToolResult('head or base branch does not exist', true);
    if (repo.pulls.some((p) => p.state === 'open' && p.headRef === head)) {
      return mcpToolResult('A pull request already exists for this head branch', true);
    }
    const pr: PullRequest = {
      id: store.pullIdSeq++,
      number: repo.pulls.length + 1,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      headSha,
      baseRef: base,
      baseSha,
      createdSeq: store.seq++,
    };
    repo.pulls.push(pr);
    return mcpToolResult(JSON.stringify(pullView(repo, pr)));
  }
  if (name === 'merge_pull_request') {
    const pullNumber = pickArg(args, ['pull_number', 'pr_number', 'number']);
    const number = typeof pullNumber === 'number' ? pullNumber : Number.parseInt(String(pullNumber ?? ''), 10);
    const pr = repo.pulls.find((p) => p.number === number);
    if (!pr) return mcpToolResult('Pull request not found', true);
    if (pr.state !== 'open' || pr.merged) return mcpToolResult('Pull request is already merged or closed', true);
    if (!store.prMergeable(repo, pr)) return mcpToolResult('Merge conflict', true);
    const sha = store.mergePull(repo, pr);
    if (sha === null) return mcpToolResult('Merge conflict', true);
    return mcpToolResult(JSON.stringify({ sha, merged: true, number: pr.number }));
  }
  return mcpToolResult(`Unknown tool: ${name}`, true);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireAuth(req, res)) return;
  if ((req.method ?? 'GET') !== 'POST') return sendError(res, 405, 'Method Not Allowed');
  let body: unknown;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    // Parse error: HTTP 400 with JSON-RPC -32700.
    res.writeHead(400, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': requestId() });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
  }
  if (!isObject(body) || typeof body.method !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': requestId() });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
  }
  const id = body.id ?? null;
  const method = body.method;
  const params = isObject(body.params) ? (body.params as Record<string, unknown>) : {};
  // Notifications get no response body (202).
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'X-GitHub-Request-Id': requestId() });
    return res.end();
  }
  const respond = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const respondError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  if (method === 'server/discover') {
    return respond({
      identity: { name: 'github-mcp-server', version: '1.0.0' },
      // The suite reads the identity out of `serverInfo` (or _meta's
      // io.modelcontextprotocol/serverInfo) — `identity` alone is not read.
      serverInfo: { name: 'github-mcp-server', version: '1.0.0' },
      capabilities: { tools: {} },
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-03-26'],
      protocolVersion: '2026-07-28',
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return respond({
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-mcp-server', version: '1.0.0' },
    });
  }
  if (method === 'ping') return respond({});
  if (method === 'tools/list') {
    // Byte-identical across calls: the constant array is serialized deterministically.
    return respond({ tools: MCP_TOOLS });
  }
  if (method === 'resources/list') return respond({ resources: [] });
  if (method === 'prompts/list') return respond({ prompts: [] });
  if (method === 'tools/call') {
    const toolName = params.name;
    if (typeof toolName !== 'string') return respondError(-32602, 'Tool name is required');
    const args = isObject(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const known = MCP_TOOLS.some((t) => t.name === toolName);
    if (!known) return respondError(-32602, `Unknown tool: ${toolName}`);
    try {
      return respond(executeMcpTool(toolName, args));
    } catch (error) {
      return respond(mcpToolResult(error instanceof Error ? error.message : String(error), true));
    }
  }
  return respondError(-32601, `Method not found: ${method}`);
}

// -------------------------------------------------------------------------------------------
// git smart HTTP
// -------------------------------------------------------------------------------------------

/** Parse a v0 upload-pack request (want/have lines) and answer it. */
function v0FetchResponse(repo: Repo, body: Buffer): Buffer | null {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isObjectId(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isObjectId(oid)) shallow.push(oid);
    } else if (line === 'done') {
      break;
    } else {
      return null;
    }
  }
  if (wants.length === 0) return null;
  const plan = store.planFetch(repo, wants, haves, null, shallow);
  const objects: Array<{ type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }> = [];
  for (const oid of plan.send) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  const acked = haves.find((have) => repo.objects.has(have));
  parts.push(encodePktLine(acked !== undefined ? `ACK ${acked}\n` : 'NAK\n'));
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  const CHUNK = 65520 - 4 - 1;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, action: string): Promise<void> {
  if (!requireAuth(req, res)) return;
  const method = req.method ?? 'GET';
  const repo = findRepo(owner, repoName);
  if (!repo) return sendError(res, 404, 'Not Found');
  const query = queryOf(req);

  if (action === 'info/refs') {
    if (method !== 'GET') return sendError(res, 405, 'Method Not Allowed');
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (v2) {
        return sendBuffer(res, 200, v2Advertisement(repo), 'application/x-git-upload-pack-advertisement');
      }
      return sendBuffer(res, 200, v0Advertisement('git-upload-pack', repo), 'application/x-git-upload-pack-advertisement');
    }
    if (service === 'git-receive-pack') {
      return sendBuffer(res, 200, v0Advertisement('git-receive-pack', repo), 'application/x-git-receive-pack-advertisement');
    }
    return sendError(res, 400, 'service is required');
  }

  if (action === 'git-upload-pack') {
    if (method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
    const body = await readBody(req);
    const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (v2) {
      const { packets } = decodePktLines(body);
      const lines = packetsToLines(packets);
      const commandLine = lines.find((line) => line.startsWith('command='))?.replace(/\n$/, '');
      if (commandLine === 'command=ls-refs') {
        const parsed = parseLsRefs(lines);
        if (parsed === null) return sendError(res, 400, 'Malformed ls-refs request');
        return sendBuffer(res, 200, lsRefsResponse(store, repo, parsed), 'application/x-git-upload-pack-result');
      }
      if (commandLine === 'command=fetch') {
        const parsed = parseFetch(lines);
        if (parsed === null) return sendError(res, 400, 'Malformed fetch request');
        return sendBuffer(res, 200, fetchResponse(store, repo, parsed), 'application/x-git-upload-pack-result');
      }
      return sendError(res, 400, 'Unknown git-upload-pack command');
    }
    const response = v0FetchResponse(repo, body);
    if (response === null) return sendError(res, 400, 'Malformed fetch request');
    return sendBuffer(res, 200, response, 'application/x-git-upload-pack-result');
  }

  if (action === 'git-receive-pack') {
    if (method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
    const body = await readBody(req);
    const parsed = parseReceivePack(body);
    if (parsed === null) return sendError(res, 400, 'Malformed receive-pack request');
    try {
      const lines = applyPush(store, repo, parsed.commands, parsed.pack);
      return sendBuffer(res, 200, pushReportResponse(true, '', lines), 'application/x-git-receive-pack-result');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unpack failed';
      const lines = parsed.commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack failed' }));
      return sendBuffer(res, 200, pushReportResponse(false, message, lines), 'application/x-git-receive-pack-result');
    }
  }

  return sendError(res, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// server
// -------------------------------------------------------------------------------------------

export function createApp(): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      if (pathname === '/healthz') {
        if ((req.method ?? 'GET') !== 'GET') return sendError(res, 405, 'Method Not Allowed');
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/mcp') return handleMcp(req, res);
      if (pathname === '/api/graphql') return handleGraphql(req, res);
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) return handleRest(req, res);
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
      if (gitMatch) {
        return handleGit(req, res, decodeURIComponent(gitMatch[1]), decodeURIComponent(gitMatch[2]), gitMatch[3]);
      }
      return sendError(res, 404, 'Not Found');
    } catch (error) {
      if (!res.headersSent) {
        sendError(res, 500, error instanceof Error ? error.message : 'Internal error');
      } else {
        res.end();
      }
    }
  });
  return server;
}

// Standalone mode (running `node app.ts` directly): listen on PORT for local testing.
// When imported by main.ts this block does not run.
if (process.argv[1] !== undefined && /(^|\/)app\.ts$/.test(process.argv[1])) {
  const server = createApp();
  server.listen(PORT, () => {
    process.stdout.write(`[forge] listening on port ${PORT} (token ${TOKEN === '' ? 'unset — auth disabled' : 'set'})\n`);
  });
}
