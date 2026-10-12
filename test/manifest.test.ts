import { describe, expect, test } from "bun:test";

import { manifestFor } from "../src/manifest";

const base = {
  name: "hypr remote",
  start_url: "/",
  scope: "/",
  display: "standalone",
  share_target: { action: "/share" },
};

describe("manifestFor", () => {
  test("an unpaired reader gets the plain file, with no token in it", () => {
    expect(manifestFor(base, null)).toEqual(base);
  });

  test("a paired reader gets a start_url naming its own token", () => {
    const manifest = manifestFor(base, "d_abc123") as typeof base;
    expect(manifest.start_url).toBe("/?t=d_abc123");
  });

  test("the token is escaped, so it cannot break out of the url", () => {
    const manifest = manifestFor(base, "d_a&b=c#d") as typeof base;
    expect(manifest.start_url).toBe(`/?t=${encodeURIComponent("d_a&b=c#d")}`);
  });

  test("everything else in the manifest survives, share_target included", () => {
    const manifest = manifestFor(base, "d_abc123") as typeof base;
    expect(manifest.name).toBe("hypr remote");
    expect(manifest.display).toBe("standalone");
    expect(manifest.share_target).toEqual({ action: "/share" });
  });

  test("a plain-http request is ignored, however good the token", () => {
    expect(manifestFor(base, "d_abc123", false)).toEqual(base);
  });

  test("a file on disk that is not a manifest is refused, not served", () => {
    expect(manifestFor(null, "d_abc123")).toBeNull();
    expect(manifestFor({ name: "no start_url" }, null)).toBeNull();
  });
});
