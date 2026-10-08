import { dispatch, dsp, hyprJson, type Monitor } from "../hypr";
import { run } from "../run";
import { readInputSupport } from "./input";

/**
 * How a frame is taken: a small JPEG for the glance on the bridge tab, a
 * sharper one while the preview fills the phone, and a full-size PNG to keep.
 */
const QUALITY = {
  preview: ["-s", "0.4", "-t", "jpeg", "-q", "60"],
  sharp: ["-s", "0.8", "-t", "jpeg", "-q", "70"],
  full: ["-t", "png", "-l", "1"],
} as const;

export type Quality = keyof typeof QUALITY;

export async function captureMonitor(name: string, quality: Quality = "preview"): Promise<Uint8Array<ArrayBuffer> | null> {
  const monitors = await hyprJson<Monitor[]>("monitors");
  // Only a monitor that exists; the name never reaches grim otherwise.
  if (!monitors?.some((monitor) => monitor.name === name)) return null;

  const child = Bun.spawn(["grim", "-o", name, ...QUALITY[quality], "-"], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 8000,
  });
  const [bytes, code] = await Promise.all([new Response(child.stdout).bytes(), child.exited]);
  return code === 0 ? bytes : null;
}

/**
 * Where a point on a monitor's picture is in Hyprland's layout. `x` and `y`
 * run from 0 to 1 across the picture as grim takes it, which is the monitor
 * as you see it: turned sideways (odd transforms), its width and height swap.
 */
export function layoutPoint(monitor: Monitor, x: number, y: number) {
  const sideways = monitor.transform % 2 === 1;
  const width = (sideways ? monitor.height : monitor.width) / monitor.scale;
  const height = (sideways ? monitor.width : monitor.height) / monitor.scale;
  const clamp = (value: number) => Math.min(Math.max(value, 0), 0.9999);
  // Down, not to the nearest: the right edge rounded up is the next monitor.
  return {
    x: monitor.x + Math.floor(clamp(x) * width),
    y: monitor.y + Math.floor(clamp(y) * height),
  };
}

/** Moves the pointer to a spot tapped on the preview and clicks there. */
export async function clickOnScreen(name: string, x: number, y: number): Promise<"ok" | "no-clicks" | "no-monitor"> {
  if (!(await readInputSupport()).clicks) return "no-clicks";
  const monitor = (await hyprJson<Monitor[]>("monitors"))?.find((candidate) => candidate.name === name);
  if (!monitor) return "no-monitor";
  const point = layoutPoint(monitor, x, y);
  await dispatch(dsp.moveCursor(point.x, point.y));
  await run(["ydotool", "click", "0xC0"]);
  return "ok";
}
