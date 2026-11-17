// gitobj.ts — the git object model, pkt-line framing and packfile codecs.
// Node 22 standard library only. Erasable TypeScript (no enums, no namespaces,
// no parameter properties) so `node --experimental-strip-types` can run it.
import { createHash } from 'node:crypto';
import { inflateSync as zlibInflateSync, deflateSync as zlibDeflateSync } from 'node:zlib';

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = zlibInflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// -------------------------------------------------------------------------------------------
// trees and commits
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error('tag header has no value');
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
  timezone?: string;
}): Buffer {
  const timezone = fields.timezone ?? '+0000';
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} ${timezone}`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} ${timezone}`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Every object reachable from `roots`. Throws on a missing object. */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// -------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------

export type GitPacket =
  | { kind: 'data'; payload: Buffer; raw: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload is too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a complete buffer into packets. `allowRawTail` leaves trailing non-framed bytes alone. */
export function decodePktLines(bytes: Buffer): { packets: GitPacket[]; rawTail: Buffer } {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX || offset + length > bytes.length) break;
    const raw = bytes.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw });
    offset += length;
  }
  return { packets, rawTail: bytes.subarray(offset) };
}

/** The decoded text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// -------------------------------------------------------------------------------------------
// packfiles (plain objects only — the suite's client never sends deltas)
// -------------------------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile (version 2) from plain objects. Trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(zlibDeflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  declaredCount: number;
  version: number;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  declaredCount: number;
  version: number;
  deltaCount: number;
}

/** Read a delta's size varint (7-bit little-endian, high bit = continue). */
function readDeltaVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    if (i >= data.length) throw new Error('delta varint is truncated');
    const byte = data[i];
    value |= (byte & 0x7f) << shift;
    shift += 7;
    i += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: i };
}

/** Apply a git delta to its base bytes. Throws on size mismatches or bad opcodes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const srcSize = readDeltaVarint(delta, 0);
  if (srcSize.value !== base.length) {
    throw new Error(`delta source size ${srcSize.value} does not match base length ${base.length}`);
  }
  const tgtSize = readDeltaVarint(delta, srcSize.next);
  const out: Buffer[] = [];
  let total = 0;
  let i = tgtSize.next;
  while (i < delta.length) {
    const opcode = delta[i];
    i += 1;
    if (opcode & 0x80) {
      let offset = 0;
      let size = 0;
      if (opcode & 0x01) offset = delta[i++];
      if (opcode & 0x02) offset |= delta[i++] << 8;
      if (opcode & 0x04) offset |= delta[i++] << 16;
      if (opcode & 0x08) offset |= delta[i++] << 24;
      if (opcode & 0x10) size = delta[i++];
      if (opcode & 0x20) size |= delta[i++] << 8;
      if (opcode & 0x40) size |= delta[i++] << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past the base');
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (opcode !== 0) {
      if (i + opcode > delta.length) throw new Error('delta insert runs past the delta');
      out.push(delta.subarray(i, i + opcode));
      total += opcode;
      i += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (total !== tgtSize.value) {
    throw new Error(`delta target size ${tgtSize.value} does not match produced ${total} bytes`);
  }
  return Buffer.concat(out);
}

/** Read the OFS_DELTA base offset (the special ((v+1)<<7)|b encoding). */
function readOfsDeltaBase(pack: Buffer, offset: number): { baseOffset: number; next: number } {
  let byte = pack[offset];
  let value = byte & 0x7f;
  let next = offset + 1;
  while (byte & 0x80) {
    if (next >= pack.length) throw new Error('OFS_DELTA base offset is truncated');
    byte = pack[next++];
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset: value, next };
}

interface PackEntry {
  /** Offset of the entry's type+size header in the pack. */
  entryOffset: number;
  typeCode: number;
  /** Inflated size the entry declares. */
  size: number;
  /** For OFS_DELTA: the base's entry offset. For REF_DELTA: the base's oid. */
  baseOffset: number | null;
  baseOid: string | null;
  /** Inflated bytes (plain object data, or delta data for deltas). */
  data: Buffer;
}

/**
 * Read a packfile, resolving OFS_DELTA and REF_DELTA entries (including chains of
 * deltas). A REF_DELTA base that is not in the pack is resolved through `resolveBase`
 * (thin packs); without one, a missing base is an error. Throws on corruption.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer does not match its bytes');
  // First pass: inflate every entry, remembering where each one starts.
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, number>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    let baseOffset: number | null = null;
    let baseOid: string | null = null;
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      baseOffset = entryOffset - base.baseOffset;
      offset = base.next;
    } else if (typeCode === 7) {
      if (offset + 20 > pack.length) throw new Error('REF_DELTA base oid is truncated');
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    offset = inflated.next;
    byOffset.set(entryOffset, index);
    entries.push({ entryOffset, typeCode, size: header.size, baseOffset, baseOid, data: inflated.data });
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  // Second pass: resolve each entry to a full object (deltas may chain).
  const objects = new Map<string, GitObject>();
  const resolved = new Map<number, GitObject>();
  let deltaCount = 0;
  const resolveEntry = (index: number, seen: Set<number>): GitObject => {
    const cached = resolved.get(index);
    if (cached) return cached;
    if (seen.has(index)) throw new Error('delta chain is circular');
    seen.add(index);
    const entry = entries[index];
    let object: GitObject;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      deltaCount += 1;
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseIndex = byOffset.get(entry.baseOffset!);
        if (baseIndex === undefined) throw new Error(`OFS_DELTA base offset ${entry.baseOffset} is not in the pack`);
        base = resolveEntry(baseIndex, seen);
      } else {
        // REF_DELTA: the base may already be resolved in this pack, or on the server
        // (thin pack), or in an entry later in this pack — resolve entries until it
        // turns up. `seen` is shared so a genuine cycle is still caught.
        base = objects.get(entry.baseOid!);
        if (!base && resolveBase) base = resolveBase(entry.baseOid!);
        if (!base) {
          for (let i = 0; i < entries.length; i += 1) {
            if (resolved.has(i)) continue;
            resolveEntry(i, seen);
            base = objects.get(entry.baseOid!);
            if (base) break;
          }
        }
        if (!base) throw new Error(`REF_DELTA base ${entry.baseOid} is not available`);
      }
      const data = applyDelta(base.data, entry.data);
      object = { type: base.type, data };
    } else {
      object = { type: CODE_TYPE[entry.typeCode], data: entry.data };
    }
    seen.delete(index);
    resolved.set(index, object);
    const oid = hashObject(object.type, object.data);
    if (!objects.has(oid)) objects.set(oid, object);
    return object;
  };
  for (let index = 0; index < entries.length; index += 1) resolveEntry(index, new Set());
  return { objects, declaredCount, version, deltaCount };
}
