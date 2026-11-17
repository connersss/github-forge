// githttp.ts — git smart HTTP: info/refs advertisements (v2 upload-pack, v0 both
// services), protocol v2 ls-refs and fetch, and v0 receive-pack (push).
import {
  PKT_LINE_MAX,
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isObjectId,
  parseTag,
  pktLineDelim,
  pktLineFlush,
  readPack,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { DEFAULT_BRANCH, VIEWER_LOGIN, type Repo, type Store } from './store.ts';

export interface GitRequest {
  owner: string;
  repo: string;
  service: 'git-upload-pack' | 'git-receive-pack';
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface RefLine {
  oid: string;
  name: string;
}

/** All refs of a repo, sorted, with HEAD first (HEAD is synthetic, not stored). */
export function listRefs(repo: Repo): RefLine[] {
  const refs: RefLine[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    refs.push({ oid: repo.refs.get(name)!, name });
  }
  return refs;
}

/** Peel an annotated tag ref to its target commit (following tag objects). */
export function peelRef(store: Store, repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type !== 'tag') return current;
    if (seen.has(current)) return null;
    seen.add(current);
    current = parseTag(object.data).object;
  }
}

function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

/** The v0 advertisement body for a service. */
export function v0Advertisement(
  service: 'git-upload-pack' | 'git-receive-pack',
  repo: Repo,
): Buffer {
  const refs = listRefs(repo);
  const capabilities =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta multi_ack`
      : `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Buffer[] = [];
  parts.push(encodePktLine(`# service=${service}\n`));
  parts.push(pktLineFlush());
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    const head = headOid(repo);
    parts.push(encodePktLine(`${head} HEAD\0${capabilities}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      // Peeled line for annotated tags.
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag') {
        const peeled = parseTag(object.data).object;
        parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement body for upload-pack. */
export function v2Advertisement(repo: Repo): Buffer {
  void repo;
  const parts: Buffer[] = [];
  parts.push(encodePktLine('# service=git-upload-pack\n'));
  parts.push(pktLineFlush());
  parts.push(encodePktLine('version 2\n'));
  parts.push(encodePktLine('fetch=shallow filter\n'));
  parts.push(encodePktLine('ls-refs=unborn\n'));
  parts.push(encodePktLine('object-format=sha1\n'));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// protocol v2: ls-refs
// -------------------------------------------------------------------------------------------

export interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Parse a v2 ls-refs request body (pkt-lines). Returns null on a malformed body. */
export function parseLsRefs(lines: string[]): LsRefsRequest | null {
  let command = '';
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === '') continue;
    if (line.startsWith('command=')) command = line.slice('command='.length);
    else if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    else return null;
  }
  if (command !== 'ls-refs') return null;
  return { peel, symrefs, unborn, prefixes };
}

/** Answer a v2 ls-refs request. */
export function lsRefsResponse(store: Store, repo: Repo, req: LsRefsRequest): Buffer {
  const refs = listRefs(repo);
  const keep = (name: string): boolean =>
    req.prefixes.length === 0 || req.prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = headOid(repo);
  if (keep('HEAD') && (refs.length > 0 || req.unborn)) {
    if (refs.length === 0) {
      parts.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else {
      parts.push(encodePktLine(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (req.symrefs && ref.name === `refs/heads/${repo.defaultBranch}`) {
      // HEAD's symref is reported on the HEAD line, not on the branch.
    }
    if (req.peel) {
      const object = repo.objects.get(ref.oid);
      if (object && object.type === 'tag') {
        const peeled = peelRef(store, repo, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    parts.push(encodePktLine(`${line}\n`));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// protocol v2: fetch
// -------------------------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  includeTag: boolean;
  /** Real git's `deepen-relative`: the deepen value is added to the shallow boundary. */
  deepenRelative: boolean;
  done: boolean;
}

/** Parse a v2 fetch request body (pkt-lines). Returns null on a malformed body. */
export function parseFetch(lines: string[]): FetchRequest | null {
  let command = '';
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenSince: number | null = null;
  const deepenNot: string[] = [];
  let includeTag = false;
  let deepenRelative = false;
  let done = false;
  let inArguments = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === '') continue;
    if (line.startsWith('command=')) {
      command = line.slice('command='.length);
      continue;
    }
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    inArguments = true;
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta' || line === 'include-tag' || line === 'deepen-relative') {
      if (line === 'include-tag') includeTag = true;
      if (line === 'deepen-relative') deepenRelative = true;
      continue;
    }
    else if (line.startsWith('filter ')) continue;
    else if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-since ')) deepenSince = Number.parseInt(line.slice(13).trim(), 10);
    else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11).trim());
    else if (line === 'done') done = true;
    else return null;
  }
  void inArguments;
  if (command !== 'fetch') return null;
  if (wants.some((w) => !isObjectId(w))) return null;
  if (haves.some((h) => !isObjectId(h))) return null;
  if (depth !== null && (!Number.isFinite(depth) || depth < 0)) return null;
  return { wants, haves, shallow, depth, deepenSince, deepenNot, includeTag, deepenRelative, done };
}

/** Answer a v2 fetch request: acknowledgments, shallow-info, packfile (sideband band 1). */
export function fetchResponse(
  store: Store,
  repo: Repo,
  req: FetchRequest,
): Buffer {
  const plan = store.planFetch(repo, req.wants, req.haves, req.depth, req.shallow, req.includeTag, req.deepenRelative);
  const objects: GitObject[] = [];
  for (const oid of plan.send) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  // Sections are separated by DELIM packets (0001); only the last section ends with a
  // flush (0000). A flush between sections ends the whole response early for real git.
  // (The kit's client treats delim and flush the same way here, so this is safe for both.)
  //
  // The acknowledgments section is a negotiation round, and it appears ONLY when the
  // client has not finished sending haves (no `done` line). When the client sends
  // `done` — which the kit's client always does, and real git does once it has
  // exhausted its haves — the negotiation is complete and the server sends the pack
  // directly with no acknowledgments section at all (verified against real git
  // http-backend). When `done` is absent and haves were sent:
  //   - a common commit exists: ACK it and send `ready`, then the pack in this response;
  //   - no common commit: NAK alone, ending the response, so the client sends more
  //     haves in a new request.
  const negotiating = !req.done && req.haves.length > 0;
  if (negotiating) {
    const acked = req.haves.filter((have) => repo.objects.has(have));
    parts.push(encodePktLine('acknowledgments\n'));
    if (acked.length > 0) {
      for (const oid of acked) parts.push(encodePktLine(`ACK ${oid}\n`));
      parts.push(encodePktLine('ready\n'));
      parts.push(pktLineDelim());
    } else {
      parts.push(encodePktLine('NAK\n'));
      parts.push(pktLineFlush());
      return Buffer.concat(parts);
    }
  }
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  // packfile (sideband band 1, chunked to the pkt-line maximum)
  parts.push(encodePktLine('packfile\n'));
  const CHUNK = PKT_LINE_MAX - 4 - 1; // payload room minus the band byte
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(encodePktLine(payload));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// receive-pack (push)
// -------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Parse a receive-pack request: command lines up to the first flush, then the pack bytes. */
export function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } | null {
  const { packets, rawTail } = decodePktLines(body);
  const lines: string[] = [];
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (!sawFlush || lines.length === 0) return null;
  const commands: PushCommand[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].replace(/\n$/, '');
    if (i === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts;
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, pack: rawTail };
}

/**
 * Apply a push: store the pack's objects, then apply each command with fast-forward
 * rules. Returns the report lines in command order.
 */
export function applyPush(store: Store, repo: Repo, commands: PushCommand[], pack: Buffer): PushReportLine[] {
  // Unpack first: objects land in the store even when a ref update is refused.
  // Deltas resolve against the pack itself and, for thin packs, against objects
  // already in this repo.
  if (pack.length > 0) {
    const read = readPack(pack, (oid) => repo.objects.get(oid));
    for (const [oid, object] of read.objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const lines: PushReportLine[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    const isTag = command.ref.startsWith('refs/tags/');
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        lines.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        lines.push({ ref: command.ref, ok: false, reason: 'stale old value' });
      } else {
        repo.refs.delete(command.ref);
        lines.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const object = repo.objects.get(command.newOid);
    if (!object) {
      lines.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (current === undefined) {
      // Create.
      if (command.oldOid !== ZERO_OID) {
        lines.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      lines.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    // Update of an existing ref.
    if (command.oldOid !== current) {
      lines.push({ ref: command.ref, ok: false, reason: 'stale old value' });
      continue;
    }
    if (isTag) {
      lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (object.type !== 'commit') {
      lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!store.isAncestor(repo, current, command.newOid)) {
      lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push({ ref: command.ref, ok: true, reason: '' });
  }
  return lines;
}

/**
 * The report-status stream. Real git puts the WHOLE report — the `unpack` line, the
 * per-ref `ok`/`ng` lines AND a terminating flush — inside the sideband band-1 payload
 * (one outer pkt-line when it fits), then sends one outer flush. The inner flush is what
 * terminates the client's report read: without it the client reads past the last line,
 * hits EOF and reports "the remote end hung up unexpectedly".
 */
export function pushReportResponse(unpackOk: boolean, unpackDetail: string, lines: PushReportLine[]): Buffer {
  const inner: Buffer[] = [];
  inner.push(encodePktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`));
  for (const line of lines) {
    inner.push(encodePktLine(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`));
  }
  inner.push(pktLineFlush());
  const innerStream = Buffer.concat(inner);
  const parts: Buffer[] = [];
  const CHUNK = PKT_LINE_MAX - 4 - 1; // payload room minus the band byte
  for (let offset = 0; offset < innerStream.length; offset += CHUNK) {
    const slice = innerStream.subarray(offset, Math.min(offset + CHUNK, innerStream.length));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

export const CONTENT_TYPES = {
  uploadAdvertisement: UPLOAD_AD,
  uploadResult: UPLOAD_RESULT,
  receiveAdvertisement: RECEIVE_AD,
  receiveResult: RECEIVE_RESULT,
};

export { DEFAULT_BRANCH, VIEWER_LOGIN };
