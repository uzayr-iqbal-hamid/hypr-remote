import { z } from "zod";

/**
 * The manifest is the one file this server answers differently per caller: an
 * iOS home-screen app launches at `start_url` with an empty localStorage of its
 * own, so that url is the only thing that can hand it the token it needs to
 * pair. A phone that proves it is paired therefore gets a `start_url` carrying
 * its own token; anyone else, including a browser that has nothing yet, gets
 * the plain file with nothing in it.
 *
 * `token` is whatever the caller has already checked against the live device
 * list, and null when it checked out. Pairing is never decided here, so this
 * stays a pure function.
 *
 * `secure` is false for a plain-HTTP request. The token was in clear text for
 * the whole trip, so it is ignored even when it checks out — the caller gets the
 * plain file, which still has to work over http for an unpaired reader to
 * install anything at all.
 */

const Manifest = z.object({ start_url: z.string() }).passthrough();

/**
 * The manifest to serve for a request that may or may not be paired, or null
 * when the file on disk is not a manifest this server understands.
 */
export function manifestFor(base: unknown, token: string | null, secure = true): unknown {
  const parsed = Manifest.safeParse(base);
  if (!parsed.success) return null;
  if (!token || !secure) return parsed.data;
  return { ...parsed.data, start_url: `/?t=${encodeURIComponent(token)}` };
}
