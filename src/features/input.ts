import { existsSync } from "node:fs";
import { dispatch, dsp, hyprJson, type Client, type Monitor } from "../hypr";
import { installed, run } from "../run";

/* -------------------------------------------------------------------------- */
/* Keyboard (wtype)                                                           */
/* -------------------------------------------------------------------------- */

export const TEXT_LIMIT = 2000;

/**
 * Named keys the phone may press, mapped to wtype arguments. A fixed table
 * rather than passing key names through, so the phone can't send arbitrary
 * modifier chords (no ctrl+alt+whatever it likes).
 */
export const KEYS = {
  enter: ["-k", "Return"],
  backspace: ["-k", "BackSpace"],
  delete: ["-k", "Delete"],
  tab: ["-k", "Tab"],
  escape: ["-k", "Escape"],
  space: ["-k", "space"],
  left: ["-k", "Left"],
  right: ["-k", "Right"],
  up: ["-k", "Up"],
  down: ["-k", "Down"],
  "page-up": ["-k", "Prior"],
  "page-down": ["-k", "Next"],
  home: ["-k", "Home"],
  end: ["-k", "End"],
  f5: ["-k", "F5"],
  // Most slide apps blank the screen on "b" and resume on the next key.
  blank: ["-k", "b"],
  copy: ["-M", "ctrl", "-k", "c", "-m", "ctrl"],
  paste: ["-M", "ctrl", "-k", "v", "-m", "ctrl"],
  cut: ["-M", "ctrl", "-k", "x", "-m", "ctrl"],
  undo: ["-M", "ctrl", "-k", "z", "-m", "ctrl"],
  "select-all": ["-M", "ctrl", "-k", "a", "-m", "ctrl"],
  save: ["-M", "ctrl", "-k", "s", "-m", "ctrl"],
  find: ["-M", "ctrl", "-k", "f", "-m", "ctrl"],
  "new-tab": ["-M", "ctrl", "-k", "t", "-m", "ctrl"],
  "close-tab": ["-M", "ctrl", "-k", "w", "-m", "ctrl"],
  "reopen-tab": ["-M", "ctrl", "-M", "shift", "-k", "t", "-m", "shift", "-m", "ctrl"],
  refresh: ["-M", "ctrl", "-k", "r", "-m", "ctrl"],
  "switch-window": ["-M", "alt", "-k", "Tab", "-m", "alt"],
} as const satisfies Record<string, readonly string[]>;

export type KeyName = keyof typeof KEYS;

export async function typeText(text: string) {
  // "--" so text starting with a dash is typed, not read as a flag.
  await run(["wtype", "--", text.slice(0, TEXT_LIMIT)]);
}

export async function pressKey(key: KeyName) {
  await run(["wtype", ...KEYS[key]]);
}

/*
 * Starting a slideshow takes a different key in each app, and the obvious one
 * is dangerous: F5 in a browser reloads the page, presentation and all. So
 * the phone asks to "start" and the laptop picks the key for the window in
 * front. These are not in KEYS; the phone can't send them directly.
 */
const SHOW_KEYS = {
  f5: ["-k", "F5"],
  // Google Slides, PowerPoint on the web: present from the current slide.
  "ctrl-f5": ["-M", "ctrl", "-k", "F5", "-m", "ctrl"],
  // A PDF open in the browser (pdf.js): presentation mode.
  "ctrl-alt-p": ["-M", "ctrl", "-M", "alt", "-k", "p", "-m", "alt", "-m", "ctrl"],
  // Okular's presentation mode.
  "ctrl-shift-p": ["-M", "ctrl", "-M", "shift", "-k", "p", "-m", "shift", "-m", "ctrl"],
} as const;

const BROWSERS = /firefox|zen|librewolf|floorp|waterfox|chrom|brave|vivaldi|edge|opera|epiphany|qutebrowser/;

/** The key that starts a slideshow in this window. */
export function showKey(windowClass: string, title: string): keyof typeof SHOW_KEYS {
  const app = windowClass.toLowerCase();
  if (BROWSERS.test(app)) return /\.pdf\b/i.test(title) ? "ctrl-alt-p" : "ctrl-f5";
  if (app.includes("okular")) return "ctrl-shift-p";
  // LibreOffice, OnlyOffice, WPS, Evince, Zathura, and most everything else.
  return "f5";
}

export async function startSlideshow() {
  const window = await hyprJson<Client>("activewindow");
  await run(["wtype", ...SHOW_KEYS[showKey(window?.class ?? "", window?.title ?? "")]]);
}

/* -------------------------------------------------------------------------- */
/* Touchpad                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Movement goes through Hyprland's own `movecursor`, over the request socket:
 * no extra software, no root, and no process per event. Clicks and scrolling
 * have no Hyprland equivalent, so those use ydotool, which needs its daemon.
 */

type Rect = { x: number; y: number; width: number; height: number };

let screens: Rect[] = [];
let speed = 1;
let cursor: { x: number; y: number } | null = null;
let lastMove = 0;
let pending = { dx: 0, dy: 0 };
let flushing = false;

async function refreshGeometry() {
  const monitors = (await hyprJson<Monitor[]>("monitors")) ?? [];
  // Layout coordinates are logical: a 1920px panel at 1.25 scale is 1536 wide.
  screens = monitors.map((monitor) => ({
    x: monitor.x,
    y: monitor.y,
    width: Math.round((monitor.transform % 2 ? monitor.height : monitor.width) / monitor.scale),
    height: Math.round((monitor.transform % 2 ? monitor.width : monitor.height) / monitor.scale),
  }));
  speed = pointerSpeed(screens);
}

/**
 * How far a swipe goes, scaled to the desk: crossing two monitors, or one 4K
 * screen, takes the same swipe as crossing a laptop's. 1600 layout pixels
 * across is the pace the phone's acceleration was tuned for.
 */
export function pointerSpeed(screens: readonly Rect[]): number {
  if (screens.length === 0) return 1;
  const left = Math.min(...screens.map((screen) => screen.x));
  const right = Math.max(...screens.map((screen) => screen.x + screen.width));
  return Math.min(Math.max((right - left) / 1600, 0.8), 3);
}

/** Keeps the cursor on some screen: across gaps between monitors, not off the edge of the desk. */
export function clampToScreens(x: number, y: number, screens: readonly Rect[]) {
  let best = { x, y, distance: Infinity };
  for (const screen of screens) {
    const cx = Math.min(Math.max(x, screen.x), screen.x + screen.width - 1);
    const cy = Math.min(Math.max(y, screen.y), screen.y + screen.height - 1);
    const distance = Math.hypot(cx - x, cy - y);
    if (distance < best.distance) best = { x: cx, y: cy, distance };
  }
  return { x: best.x, y: best.y };
}

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (pending.dx !== 0 || pending.dy !== 0) {
      const { dx, dy } = pending;
      pending = { dx: 0, dy: 0 };

      // After a pause, the real mouse may have moved; start from where it is.
      if (!cursor || Date.now() - lastMove > 400) {
        await refreshGeometry();
        cursor = await hyprJson<{ x: number; y: number }>("cursorpos");
        if (!cursor) return;
      }
      lastMove = Date.now();

      cursor = clampToScreens(cursor.x + dx * speed, cursor.y + dy * speed, screens);
      await dispatch(dsp.moveCursor(Math.round(cursor.x), Math.round(cursor.y)));
    }
  } finally {
    flushing = false;
  }
}

/**
 * Deltas pile up while a move is in flight and go out as one, so a slow
 * frame never queues a backlog of stale positions.
 */
export function movePointer(dx: number, dy: number) {
  pending.dx += dx;
  pending.dy += dy;
  void flush();
}

// ydotool's button codes: 0xC0 is left down-and-up, 0x40 down, 0x80 up.
const BUTTONS = { left: "0xC0", right: "0xC1", middle: "0xC2" } as const;

export async function click(button: keyof typeof BUTTONS) {
  await run(["ydotool", "click", BUTTONS[button]]);
}

/** Holds the left button down, or lets it go: dragging from the touchpad. */
export async function pressButton(state: "down" | "up") {
  await run(["ydotool", "click", state === "down" ? "0x40" : "0x80"]);
}

/**
 * Notches, positive down and right like a browser's deltaY and deltaX.
 * ydotool's vertical wheel is positive up; its horizontal one, right.
 */
export async function scroll(dy: number, dx = 0) {
  await run(["ydotool", "mousemove", "--wheel", "-x", String(Math.round(dx)), "-y", String(-Math.round(dy))]);
}

const LEFT_CTRL = "29";

/** Ctrl and the wheel together: zoom in (positive) or out, in most apps. */
export async function zoom(steps: number) {
  await run(["ydotool", "key", `${LEFT_CTRL}:1`]);
  try {
    await run(["ydotool", "mousemove", "--wheel", "-x", "0", "-y", String(Math.round(steps))]);
  } finally {
    await run(["ydotool", "key", `${LEFT_CTRL}:0`]);
  }
}

/* -------------------------------------------------------------------------- */

export async function readInputSupport() {
  const ydotoolSocket = process.env.YDOTOOL_SOCKET;
  return {
    keyboard: installed("wtype"),
    // The client alone isn't enough; the daemon's socket has to exist.
    clicks:
      // existsSync, not Bun.file().exists(): the latter is false for sockets.
      installed("ydotool") && Boolean(ydotoolSocket) && existsSync(ydotoolSocket!),
  };
}
