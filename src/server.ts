import { extname, join, normalize } from "node:path";

import type { Server, ServerWebSocket } from "bun";

import { Action, runAction, type Reply } from "./actions";
import { addDevice, clearDevices, deviceFor, listDevices, loadDevices, removeDevice, touchDevice } from "./devices";
import { hyprSocket, prepareEnvironment } from "./env";
import { read } from "./run";
import { CLIP_IMAGE_LIMIT, followClipboard, readClip, setClipboardImage } from "./features/clipboard";
import { fileFor } from "./features/files";
import { readArt } from "./features/media";
import { followNotifications } from "./features/notifications";
import { captureMonitor, type Quality } from "./features/screen";
import { saveUpload } from "./features/send";
import { startStatsSampler } from "./features/stats";
import { manifestFor } from "./manifest";
import { lanAddress, loadToken, newToken, publishPairing, tokenMatches } from "./pairing";
import { loadPreferences, preferences, receiveDir } from "./preferences";
import { loadScenes, watchScenes } from "./scenes";
import { readFast, readSlow, viewScenes, type FastState, type SlowState } from "./state";
import { CA_CERT, ensureCertificate } from "./tls";
import { watchAudioAndMedia } from "./watch";
import { version } from "../package.json";

const HTTP_PORT = Number(process.env.PORT ?? 4000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 4443);
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
// Served through the handler above rather than as a plain static file, so that
// start_url can name a paired phone's own token.
const MANIFEST_FILE = join(PUBLIC_DIR, "manifest.webmanifest");
const UPLOAD_LIMIT = 512 * 1024 * 1024;
// Opt back into pairing over plain HTTP even while HTTPS runs.
const ALLOW_HTTP = process.env.HYPR_REMOTE_ALLOW_HTTP === "1";

// Under systemd, exiting is how we restart: it relaunches us with fresh state.
const UNDER_SYSTEMD = Boolean(process.env.INVOCATION_ID);

if (!prepareEnvironment()) {
  console.error("No running Hyprland session found.");
  // Non-zero so systemd retries until Hyprland is up after login.
  process.exit(1);
}

// The pairing code the QR code carries; replaced when every phone is unpaired.
let token = await loadToken();
await loadDevices();
await loadPreferences();
let scenes = await loadScenes();
const address = lanAddress();
// Which commit this copy runs, for the phone's update check; null outside git.
const commit = await read(["git", "-C", join(import.meta.dir, ".."), "rev-parse", "HEAD"]);

/* -------------------------------------------------------------------------- */
/* Live state                                                                 */
/* -------------------------------------------------------------------------- */

/** Which paired phone a socket belongs to. */
type Phone = { device: string };

const clients = new Set<ServerWebSocket<Phone>>();
let fast: FastState | null = null;
let slow: SlowState | null = null;
let lastSent = "";

function send(socket: ServerWebSocket<Phone>, message: unknown) {
  socket.send(JSON.stringify(message));
}

/** Sends state to every phone, but only when something in it changed. */
function broadcast(force = false) {
  if (!fast || !slow) return;
  const message = JSON.stringify({
    type: "state",
    state: { ...fast, ...slow, scenes: viewScenes(scenes, fast, slow), preferences: preferences() },
  });
  if (!force && message === lastSent) return;
  lastSent = message;
  for (const client of clients) client.send(message);
}

// Reads overlap (timers, events, actions) and an older one can finish last.
// Each read is numbered as it starts, and its result is kept only if no newer
// read of the same kind has landed, so stale state never replaces fresh.
const started = { fast: 0, slow: 0 };
const landed = { fast: 0, slow: 0 };

async function refresh(which: "fast" | "slow" | "both") {
  if (clients.size === 0) return;
  const fastRead = which !== "slow" ? ++started.fast : 0;
  const slowRead = which !== "fast" ? ++started.slow : 0;
  const [nextFast, nextSlow] = await Promise.all([
    fastRead ? readFast() : null,
    slowRead ? readSlow() : null,
  ]);
  if (nextFast && fastRead > landed.fast) {
    fast = nextFast;
    landed.fast = fastRead;
  }
  if (nextSlow && slowRead > landed.slow) {
    slow = nextSlow;
    landed.slow = slowRead;
  }
  broadcast();
}

// Bursts of Hyprland events (a workspace switch fires several) become one read.
let pendingRefresh: ReturnType<typeof setTimeout> | undefined;
function scheduleRefresh() {
  clearTimeout(pendingRefresh);
  pendingRefresh = setTimeout(() => void refresh("fast"), 40);
}

/** Workspace and window changes arrive from Hyprland the instant they happen. */
async function followHyprland() {
  // One failure can fire both close and error; each would schedule its own
  // reconnect, doubling the connections every time Hyprland restarts.
  let retried = false;
  const retry = () => {
    if (retried) return;
    retried = true;
    // A restarted Hyprland has a new signature, so look it up again.
    prepareEnvironment();
    setTimeout(followHyprland, 2000);
  };
  try {
    await Bun.connect({
      unix: hyprSocket("events"),
      socket: {
        data: scheduleRefresh,
        close: retry,
        error: retry,
      },
    });
  } catch {
    retry();
  }
}

// Volume, sound output and media arrive live too, while a phone is connected.
const audioAndMedia = watchAudioAndMedia((stale) => void refresh(stale));

// Scenes saved from the phone, or edited by hand, reach phones without a restart.
watchScenes((next) => {
  scenes = next;
  broadcast();
});

// Notifications are read as they arrive, phone or no phone, so the list is
// there when one connects.
followNotifications(() => void refresh("slow"));

// What's copied on the laptop reaches the phone as it's copied.
followClipboard(() => void refresh("slow"));

// Stats keep ten minutes of history, phone or no phone, and every phone hears
// when the laptop runs hot (unless that alert is off in settings).
startStatsSampler(
  () => (preferences().hotAlert ? preferences().hotAt : null),
  (temperature) => {
    const message = JSON.stringify({ type: "toast", text: `the laptop is running hot: ${temperature}°c` } satisfies Reply);
    for (const client of clients) client.send(message);
  },
);

// Only a fallback now: events cover what changes fast.
setInterval(() => void refresh("fast"), 5000);
setInterval(() => void refresh("slow"), 10_000);
void followHyprland();

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** Files from public/, and nothing that resolves outside it. */
async function serveStatic(pathname: string): Promise<Response | null> {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const path = normalize(join(PUBLIC_DIR, relative));
  const type = STATIC_TYPES[extname(path)];
  if (!path.startsWith(PUBLIC_DIR + "/") || !type) return null;

  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return new Response(file, {
    headers: {
      "Content-Type": type,
      // The page and worker must never be stale; icons and fonts may be cached.
      "Cache-Control": type.startsWith("image/") || type.startsWith("font/") ? "max-age=86400" : "no-store",
    },
  });
}

/**
 * The phone's own token comes in the x-token header, which stays out of
 * history and logs. Only /ws passes `url` to allow ?t=: browsers can't set
 * WebSocket headers. Returns the phone, or null.
 */
function authorised(request: Request, url?: URL) {
  return deviceFor(url?.searchParams.get("t") ?? request.headers.get("x-token"));
}

/**
 * The manifest carries a token in its start_url for a phone that has one, which
 * is how an installed iOS web app learns it (see manifest.ts). The browser asks
 * for the manifest itself, without the x-token header, so the token rides in
 * the query string here. Returns the token the request proved, or null.
 *
 * Whether it may be used is decided by manifestFor, which also turns it down
 * for a plain-HTTP request.
 */
function pairedTokenForManifest(url: URL) {
  const presented = url.searchParams.get("t");
  return presented && deviceFor(presented) ? presented : null;
}

// Set once HTTPS is up. From then on the token, and with it typing on this
// laptop, never crosses plain HTTP, where anyone on the Wi-Fi can read it.
let httpsRunning = false;
const PAIRED_PATHS = new Set(["/ws", "/pair", "/screen", "/upload", "/art", "/clip", "/clipboard", "/file"]);
const QUALITIES = new Set<string>(["preview", "sharp", "full"]);

async function handle(request: Request, server: Server<Phone>): Promise<Response | undefined> {
  const url = new URL(request.url);

  if (PAIRED_PATHS.has(url.pathname) && httpsRunning && !ALLOW_HTTP && server.url.protocol === "http:") {
    return new Response("Plain HTTP is off: open the https:// address, or re-scan the QR code.", {
      status: 403,
    });
  }

  if (url.pathname === "/ws") {
    const device = authorised(request, url);
    if (!device) return new Response("Not paired", { status: 401 });
    return server.upgrade(request, { data: { device: device.id } })
      ? undefined
      : new Response("Expected a WebSocket", { status: 400 });
  }

  // A phone trades the QR code's pairing code for a token of its own, naming
  // itself so it can be told apart in settings. `previous` is the token it had,
  // when it's pairing again.
  if (url.pathname === "/pair" && request.method === "POST") {
    if (!tokenMatches(request.headers.get("x-token"), token)) return new Response("Not paired", { status: 401 });
    const body = (await request.json().catch(() => null)) as { name?: unknown; previous?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name : "phone";
    const previous = typeof body?.previous === "string" ? body.previous : null;
    const { token: own } = await addDevice(name, previous);
    return Response.json({ token: own });
  }

  // A live look at one monitor.
  if (url.pathname === "/screen") {
    if (!authorised(request)) return new Response("Not paired", { status: 401 });
    const asked = url.searchParams.get("q") ?? "preview";
    const quality = (QUALITIES.has(asked) ? asked : "preview") as Quality;
    const image = await captureMonitor(url.searchParams.get("m") ?? "", quality);
    return image
      ? new Response(image, {
          headers: { "Content-Type": quality === "full" ? "image/png" : "image/jpeg", "Cache-Control": "no-store" },
        })
      : new Response("No such monitor", { status: 404 });
  }

  // Something copied on the laptop, by the key in the state it came with.
  if (url.pathname === "/clip") {
    if (!authorised(request)) return new Response("Not paired", { status: 401 });
    const clip = await readClip(url.searchParams.get("k") ?? "");
    return clip
      ? new Response(clip.bytes, { headers: { "Content-Type": clip.type, "Cache-Control": "private, max-age=3600" } })
      : new Response("No such clip", { status: 404 });
  }

  // An image copied on the phone, onto the laptop's clipboard.
  if (url.pathname === "/clipboard" && request.method === "POST") {
    if (!authorised(request)) return new Response("Not paired", { status: 401 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > CLIP_IMAGE_LIMIT) return new Response("Too large", { status: 413 });
    return (await setClipboardImage(bytes))
      ? new Response(null, { status: 204 })
      : new Response("Not an image", { status: 415 });
  }

  // A screenshot or download for the phone to keep, by its key in the state.
  if (url.pathname === "/file") {
    if (!authorised(request)) return new Response("Not paired", { status: 401 });
    const path = fileFor(url.searchParams.get("k") ?? "");
    const file = path ? Bun.file(path) : null;
    if (!file || !(await file.exists())) return new Response("No such file", { status: 404 });
    const name = encodeURIComponent(path!.split("/").pop()!);
    return new Response(file, {
      headers: {
        "Content-Disposition": `attachment; filename*=UTF-8''${name}`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  // Android's share sheet posts here. The service worker catches it and hands
  // it to the page, which sends it with the token; this only answers when the
  // worker isn't running yet.
  if (url.pathname === "/share" && request.method === "POST") {
    return Response.redirect("/?shared=missed", 303);
  }

  // The playing track's album art, by the key in the state it came with.
  if (url.pathname === "/art") {
    if (!authorised(request)) return new Response("Not paired", { status: 401 });
    const art = await readArt(url.searchParams.get("k") ?? "");
    return art
      ? new Response(art.bytes, { headers: { "Content-Type": art.type, "Cache-Control": "private, max-age=3600" } })
      : new Response("No art", { status: 404 });
  }

  // Files from the phone land in the folder picked in settings. One file per request, as the raw
  // body, streamed to disk; the name comes URI-encoded in a header.
  if (url.pathname === "/upload" && request.method === "POST") {
    if (!authorised(request)) return new Response("Not paired", { status: 401 });
    let name: string;
    try {
      name = decodeURIComponent(request.headers.get("x-filename") ?? "");
    } catch {
      return new Response("Bad file name", { status: 400 });
    }
    try {
      const saved = await saveUpload(name, request.body, UPLOAD_LIMIT, await receiveDir());
      return saved ? Response.json({ saved }) : new Response("Too large", { status: 413 });
    } catch (error) {
      console.warn("Upload failed:", error);
      return new Response("Upload failed", { status: 500 });
    }
  }

  // The certificate authority the phone installs to trust HTTPS. Public by
  // design: a certificate is not a secret; its private key never leaves
  // ~/.config/hypr-remote.
  if (url.pathname === "/ca.crt") {
    return new Response(Bun.file(CA_CERT), {
      headers: {
        "Content-Type": "application/x-x509-ca-cert",
        "Content-Disposition": 'attachment; filename="hypr-remote-ca.crt"',
      },
    });
  }

  // The manifest, answered per caller so an installed iOS web app can pair.
  // Answered before the static handler below, which would return the bare file.
  if (url.pathname === "/manifest.webmanifest" && request.method === "GET") {
    const base = await Bun.file(MANIFEST_FILE).json().catch(() => null);
    const manifest = manifestFor(base, pairedTokenForManifest(url), server.url.protocol === "https:");
    if (manifest) {
      return Response.json(manifest, {
        // A manifest that names a token must never be kept: the next reader
        // would be handed somebody else's.
        headers: { "Cache-Control": "no-store" },
      });
    }
  }

  if (url.pathname === "/config.json") {
    return Response.json({ httpsPort: HTTPS_PORT, address, httpAllowed: !httpsRunning || ALLOW_HTTP, version, commit });
  }

  if (request.method === "GET") {
    const file = await serveStatic(url.pathname);
    if (file) return file;
  }

  return new Response("Not found", { status: 404 });
}

/** Closed with this code, a phone knows it's been unpaired and stops retrying. */
const UNPAIRED = 4001;

/** Unpairs every phone: a new QR code, and every socket closed. */
async function unpairAll() {
  token = await newToken();
  await clearDevices();
  await publishPairing(pairingUrl());
  for (const client of clients) client.close(UNPAIRED, "unpaired");
}

const websocket = {
  open(socket: ServerWebSocket<Phone>) {
    clients.add(socket);
    touchDevice(socket.data.device);
    audioAndMedia.start();
    // A fresh phone needs a full picture now, not on the next tick.
    void refresh("both").then(() => broadcast(true));
  },
  close(socket: ServerWebSocket<Phone>) {
    clients.delete(socket);
    touchDevice(socket.data.device);
    if (clients.size === 0) audioAndMedia.stop();
  },
  async message(socket: ServerWebSocket<Phone>, raw: string | Buffer) {
    let json: unknown;
    try {
      json = JSON.parse(String(raw));
    } catch {
      return;
    }
    const parsed = Action.safeParse(json);
    if (!parsed.success) return;
    const action = parsed.data;

    // Paired phones are the server's to manage: it knows which phone asked.
    if (action.type === "devices" || action.type === "device-remove") {
      if (action.type === "device-remove" && (await removeDevice(action.id))) {
        for (const client of clients) if (client.data.device === action.id) client.close(UNPAIRED, "unpaired");
      }
      send(socket, { type: "devices", list: listDevices(), you: socket.data.device } satisfies Reply);
      return;
    }
    if (action.type === "unpair-all") {
      await unpairAll();
      return;
    }

    try {
      const { changed, reply } = await runAction(parsed.data, scenes);
      if (reply) send(socket, reply satisfies Reply);
      if (changed) await refresh("both");
    } catch (error) {
      console.warn(`${parsed.data.type} failed:`, error);
    }
  },
};

// Bun's cap has to admit an upload; /upload enforces the real limit while it
// streams, and no other route reads a body.
const common = { fetch: handle, websocket, maxRequestBodySize: UPLOAD_LIMIT };

// Listen on the LAN address only, not every interface (VPNs, containers).
// That ties the sockets to this network; the address check below restarts us
// on a new one.
const hostname = address;

// HTTPS first, so plain HTTP knows from its first request whether to refuse
// the token.
try {
  Bun.serve({ ...common, port: HTTPS_PORT, hostname, tls: await ensureCertificate(address) });
  httpsRunning = true;
} catch (error) {
  console.warn("HTTPS disabled:", error instanceof Error ? error.message : error);
}

Bun.serve({ ...common, port: HTTP_PORT, hostname });

function pairingUrl() {
  return httpsRunning ? `https://${address}:${HTTPS_PORT}/?t=${token}` : `http://${address}:${HTTP_PORT}/?t=${token}`;
}

console.log("\nhypr-remote is running.\n");
if (!httpsRunning) console.warn("Pairing over plain HTTP: anyone on this Wi-Fi can read the token.\n");
await publishPairing(pairingUrl());
console.log("Phone and laptop must be on the same Wi-Fi.");

// A new network means a new address: the pairing code and certificate are
// both for the old one, and the sockets listen on it. Under systemd, restart
// to reissue them and listen on the new one.
setInterval(() => {
  if (lanAddress() === address) return;
  console.log(`Address changed to ${lanAddress()}.${UNDER_SYSTEMD ? "" : " Restart hypr-remote to follow it."}`);
  if (UNDER_SYSTEMD) process.exit(0);
}, 30_000);
