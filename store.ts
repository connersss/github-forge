// store.ts — the forge's in-memory store: repositories, git objects, refs, issues,
// pull requests, labels and comments. Everything is deterministic: server-generated
// commits use a fixed timestamp and a fixed identity, so two trials fed the same
// requests produce the same bytes.
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const DEFAULT_BRANCH = 'main';
/** Fixed timestamp for every server-generated commit (2025-01-01T00:00:00Z). */
export const FIXED_TIMESTAMP = 1735689600;
export const FIXED_ISO = '2025-01-01T00:00:00Z';
const SERVER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Array<{ id: number; body: string }>;
  createdSeq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, { name: string; color: string }>;
  issueSeq: number;
  commentSeq: number;
}

/** A flattened tree: path -> { mode, oid }. */
export type FlatTree = Map<string, { mode: string; oid: string }>;

/** The outcome of a three-way merge. */
export interface MergeOutcome {
  conflict: boolean;
  conflictPaths: string[];
  mergedTree: FlatTree;
}

/** The result of planning a fetch. */
export interface FetchPlan {
  /** Objects to send (oids), in a deterministic order. */
  send: string[];
  /** New shallow boundary commits (depth-limited fetches). */
  shallow: string[];
  /** Commits that were shallow and are now fully present. */
  unshallow: string[];
}

export class Store {
  repos = new Map<string, Repo>(); // key `${owner}/${name}`
  repoIdSeq = 5000;
  issueIdSeq = 10000;
  pullIdSeq = 30000;
  commentIdSeq = 20000;
  seq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.repoIdSeq++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.seq++,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      issueSeq: 0,
      commentSeq: 0,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // -----------------------------------------------------------------------------------------
  // git objects
  // -----------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Flatten a tree object (recursively) into path -> entry. */
  flattenTree(repo: Repo, treeOid: string, prefix: string, out: FlatTree): void {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') throw new Error(`tree ${treeOid} is missing`);
    for (const entry of parseTree(tree.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        this.flattenTree(repo, entry.oid, path, out);
      } else {
        out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    }
  }

  /** The flattened tree of a commit, or an empty map for an unborn branch. */
  treeOfCommit(repo: Repo, commitOid: string | null): FlatTree {
    const out: FlatTree = new Map();
    if (commitOid === null || commitOid === ZERO_OID) return out;
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') throw new Error(`commit ${commitOid} is missing`);
    this.flattenTree(repo, parseCommit(commit.data).tree, '', out);
    return out;
  }

  /** Rebuild tree objects from a flat map; returns the root tree oid. */
  buildTreeFromFlat(repo: Repo, flat: FlatTree): string {
    type Node = {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Node>;
    };
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of [...flat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i];
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit on top of `parents` with the given flat tree. Returns the commit oid. */
  makeCommit(repo: Repo, flat: FlatTree, message: string, parents: string[]): string {
    const tree = this.buildTreeFromFlat(repo, flat);
    const data = buildCommit({
      tree,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: SERVER_IDENTITY,
      committer: SERVER_IDENTITY,
      timestamp: FIXED_TIMESTAMP,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** The tip commit of a ref, or null when the ref does not exist / is unborn. */
  refTip(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (!oid || oid === ZERO_OID) return null;
    return oid;
  }

  /** All ancestors of a commit (including itself), as a map oid -> depth (generation). */
  ancestors(repo: Repo, tip: string): Map<string, number> {
    const depths = new Map<string, number>();
    const queue: Array<[string, number]> = [[tip, 0]];
    while (queue.length) {
      const [oid, depth] = queue.pop()!;
      const known = depths.get(oid);
      if (known !== undefined && known <= depth) continue;
      depths.set(oid, depth);
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
      } else if (object.type === 'tag') {
        queue.push([parseTag(object.data).object, depth + 1]);
      }
    }
    return depths;
  }

  /** The merge-base of two commits: the common ancestor with the smallest max depth. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aAnc = this.ancestors(repo, a);
    const bAnc = this.ancestors(repo, b);
    let best: string | null = null;
    let bestDepth = Infinity;
    for (const [oid, da] of aAnc) {
      const db = bAnc.get(oid);
      if (db === undefined) continue;
      const depth = Math.max(da, db);
      if (depth < bestDepth) {
        bestDepth = depth;
        best = oid;
      }
    }
    return best;
  }

  /** True when `ancestor` is reachable from `tip` (or equal to it). */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    return this.ancestors(repo, tip).has(ancestor);
  }

  // -----------------------------------------------------------------------------------------
  // three-way merge (squash) and diff
  // -----------------------------------------------------------------------------------------

  /** Three-way merge of flat trees. Returns the merged tree and whether it conflicts. */
  threeWayMerge(base: FlatTree, ours: FlatTree, theirs: FlatTree): MergeOutcome {
    const merged: FlatTree = new Map(ours);
    const conflictPaths: string[] = [];
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const same = (x: { mode: string; oid: string } | undefined, y: { mode: string; oid: string } | undefined): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode);
      const oursChanged = !same(b, o);
      const theirsChanged = !same(b, t);
      if (!oursChanged && !theirsChanged) continue;
      if (oursChanged && !theirsChanged) continue; // keep ours
      if (!oursChanged && theirsChanged) {
        if (t === undefined) merged.delete(path);
        else merged.set(path, t);
        continue;
      }
      // Both changed.
      if (same(o, t)) continue; // changed identically
      conflictPaths.push(path);
    }
    return { conflict: conflictPaths.length > 0, conflictPaths, mergedTree: merged };
  }

  /** Line counts for a diff between two blobs (LCS on lines). */
  lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const oldLines = splitLines(oldText);
    const newLines = splitLines(newText);
    // LCS length via DP; files here are small (a few KB), so O(n*m) is fine.
    const n = oldLines.length;
    const m = newLines.length;
    if (n === 0) return { additions: m, deletions: 0 };
    if (m === 0) return { additions: 0, deletions: n };
    const dp = new Array<number>(m + 1).fill(0);
    for (let i = 1; i <= n; i += 1) {
      let prev = 0;
      for (let j = 1; j <= m; j += 1) {
        const tmp = dp[j];
        if (oldLines[i - 1] === newLines[j - 1]) dp[j] = prev + 1;
        else dp[j] = Math.max(dp[j], dp[j - 1]);
        prev = tmp;
      }
    }
    const lcs = dp[m];
    return { additions: m - lcs, deletions: n - lcs };
  }

  /** Diff two flat trees: one entry per changed path. */
  diffTrees(oldTree: FlatTree, newTree: FlatTree, repo: Repo): Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed';
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const out: Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set<string>([...oldTree.keys(), ...newTree.keys()]);
    for (const path of [...paths].sort()) {
      const o = oldTree.get(path);
      const n = newTree.get(path);
      if (o && n && o.oid === n.oid) continue;
      const oldText = o ? blobText(repo, o.oid) : '';
      const newText = n ? blobText(repo, n.oid) : '';
      const { additions, deletions } = this.lineDiff(oldText, newText);
      const status = !o ? 'added' : !n ? 'removed' : 'modified';
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  // -----------------------------------------------------------------------------------------
  // pull requests
  // -----------------------------------------------------------------------------------------

  /** The merge-base tree of a PR (base tip vs head tip), or null when unresolvable. */
  prMergeBase(repo: Repo, pr: PullRequest): string | null {
    return this.mergeBase(repo, this.prBaseTip(repo, pr), pr.headSha);
  }

  /**
   * The current tip of a PR's base branch. The stored baseSha is the tip at creation
   * time; the branch moves when other PRs merge, and mergeability must be judged
   * against the current tip — otherwise a PR created before a conflicting merge
   * would merge cleanly and silently overwrite it.
   */
  prBaseTip(repo: Repo, pr: PullRequest): string {
    return repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  }

  /** Whether a PR can merge cleanly (no three-way conflict). */
  prMergeable(repo: Repo, pr: PullRequest): boolean {
    const base = this.prMergeBase(repo, pr);
    if (base === null) return false;
    const baseTree = this.treeOfCommit(repo, base);
    const oursTree = this.treeOfCommit(repo, this.prBaseTip(repo, pr));
    const theirsTree = this.treeOfCommit(repo, pr.headSha);
    return !this.threeWayMerge(baseTree, oursTree, theirsTree).conflict;
  }

  /** The changed files of a PR: diff(merge-base tree, head tree). */
  prFiles(repo: Repo, pr: PullRequest): Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed';
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const base = this.prMergeBase(repo, pr);
    const baseTree = base === null ? new Map() : this.treeOfCommit(repo, base);
    const headTree = this.treeOfCommit(repo, pr.headSha);
    return this.diffTrees(baseTree, headTree, repo);
  }

  /** Perform a squash merge. Returns the merge commit sha, or null on conflict. */
  mergePull(repo: Repo, pr: PullRequest): string | null {
    const base = this.prMergeBase(repo, pr);
    if (base === null) return null;
    const baseTip = this.prBaseTip(repo, pr);
    const baseTree = this.treeOfCommit(repo, base);
    const oursTree = this.treeOfCommit(repo, baseTip);
    const theirsTree = this.treeOfCommit(repo, pr.headSha);
    const { conflict, mergedTree } = this.threeWayMerge(baseTree, oursTree, theirsTree);
    if (conflict) return null;
    const sha = this.makeCommit(repo, mergedTree, pr.title, [baseTip]);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_ISO;
    pr.mergeCommitSha = sha;
    pr.baseSha = sha;
    return sha;
  }

  // -----------------------------------------------------------------------------------------
  // fetch computation (shared by git fetch and clone)
  // -----------------------------------------------------------------------------------------

  /**
   * Plan a fetch: objects reachable from `wants` minus objects reachable from `haves`,
   * optionally limited to `depth` generations from the wants. `clientShallow` is the
   * client's current shallow boundary (its parents are NOT held, even though the
   * boundary commit itself is). With `includeTag`, tag objects that point at a commit
   * being sent are sent too (real git's `include-tag`). With `deepenRelative` (real
   * git's `deepen-relative`), `depth` is added to the shallow boundary's distance
   * from the wants instead of being an absolute limit from the wants.
   */
  planFetch(
    repo: Repo,
    wants: string[],
    haves: string[],
    depth: number | null,
    clientShallow: string[],
    includeTag = false,
    deepenRelative = false,
  ): FetchPlan {
    // Commits reachable from wants, with distance (0 = the want itself). The walk is
    // unlimited; the depth limit is applied when filtering, so a deepen-relative
    // request can still measure how far the shallow boundary is from the wants.
    const wantDist = new Map<string, number>();
    const queue: Array<[string, number]> = [];
    for (const want of wants) {
      if (!repo.objects.has(want)) continue;
      queue.push([want, 0]);
    }
    while (queue.length) {
      const [oid, dist] = queue.pop()!;
      const known = wantDist.get(oid);
      if (known !== undefined && known <= dist) continue;
      wantDist.set(oid, dist);
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push([parent, dist + 1]);
      } else if (object.type === 'tag') {
        queue.push([parseTag(object.data).object, dist]);
      }
    }
    // The effective depth limit. With deepen-relative, the deepen value is added to
    // the shallow boundary's depth: the boundary commit is at some distance from the
    // wants, and the client already holds that many generations plus the boundary
    // itself (distance + 1). Real git: depth-1 clone + deepen 2 = depth 3.
    let effectiveDepth = depth;
    if (depth !== null && deepenRelative) {
      let maxBoundaryDist = 0;
      for (const boundary of clientShallow) {
        const dist = wantDist.get(boundary);
        if (dist !== undefined && dist > maxBoundaryDist) maxBoundaryDist = dist;
      }
      effectiveDepth = maxBoundaryDist + 1 + depth;
    }
    // Objects the client already has: full reachability from the haves, except that the
    // ancestors of a shallow boundary are NOT held (the client has the boundary commit
    // itself, but not its parents).
    const haveSet = new Set<string>();
    for (const have of haves) {
      if (!repo.objects.has(have)) continue;
      try {
        for (const oid of collectReachable([have], (o) => repo.objects.get(o))) haveSet.add(oid);
      } catch {
        haveSet.add(have);
      }
    }
    for (const boundary of clientShallow) {
      const object = repo.objects.get(boundary);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        try {
          for (const oid of collectReachable([parent], (o) => repo.objects.get(o))) haveSet.delete(oid);
        } catch {
          haveSet.delete(parent);
        }
      }
    }
    // Included commits: distance below the depth limit (or all, when no limit).
    const included = [...wantDist.entries()]
      .filter(([, dist]) => effectiveDepth === null || dist < effectiveDepth)
      .map(([oid]) => oid);
    // Send: each included commit plus its tree closure (trees and blobs, never parents),
    // minus what the client holds. Tag wants contribute their target's closure.
    const send = new Set<string>();
    const addTreeClosure = (treeOid: string): void => {
      const stack = [treeOid];
      while (stack.length) {
        const oid = stack.pop()!;
        if (send.has(oid) || haveSet.has(oid)) continue;
        const object = repo.objects.get(oid);
        if (!object) continue;
        send.add(oid);
        if (object.type === 'tree') {
          for (const entry of parseTree(object.data)) stack.push(entry.oid);
        }
      }
    };
    for (const oid of included) {
      if (haveSet.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      send.add(oid);
      if (object.type === 'commit') addTreeClosure(parseCommit(object.data).tree);
      else if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        const targetObject = repo.objects.get(target);
        if (targetObject) {
          if (!haveSet.has(target)) send.add(target);
          if (targetObject.type === 'commit') addTreeClosure(parseCommit(targetObject.data).tree);
          else if (targetObject.type === 'tree') addTreeClosure(target);
        }
      }
    }
    // With a depth limit, the boundary commits are the included commits at distance
    // depth-1 whose parents were cut (or whose parents are not included).
    const shallow: string[] = [];
    const unshallow: string[] = [];
    if (effectiveDepth !== null) {
      for (const oid of included) {
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        const dist = wantDist.get(oid) ?? 0;
        const parents = parseCommit(object.data).parents;
        if (parents.length === 0) continue;
        if (haveSet.has(oid)) continue;
        const cut = dist >= effectiveDepth - 1 || parents.some((p) => !wantDist.has(p) || (wantDist.get(p) ?? 0) >= effectiveDepth);
        if (cut) shallow.push(oid);
      }
      // A client shallow commit whose parents are now all present is no longer shallow.
      for (const boundary of clientShallow) {
        const object = repo.objects.get(boundary);
        if (!object || object.type !== 'commit') continue;
        const parents = parseCommit(object.data).parents;
        if (parents.length === 0) continue;
        if (parents.every((p) => send.has(p) || haveSet.has(p))) unshallow.push(boundary);
      }
    }
    // With include-tag, send tag objects that point at a commit being sent.
    if (includeTag) {
      for (const [refName, refOid] of repo.refs) {
        if (!refName.startsWith('refs/tags/')) continue;
        const tagObject = repo.objects.get(refOid);
        if (!tagObject || tagObject.type !== 'tag') continue;
        let target = parseTag(tagObject.data).object;
        for (let i = 0; i < 8; i += 1) {
          const next = repo.objects.get(target);
          if (!next) break;
          if (next.type === 'commit') {
            if (send.has(target)) send.add(refOid);
            break;
          }
          if (next.type === 'tag') target = parseTag(next.data).object;
          else break;
        }
      }
    }
    // Deterministic order: commits first (by distance, then oid), then the rest by oid.
    const ordered = [...send].sort((a, b) => {
      const da = wantDist.get(a) ?? 999;
      const db = wantDist.get(b) ?? 999;
      if (da !== db) return da - db;
      return a < b ? -1 : 1;
    });
    return { send: ordered, shallow: [...new Set(shallow)].sort(), unshallow: [...new Set(unshallow)].sort() };
  }
}

/** Split text into lines the way a diff counts them (a trailing newline makes no extra line). */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The text of a blob object (empty string when missing — treated as absent). */
export function blobText(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}
