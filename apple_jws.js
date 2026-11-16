/* Verifies a StoreKit 2 / App Store Server signed payload (JWS) without
 * calling Apple: the header's x5c chain must end in Apple Root CA - G3
 * (pinned by SHA-256), each certificate must be signed by the next, the leaf
 * and intermediate must carry Apple's App Store marker OIDs and be in date,
 * and the JWS itself must be signed by the leaf. WebCrypto only.
 *
 * `rootSha256` overrides the pin for tests (tools/wrangler.test.toml), which
 * sign with a throwaway chain of their own.
 */

export const APPLE_ROOT_G3_SHA256 =
  "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179";

// 1.2.840.113635.100.6.11.1 — App Store receipt signing (leaf).
const OID_LEAF = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, 0x0b, 0x01];
// 1.2.840.113635.100.6.2.1 — Apple WWDR intermediate.
const OID_INTERMEDIATE = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06, 0x02, 0x01];
const OID_P256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const OID_P384 = [0x2b, 0x81, 0x04, 0x00, 0x22];
const OID_ECDSA_SHA256 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const OID_ECDSA_SHA384 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03];

export class JwsError extends Error {}

export async function verifyAppleJws(jws, { rootSha256 = APPLE_ROOT_G3_SHA256, now = new Date() } = {}) {
  if (typeof jws !== "string") throw new JwsError("not a JWS");
  const parts = jws.split(".");
  if (parts.length !== 3) throw new JwsError("not a compact JWS");
  const [h, p, s] = parts;
  let header;
  try {
    header = JSON.parse(utf8(b64url(h)));
  } catch {
    throw new JwsError("bad header");
  }
  if (header.alg !== "ES256") throw new JwsError("alg must be ES256");
  if (!Array.isArray(header.x5c) || header.x5c.length !== 3) throw new JwsError("x5c must hold 3 certificates");
  const ders = header.x5c.map(b64);
  if ((await sha256hex(ders[2])) !== rootSha256.toLowerCase()) throw new JwsError("chain does not end in the pinned root");

  const [leaf, intermediate, root] = ders.map(parseCert);
  if (!contains(ders[0], OID_LEAF)) throw new JwsError("leaf is not an App Store signing certificate");
  if (!contains(ders[1], OID_INTERMEDIATE)) throw new JwsError("intermediate is not Apple's");
  for (const cert of [leaf, intermediate]) {
    if (now < cert.notBefore || now > cert.notAfter) throw new JwsError("certificate out of date");
  }
  await verifyCertSignature(leaf, intermediate);
  await verifyCertSignature(intermediate, root);

  const key = await importKey(leaf);
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new JwsError("signature does not verify");
  try {
    return JSON.parse(utf8(b64url(p)));
  } catch {
    throw new JwsError("bad payload");
  }
}

/* ---------- certificates ---------- */

function parseCert(der) {
  const cert = tlv(der, 0);
  const [tbs, sigAlg, sig] = children(der, cert);
  const fields = children(der, tbs);
  const i = fields[0].tag === 0xa0 ? 1 : 0; // optional [0] version
  const validity = children(der, fields[i + 3]);
  const spki = fields[i + 5];
  return {
    tbs: der.slice(tbs.start, tbs.end),
    sigHash: contains(der.slice(sigAlg.start, sigAlg.end), OID_ECDSA_SHA384) ? "SHA-384"
      : contains(der.slice(sigAlg.start, sigAlg.end), OID_ECDSA_SHA256) ? "SHA-256" : null,
    // BIT STRING: first content byte is the unused-bits count.
    signature: der.slice(sig.contentStart + 1, sig.end),
    spki: der.slice(spki.start, spki.end),
    curve: contains(der.slice(spki.start, spki.end), OID_P384) ? "P-384"
      : contains(der.slice(spki.start, spki.end), OID_P256) ? "P-256" : null,
    notBefore: asn1Time(der, validity[0]),
    notAfter: asn1Time(der, validity[1]),
  };
}

async function importKey(cert) {
  if (!cert.curve) throw new JwsError("unsupported key");
  return crypto.subtle.importKey("spki", cert.spki, { name: "ECDSA", namedCurve: cert.curve }, false, ["verify"]);
}

async function verifyCertSignature(child, parent) {
  if (!child.sigHash) throw new JwsError("unsupported certificate signature");
  const size = parent.curve === "P-384" ? 48 : 32;
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: child.sigHash }, await importKey(parent), derSigToRaw(child.signature, size), child.tbs);
  if (!ok) throw new JwsError("certificate chain does not verify");
}

/** ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER } → r||s, each `size` bytes. */
function derSigToRaw(der, size) {
  const seq = tlv(der, 0);
  const [r, s] = children(der, seq);
  const out = new Uint8Array(size * 2);
  for (const [n, at] of [[r, 0], [s, size]]) {
    let bytes = der.slice(n.contentStart, n.end);
    while (bytes.length > size && bytes[0] === 0) bytes = bytes.slice(1);
    if (bytes.length > size) throw new JwsError("bad signature integer");
    out.set(bytes, at + size - bytes.length);
  }
  return out;
}

/* ---------- minimal DER ---------- */

function tlv(bytes, at) {
  const tag = bytes[at];
  let len = bytes[at + 1];
  let headerLen = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + bytes[at + 2 + k];
    headerLen += n;
  }
  const contentStart = at + headerLen;
  const end = contentStart + len;
  if (end > bytes.length) throw new JwsError("truncated DER");
  return { tag, start: at, contentStart, end };
}

function children(bytes, node) {
  const out = [];
  for (let at = node.contentStart; at < node.end;) {
    const child = tlv(bytes, at);
    out.push(child);
    at = child.end;
  }
  return out;
}

function asn1Time(bytes, node) {
  const text = utf8(bytes.slice(node.contentStart, node.end));
  // UTCTime YYMMDDHHMMSSZ or GeneralizedTime YYYYMMDDHHMMSSZ.
  const full = node.tag === 0x17 ? (Number(text.slice(0, 2)) >= 50 ? "19" : "20") + text : text;
  return new Date(Date.UTC(+full.slice(0, 4), +full.slice(4, 6) - 1, +full.slice(6, 8),
    +full.slice(8, 10), +full.slice(10, 12), +full.slice(12, 14)));
}

function contains(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/* ---------- encodings ---------- */

function b64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return b64(padded);
}

const utf8 = (bytes) => new TextDecoder().decode(bytes);

async function sha256hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
