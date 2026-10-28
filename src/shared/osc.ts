// Minimal OSC 1.0 encoder/decoder (messages and bundles) for VMC and VRChat OSC.

export type OscArg = number | string | boolean | Uint8Array | { type: 'i' | 'f' | 'd'; value: number };

export interface OscMessage {
  address: string;
  args: (number | string | boolean | Uint8Array)[];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function pad4(n: number) {
  return (n + 3) & ~3;
}

function readString(view: DataView, bytes: Uint8Array, offset: number): [string, number] {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end++;
  const s = textDecoder.decode(bytes.subarray(offset, end));
  return [s, pad4(end + 1)];
}

function decodeMessage(bytes: Uint8Array, out: OscMessage[]) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let [address, off] = readString(view, bytes, 0);
  if (off >= bytes.length) {
    out.push({ address, args: [] });
    return;
  }
  let tags: string;
  [tags, off] = readString(view, bytes, off);
  const args: (number | string | boolean | Uint8Array)[] = [];
  for (let i = 1; i < tags.length; i++) {
    const t = tags[i];
    switch (t) {
      case 'i': args.push(view.getInt32(off)); off += 4; break;
      case 'f': args.push(view.getFloat32(off)); off += 4; break;
      case 'd': args.push(view.getFloat64(off)); off += 8; break;
      case 'h': args.push(Number(view.getBigInt64(off))); off += 8; break;
      case 't': off += 8; break;
      case 's': case 'S': { let s: string; [s, off] = readString(view, bytes, off); args.push(s); break; }
      case 'b': {
        const n = view.getInt32(off); off += 4;
        args.push(bytes.slice(off, off + n)); off += pad4(n);
        break;
      }
      case 'T': args.push(true); break;
      case 'F': args.push(false); break;
      case 'N': case 'I': break;
      default: return out.push({ address, args });
    }
  }
  out.push({ address, args });
}

export function decodeOsc(bytes: Uint8Array, out: OscMessage[] = []): OscMessage[] {
  if (bytes.length < 4) return out;
  if (bytes[0] === 0x23 /* # */) {
    // #bundle\0 + 8-byte timetag + elements
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 16;
    while (off + 4 <= bytes.length) {
      const size = view.getInt32(off);
      off += 4;
      if (size <= 0 || off + size > bytes.length) break;
      decodeOsc(bytes.subarray(off, off + size), out);
      off += size;
    }
    return out;
  }
  if (bytes[0] === 0x2f /* / */) decodeMessage(bytes, out);
  return out;
}

// --- Encoding ---------------------------------------------------------------

class Writer {
  buf = new Uint8Array(1024);
  view = new DataView(this.buf.buffer);
  len = 0;
  ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  string(s: string) {
    const b = textEncoder.encode(s);
    const n = pad4(b.length + 1);
    this.ensure(n);
    this.buf.set(b, this.len);
    this.buf.fill(0, this.len + b.length, this.len + n);
    this.len += n;
  }
  int(v: number) { this.ensure(4); this.view.setInt32(this.len, v); this.len += 4; }
  float(v: number) { this.ensure(4); this.view.setFloat32(this.len, v); this.len += 4; }
  double(v: number) { this.ensure(8); this.view.setFloat64(this.len, v); this.len += 8; }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length; }
  result() { return this.buf.slice(0, this.len); }
}

function writeMessage(w: Writer, address: string, args: OscArg[]) {
  w.string(address);
  let tags = ',';
  for (const a of args) {
    if (typeof a === 'number') tags += 'f';
    else if (typeof a === 'string') tags += 's';
    else if (typeof a === 'boolean') tags += a ? 'T' : 'F';
    else if (a instanceof Uint8Array) tags += 'b';
    else tags += a.type;
  }
  w.string(tags);
  for (const a of args) {
    if (typeof a === 'number') w.float(a);
    else if (typeof a === 'string') w.string(a);
    else if (typeof a === 'boolean') { /* no payload */ }
    else if (a instanceof Uint8Array) { w.int(a.length); w.bytes(a); const p = pad4(a.length) - a.length; for (let i = 0; i < p; i++) w.bytes(new Uint8Array(1)); }
    else if (a.type === 'i') w.int(a.value);
    else if (a.type === 'd') w.double(a.value);
    else w.float(a.value);
  }
}

export function int(value: number): OscArg {
  return { type: 'i', value: value | 0 };
}

export function encodeMessage(address: string, args: OscArg[] = []): Uint8Array {
  const w = new Writer();
  writeMessage(w, address, args);
  return w.result();
}

/** Encodes many messages into one bundle (immediate timetag). */
export function encodeBundle(messages: [string, OscArg[]][]): Uint8Array {
  const w = new Writer();
  w.string('#bundle');
  w.int(0); w.int(1); // timetag "immediately"
  for (const [address, args] of messages) {
    const inner = new Writer();
    writeMessage(inner, address, args);
    w.int(inner.len);
    w.bytes(inner.buf.subarray(0, inner.len));
  }
  return w.result();
}

/** Splits messages into several bundles that stay below a safe UDP size. */
export function encodeBundles(messages: [string, OscArg[]][], maxBytes = 8000): Uint8Array[] {
  const out: Uint8Array[] = [];
  let chunk: [string, OscArg[]][] = [];
  let estimate = 16;
  for (const m of messages) {
    const size = m[0].length + 8 + m[1].length * 8 + 32;
    if (estimate + size > maxBytes && chunk.length) {
      out.push(encodeBundle(chunk));
      chunk = [];
      estimate = 16;
    }
    chunk.push(m);
    estimate += size;
  }
  if (chunk.length) out.push(encodeBundle(chunk));
  return out;
}
