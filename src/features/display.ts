import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { CACHE_DIR } from "../env";
import { dispatch, dsp, hyprJson, type Monitor } from "../hypr";
import { installed, read, run } from "../run";

/* -------------------------------------------------------------------------- */
/* Brightness, one screen at a time                                           */
/* -------------------------------------------------------------------------- */

/**
 * `id` is "laptop" for the built-in panel, or the Hyprland output name
 * (HDMI-A-1) for a monitor reached over DDC/CI.
 */
export type Screen = { id: string; label: string; level: number | null };

/**
 * Why external screens have no slider, when they don't: ddcutil isn't
 * installed, or it can't open /dev/i2c-*. Null when there's nothing to fix.
 */
export type DdcProblem = "missing" | "no-access" | null;

export type Brightness = { screens: Screen[]; ddc: DdcProblem };

// A floor of 5%: a remote that can black out a screen can also strand you in
// front of one you can't read.
const FLOOR = 5;

export async function readBrightness(): Promise<Brightness> {
  const [laptop, external] = await Promise.all([readBacklight(), readExternal()]);
  return {
    screens: [...(laptop === null ? [] : [{ id: "laptop", label: "laptop", level: laptop }]), ...external.screens],
    ddc: external.problem,
  };
}

async function readBacklight(): Promise<number | null> {
  const [current, max] = await Promise.all([
    read(["brightnessctl", "--class=backlight", "get"]),
    read(["brightnessctl", "--class=backlight", "max"]),
  ]);
  if (!current || !max) return null;
  return Math.round((Number(current) / Number(max)) * 100);
}

/** Sets one screen, or every screen when `id` is left out (as scenes do). */
export async function setBrightness(level: number, id?: string) {
  const percent = Math.max(FLOOR, Math.min(100, Math.round(level)));
  const jobs: Promise<unknown>[] = [];
  if (!id || id === "laptop") {
    jobs.push(run(["brightnessctl", "--class=backlight", "--quiet", "set", `${percent}%`]));
  }
  for (const display of displays) {
    if (!id || id === display.output) jobs.push(setDdc(display, percent));
  }
  await Promise.all(jobs);
}

export async function changeBrightness(by: "up" | "down") {
  await run(["brightnessctl", "--class=backlight", "--quiet", "set", `5%${by === "up" ? "+" : "-"}`]);
}

/* -------------------------------------------------------------------------- */
/* External monitors over DDC/CI                                              */
/* -------------------------------------------------------------------------- */

type Display = { bus: number; output: string };

// Detection takes seconds, so it runs once per set of monitors rather than on
// every read; a monitor coming or going brings a new set.
let displays: Display[] = [];
let detectedFor = "";
let detectedAt = 0;
let problem: DdcProblem = null;
// Last known levels: a read can fail while a write is in flight on the bus.
const levels = new Map<string, number>();

async function readExternal(): Promise<{ screens: Screen[]; problem: DdcProblem }> {
  const monitors = (await hyprJson<Monitor[]>("monitors")) ?? [];
  const externals = monitors.filter((monitor) => !/^(eDP|LVDS|DSI)-/.test(monitor.name));
  if (externals.length === 0) return { screens: [], problem: null };
  if (!installed("ddcutil")) return { screens: [], problem: "missing" };

  const set = externals.map((monitor) => monitor.name).sort().join();
  // A monitor that didn't answer may be waking up: ask again, once a minute.
  const retry = displays.length < externals.length && Date.now() - detectedAt > 60_000;
  if (set !== detectedFor || retry) {
    detectedFor = set;
    detectedAt = Date.now();
    const result = await run(["ddcutil", "detect", "--terse"], { timeoutMs: 15_000 });
    displays = parseDetect(result.stdout);
    problem = displays.length === 0 && /permission|access/i.test(result.stderr + result.stdout) ? "no-access" : null;
  }

  const screens = await Promise.all(
    displays.map(async (display) => {
      const monitor = externals.find((candidate) => candidate.name === display.output);
      const output = await read(["ddcutil", "--bus", String(display.bus), "getvcp", "10", "--brief"]);
      const level = output ? parseVcp(output) : null;
      if (level !== null) levels.set(display.output, level);
      return {
        id: display.output,
        label: (monitor?.model || display.output).toLowerCase(),
        level: levels.get(display.output) ?? null,
      };
    }),
  );
  return { screens, problem };
}

/**
 * `ddcutil detect --terse`: a block per display, with its I2C bus and the DRM
 * connector ("card1-HDMI-A-1"), whose tail is Hyprland's output name.
 */
export function parseDetect(output: string): Display[] {
  const found: Display[] = [];
  for (const block of output.split(/\n(?=Display \d)/)) {
    const bus = /I2C bus:\s*\/dev\/i2c-(\d+)/.exec(block)?.[1];
    const connector = /DRM connector:\s*card\d+-(\S+)/.exec(block)?.[1];
    if (bus && connector) found.push({ bus: Number(bus), output: connector });
  }
  return found;
}

/** `getvcp 10 --brief`: "VCP 10 C 80 100", current then maximum. */
export function parseVcp(output: string): number | null {
  const match = /VCP 10 C (\d+) (\d+)/.exec(output);
  if (!match) return null;
  const [current, max] = [Number(match[1]), Number(match[2])];
  return max > 0 ? Math.round((current / max) * 100) : null;
}

// A DDC write takes up to a second, and a second one on the same bus while
// the first runs fails. One write per bus at a time; the newest level waits.
const writing = new Map<number, Promise<void>>();
const waiting = new Map<number, number>();

async function setDdc(display: Display, percent: number) {
  waiting.set(display.bus, percent);
  if (writing.has(display.bus)) return writing.get(display.bus);
  const job = (async () => {
    while (waiting.has(display.bus)) {
      const next = waiting.get(display.bus)!;
      waiting.delete(display.bus);
      levels.set(display.output, next);
      await run(["ddcutil", "--bus", String(display.bus), "setvcp", "10", String(next)], { timeoutMs: 10_000 });
    }
  })().finally(() => writing.delete(display.bus));
  writing.set(display.bus, job);
  return job;
}

/* -------------------------------------------------------------------------- */
/* Night light, through hyprsunset                                            */
/* -------------------------------------------------------------------------- */

export type NightLight = { on: boolean; temperature: number } | null;

export const WARMTH = { min: 2500, max: 6500, default: 4000 } as const;

// hyprsunset reports the last temperature even while it's showing true
// colour, so whether it's on is remembered here, and on disk across restarts,
// along with which hyprsunset process that's true of. Another tool (a login
// autostart, a keybind script) may stop and start its own; for one of those,
// its temperature is all there is to go on.
const STATE_FILE = join(CACHE_DIR, "night-light.json");
// hyprsunset's own default, which it also reports after starting with -i.
const NEUTRAL = 6000;
type NightState = { on: boolean; temperature: number; pid: number | null };
let night: NightState | null = null;

async function nightState(): Promise<NightState> {
  if (night) return night;
  const saved = await Bun.file(STATE_FILE)
    .json()
    .catch(() => null);
  night = {
    on: saved?.on === true,
    temperature: Number.isInteger(saved?.temperature) ? saved.temperature : WARMTH.default,
    pid: Number.isInteger(saved?.pid) ? saved.pid : null,
  };
  return night;
}

const hyprsunsetPid = async () => Number((await read(["pgrep", "-o", "-x", "hyprsunset"])) ?? "") || null;

async function hyprsunsetTemperature(): Promise<number | null> {
  const output = (await run(["hyprctl", "hyprsunset", "temperature"])).stdout.trim();
  return /^\d+$/.test(output) ? Number(output) : null;
}

export async function readNightLight(): Promise<NightLight> {
  if (!installed("hyprsunset")) return null;
  const state = await nightState();
  const pid = await hyprsunsetPid();
  // Not running: the screen is true colour.
  if (pid === null) return { on: false, temperature: state.temperature };
  if (pid === state.pid) return { on: state.on, temperature: state.temperature };
  // Someone else's hyprsunset: warm if it's below its neutral default.
  return judgeForeign(await hyprsunsetTemperature(), state.temperature);
}

/** A hyprsunset we didn't set, by the temperature it reports. */
export function judgeForeign(reported: number | null, remembered: number): { on: boolean; temperature: number } {
  if (reported === null || reported >= NEUTRAL) return { on: false, temperature: remembered };
  return { on: true, temperature: Math.max(WARMTH.min, reported) };
}

/** On at its last warmth, at a new warmth (which also turns it on), or off. */
export async function setNightLight(change: { on: boolean } | { temperature: number }) {
  if (!installed("hyprsunset")) return;
  const state = await nightState();
  if ("temperature" in change) {
    state.temperature = Math.max(WARMTH.min, Math.min(WARMTH.max, Math.round(change.temperature)));
    state.on = true;
  } else {
    state.on = change.on;
  }
  if (await ensureHyprsunset()) {
    await run(["hyprctl", "hyprsunset", ...(state.on ? ["temperature", String(state.temperature)] : ["identity"])]);
  }
  state.pid = await hyprsunsetPid();
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  await Bun.write(STATE_FILE, JSON.stringify(state));
}

/**
 * Starts hyprsunset showing true colour if it isn't running, through Hyprland
 * so it belongs to the session, and waits for it to answer.
 */
async function ensureHyprsunset(): Promise<boolean> {
  const answers = async () => (await hyprsunsetTemperature()) !== null;
  if (await answers()) return true;
  await dispatch(dsp.exec("hyprsunset -i"));
  for (let tries = 0; tries < 20; tries++) {
    await Bun.sleep(100);
    if (await answers()) return true;
  }
  return false;
}
