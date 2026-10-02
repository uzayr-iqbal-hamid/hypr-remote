import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/run";
import { ensureCertificate } from "../src/tls";

/** The public key a file carries, from a key or a certificate. */
async function publicKey(kind: "pkey" | "x509", path: string) {
  const args = kind === "pkey" ? ["pkey", "-pubout", "-in", path] : ["x509", "-pubkey", "-noout", "-in", path];
  return (await run(["openssl", ...args])).stdout;
}

describe("ensureCertificate", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hypr-remote-tls-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("issues a key and a certificate that belong together", async () => {
    await ensureCertificate("192.168.1.34", dir);
    expect(await publicKey("x509", join(dir, "server.crt"))).toBe(await publicKey("pkey", join(dir, "server.key")));
    expect(readFileSync(join(dir, "server.address"), "utf8")).toBe("192.168.1.34");
  });

  test("leaves only the key, certificate and address behind", async () => {
    await ensureCertificate("192.168.1.34", dir);
    expect(readdirSync(dir).sort()).toEqual(["ca.crt", "ca.key", "ca.srl", "server.address", "server.crt", "server.key"]);
  });

  test("refuses a hostname without touching the pair on disk", async () => {
    await ensureCertificate("192.168.1.34", dir);
    const key = readFileSync(join(dir, "server.key"));
    const cert = readFileSync(join(dir, "server.crt"));

    await expect(ensureCertificate("localhost", dir)).rejects.toThrow("no LAN address");
    expect(readFileSync(join(dir, "server.key"))).toEqual(key);
    expect(readFileSync(join(dir, "server.crt"))).toEqual(cert);
  });

  test("reissues when the key no longer matches the certificate", async () => {
    await ensureCertificate("192.168.1.34", dir);
    // What an issue that died between the key and the certificate left behind.
    await run(["openssl", "genpkey", "-algorithm", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-out", join(dir, "server.key")]);
    expect(await publicKey("x509", join(dir, "server.crt"))).not.toBe(await publicKey("pkey", join(dir, "server.key")));

    await ensureCertificate("192.168.1.34", dir);
    expect(await publicKey("x509", join(dir, "server.crt"))).toBe(await publicKey("pkey", join(dir, "server.key")));
  });

  test("reissues when the key is unreadable", async () => {
    await ensureCertificate("192.168.1.34", dir);
    writeFileSync(join(dir, "server.key"), "not a key");

    await ensureCertificate("192.168.1.34", dir);
    expect(existsSync(join(dir, "server.key.new"))).toBe(false);
    expect(await publicKey("x509", join(dir, "server.crt"))).toBe(await publicKey("pkey", join(dir, "server.key")));
  });

  test("keeps a current, matching pair as it is", async () => {
    await ensureCertificate("192.168.1.34", dir);
    const cert = readFileSync(join(dir, "server.crt"));

    await ensureCertificate("192.168.1.34", dir);
    expect(readFileSync(join(dir, "server.crt"))).toEqual(cert);
  });
});
