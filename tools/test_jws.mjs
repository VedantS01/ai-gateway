// Test-only signer: a throwaway root → intermediate → leaf chain shaped like
// Apple's (marker OIDs included), and JWS payloads signed by the leaf, so the
// local gateway's /purchase and /notifications can be exercised without the
// App Store. Pin the printed root with APPLE_ROOT_SHA256 in tools/.dev.vars.
//
//   node tools/test_jws.mjs chain <dir>              → prints the root's SHA-256
//   node tools/test_jws.mjs sign <dir> '<json>'      → prints a JWS
//   node tools/test_jws.mjs notify <dir> <type> '<transaction json>'
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [cmd, dir, ...rest] = process.argv.slice(2);
const ssl = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
const der = (pem) => Buffer.from(readFileSync(join(dir, pem), "utf8").replace(/-----[^-]+-----|\s/g, ""), "base64");
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function chain() {
  mkdirSync(dir, { recursive: true });
  ssl("ecparam", "-name", "secp384r1", "-genkey", "-noout", "-out", "root.key");
  ssl("req", "-x509", "-new", "-key", "root.key", "-sha384", "-days", "30", "-subj", "/CN=Test Root G3", "-out", "root.pem");
  for (const [name, signer, hash, oid] of [
    ["int", "root", "-sha384", "1.2.840.113635.100.6.2.1"],
    ["leaf", "int", "-sha256", "1.2.840.113635.100.6.11.1"],
  ]) {
    ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
    ssl("req", "-new", "-key", `${name}.key`, "-subj", `/CN=Test ${name}`, "-out", `${name}.csr`);
    writeFileSync(join(dir, `${name}.ext`),
      `${name === "int" ? "basicConstraints=critical,CA:TRUE\n" : ""}${oid}=ASN1:NULL\n`);
    ssl("x509", "-req", "-in", `${name}.csr`, "-CA", `${signer}.pem`, "-CAkey", `${signer}.key`,
      "-CAcreateserial", hash, "-days", "30", "-extfile", `${name}.ext`, "-out", `${name}.pem`);
  }
  console.log(createHash("sha256").update(der("root.pem")).digest("hex"));
}

function jws(payload) {
  const header = { alg: "ES256", x5c: ["leaf.pem", "int.pem", "root.pem"].map((p) => der(p).toString("base64")) };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = createPrivateKey(readFileSync(join(dir, "leaf.key")));
  const sig = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

if (cmd === "chain") chain();
else if (cmd === "sign") console.log(jws(JSON.parse(rest[0])));
else if (cmd === "notify") {
  const tx = JSON.parse(rest[1]);
  console.log(JSON.stringify({ signedPayload: jws({
    notificationType: rest[0],
    data: { bundleId: tx.bundleId, environment: "Sandbox", signedTransactionInfo: jws(tx) },
  }) }));
} else {
  console.error("usage: test_jws.mjs chain|sign|notify <dir> ...");
  process.exit(1);
}
