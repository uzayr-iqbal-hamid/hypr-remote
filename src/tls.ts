import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";

import { CONFIG_DIR } from "./env";
import { run } from "./run";

/*
 * HTTPS is only needed for installing the remote as an app on the phone:
 * browsers refuse service workers, and so home-screen install, on a plain
 * http:// LAN address.
 *
 * There's no public certificate for 192.168.x.x, so this makes a private
 * certificate authority once, and from it a certificate for the current LAN
 * address. The phone trusts the authority (downloaded from /ca.crt) once, and
 * keeps trusting fresh certificates for new addresses without doing it again.
 */

const DIR = join(CONFIG_DIR, "tls");
export const CA_CERT = join(DIR, "ca.crt");

/** Where everything lives inside `dir`; a parameter so tests can use a scratch one. */
function paths(dir: string) {
  return {
    caKey: join(dir, "ca.key"),
    caCert: join(dir, "ca.crt"),
    key: join(dir, "server.key"),
    cert: join(dir, "server.crt"),
    forAddress: join(dir, "server.address"),
  };
}

async function openssl(args: string[]) {
  const result = await run(["openssl", ...args], { timeoutMs: 15000 });
  if (result.code !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

async function ensureAuthority(files: ReturnType<typeof paths>) {
  if (existsSync(files.caKey) && existsSync(files.caCert)) return;
  await openssl([
    "req", "-x509", "-new", "-nodes",
    "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-keyout", files.caKey, "-out", files.caCert, "-days", "3650",
    "-subj", "/CN=hypr-remote local authority",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
}

/** Whether `cert` was issued for `key`. False for anything unreadable. */
async function pairMatches(key: string, cert: string) {
  try {
    const [fromKey, fromCert] = await Promise.all([
      openssl(["pkey", "-pubout", "-in", key]),
      openssl(["x509", "-pubkey", "-noout", "-in", cert]),
    ]);
    return fromKey === fromCert;
  } catch {
    return false;
  }
}

async function certificateIsCurrent(files: ReturnType<typeof paths>, address: string): Promise<boolean> {
  if (!existsSync(files.cert) || !existsSync(files.key) || !existsSync(files.forAddress)) return false;
  if ((await Bun.file(files.forAddress).text()).trim() !== address) return false;
  // A key and certificate from different issues (one interrupted halfway, say)
  // look current by every other test, and Bun refuses them at startup.
  if (!(await pairMatches(files.key, files.cert))) return false;
  // Reissue a month before expiry.
  const expiring = await run(["openssl", "x509", "-checkend", "2592000", "-noout", "-in", files.cert]);
  return expiring.code === 0;
}

/**
 * A certificate for `address`, reissued when the address changes, the old one
 * nears expiry, or the key on disk is not the one it was issued for. 397 days:
 * the longest browsers accept.
 */
export async function ensureCertificate(address: string, dir = DIR) {
  // lanAddress() falls back to "localhost" while the network is down, and
  // IP:localhost makes openssl reject the whole certificate. The address check
  // in server.ts restarts us once a real address is back.
  if (!isIP(address)) throw new Error(`no LAN address to issue a certificate for (got ${address})`);

  const files = paths(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  await ensureAuthority(files);

  if (!(await certificateIsCurrent(files, address))) {
    // Everything is issued under temporary names and only renamed into place
    // once both halves exist, so a failure leaves the old pair as it was.
    const request = join(dir, "server.csr");
    const extensions = join(dir, "server.ext");
    const newKey = `${files.key}.new`;
    const newCert = `${files.cert}.new`;
    try {
      await Bun.write(
        extensions,
        [
          `subjectAltName=IP:${address},DNS:localhost`,
          "basicConstraints=CA:FALSE",
          "keyUsage=critical,digitalSignature",
          "extendedKeyUsage=serverAuth",
        ].join("\n"),
      );
      await openssl([
        "req", "-new", "-nodes",
        "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
        "-keyout", newKey, "-out", request, "-subj", "/CN=hypr-remote",
      ]);
      await openssl([
        "x509", "-req", "-in", request, "-CA", files.caCert, "-CAkey", files.caKey,
        "-CAcreateserial", "-out", newCert, "-days", "397", "-extfile", extensions,
      ]);
      renameSync(newKey, files.key);
      renameSync(newCert, files.cert);
      await Bun.write(files.forAddress, address);
    } finally {
      for (const leftover of [request, extensions, newKey, newCert]) rmSync(leftover, { force: true });
    }
  }

  return { cert: Bun.file(files.cert), key: Bun.file(files.key) };
}
