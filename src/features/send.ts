import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { dispatch, dsp } from "../hypr";
import { receiveDir } from "../preferences";
import { shellQuote } from "../run";

/**
 * Opens a link in the desktop's default browser. Through Hyprland's exec so
 * the browser isn't our child process; that exec goes through a shell, hence
 * the URL is normalised by the URL parser and then single-quoted.
 */
export async function openLink(raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  await dispatch(dsp.exec(`xdg-open ${shellQuote(url.href)}`));
  return true;
}

/**
 * A new file that's safe to write and doesn't overwrite anything: path parts
 * and odd characters are stripped, and "photo (2).jpg" style suffixes avoid
 * clobbering an existing file. Opened exclusively, so two uploads of the same
 * name can't both claim it between the check and the write.
 */
async function safeDestination(original: string, dir: string): Promise<{ path: string; file: FileHandle }> {
  const cleaned = basename(original).replace(/[^\w.\- ()]/g, "_").replace(/^\.+/, "") || "file";
  const extension = extname(cleaned);
  const stem = cleaned.slice(0, cleaned.length - extension.length);

  await mkdir(dir, { recursive: true });
  for (let copy = 1; ; copy += 1) {
    const path = join(dir, copy === 1 ? cleaned : `${stem} (${copy})${extension}`);
    try {
      return { path, file: await open(path, "wx") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/**
 * Streams one upload to disk, so a big file never sits in memory. Returns the
 * saved name, or null when it passed `limit`; either way a failed upload
 * leaves nothing half-written behind.
 */
export async function saveUpload(
  name: string,
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  dir: string,
): Promise<string | null> {
  const { path, file } = await safeDestination(name, dir);
  let size = 0;
  let complete = false;
  try {
    // An empty file arrives with no body at all. A reader, not `for await`:
    // in Bun 1.3, awaiting a file write inside `for await` over a request
    // body throws once the body ends.
    const reader = body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      await file.write(value);
    }
    complete = true;
  } finally {
    await file.close();
    if (!complete) await rm(path, { force: true });
  }

  // No notification: the phone opens what it sent (see openReceived).
  return basename(path);
}

// Opened by a double click in a file manager, these can run programs.
const LAUNCHERS = new Set([".desktop", ".sh", ".appimage", ".exe", ".run", ".jar", ".py"]);

/**
 * Opens a file that just arrived in its default app, as the phone asked. A
 * launcher or script opens its folder instead of running.
 */
export async function openReceived(name: string) {
  const dir = await receiveDir();
  const path = join(dir, basename(name));
  const target = LAUNCHERS.has(extname(path).toLowerCase()) ? dir : path;
  await dispatch(dsp.exec(`xdg-open ${shellQuote(target)}`));
}

/** Several files at once open their folder rather than an app each. */
export async function openDownloads() {
  await dispatch(dsp.exec(`xdg-open ${shellQuote(await receiveDir())}`));
}
