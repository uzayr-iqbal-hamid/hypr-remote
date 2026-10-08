import { hyprSocket } from "./env";

/**
 * Talks to Hyprland's request socket directly instead of spawning hyprctl.
 * Same protocol hyprctl uses — write one command, read until Hyprland closes —
 * but without a process per call, which matters for the touchpad, where the
 * cursor moves sixty times a second.
 */
export function hyprRequest(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    Bun.connect({
      unix: hyprSocket("request"),
      socket: {
        open(socket) {
          socket.write(command);
        },
        data(_socket, chunk) {
          output += chunk.toString();
        },
        close() {
          resolve(output);
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
}

export async function hyprJson<T>(command: string): Promise<T | null> {
  try {
    return JSON.parse(await hyprRequest(`j/${command}`)) as T;
  } catch {
    return null;
  }
}

/**
 * One dispatcher call, written both ways. Hyprland configured in Lua takes
 * `hl.dsp.*` expressions and rejects the hyprlang dispatcher strings, and the
 * other way round, so every call carries both and `dispatch` picks.
 */
export type Dispatcher = { legacy: string; lua: string };

/** A Lua string literal. Commands carry URLs and file names sent from the phone. */
export function luaString(value: string): string {
  const escaped = value.replace(
    /[\\"\x00-\x1f\x7f]/g,
    (char) => `\\${String(char.charCodeAt(0)).padStart(3, "0")}`,
  );
  return `"${escaped}"`;
}

const windowSelector = (address: string) => `address:${address}`;

export const dsp = {
  workspace: (id: number): Dispatcher => ({
    legacy: `workspace ${id}`,
    lua: `hl.dsp.focus({ workspace = ${id} })`,
  }),
  focusWindow: (address: string): Dispatcher => ({
    legacy: `focuswindow ${windowSelector(address)}`,
    lua: `hl.dsp.focus({ window = ${luaString(windowSelector(address))} })`,
  }),
  closeWindow: (address: string): Dispatcher => ({
    legacy: `closewindow ${windowSelector(address)}`,
    lua: `hl.dsp.window.close({ window = ${luaString(windowSelector(address))} })`,
  }),
  killWindow: (address: string): Dispatcher => ({
    legacy: `killwindow ${windowSelector(address)}`,
    lua: `hl.dsp.window.kill({ window = ${luaString(windowSelector(address))} })`,
  }),
  toggleFloating: (address: string): Dispatcher => ({
    legacy: `togglefloating ${windowSelector(address)}`,
    lua: `hl.dsp.window.float({ window = ${luaString(windowSelector(address))} })`,
  }),
  /** Toggles fullscreen on the focused window. */
  fullscreen: (): Dispatcher => ({
    legacy: "fullscreen 0",
    lua: `hl.dsp.window.fullscreen({ mode = "fullscreen" })`,
  }),
  /** Moves a window without following it there. */
  moveWindow: (address: string, workspace: number): Dispatcher => ({
    legacy: `movetoworkspacesilent ${workspace},${windowSelector(address)}`,
    lua: `hl.dsp.window.move({ window = ${luaString(windowSelector(address))}, workspace = ${workspace}, follow = false })`,
  }),
  moveCursor: (x: number, y: number): Dispatcher => ({
    legacy: `movecursor ${x} ${y}`,
    lua: `hl.dsp.cursor.move({ x = ${x}, y = ${y} })`,
  }),
  /** Runs a shell command as a child of Hyprland rather than of this server. */
  exec: (command: string): Dispatcher => ({
    legacy: `exec ${command}`,
    lua: `hl.dsp.exec_cmd(${luaString(command)})`,
  }),
};

type Syntax = keyof Dispatcher;

/** Which syntax a reply to `status` calls for. Hyprland before Lua has no such field. */
export function syntaxOf(status: { configProvider?: string } | null): Syntax {
  const provider = status?.configProvider;
  return provider === undefined || provider === "hyprlang" ? "legacy" : "lua";
}

/**
 * Whether a reply says the call was written in the wrong syntax: Lua failing to
 * parse a dispatcher string, or hyprlang finding no dispatcher named `hl.dsp…`.
 */
export function wrongSyntax(syntax: Syntax, reply: string): boolean {
  return syntax === "legacy" ? reply.includes("hl.dispatch") : reply.trim() === "Invalid dispatcher";
}

let syntax: Syntax | null = null;

/** Resolves true when Hyprland answers "ok". */
export async function dispatch(call: Dispatcher): Promise<boolean> {
  try {
    syntax ??= syntaxOf(await hyprJson("status"));
    let reply = await hyprRequest(`dispatch ${call[syntax]}`);
    // The config can change provider under a running server, on a full reload.
    if (wrongSyntax(syntax, reply)) {
      syntax = syntax === "legacy" ? "lua" : "legacy";
      reply = await hyprRequest(`dispatch ${call[syntax]}`);
    }
    return reply.trim() === "ok";
  } catch {
    return false;
  }
}

export type Monitor = {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  /** 0 upright, 1 and 3 turned sideways, 4 and up flipped. */
  transform: number;
  focused: boolean;
  activeWorkspace: { id: number };
  model: string;
  dpmsStatus: boolean;
};

export type Client = {
  address: string;
  title: string;
  class: string;
  workspace: { id: number; name: string };
  monitor: number;
  focusHistoryID: number;
  fullscreen: number;
  floating: boolean;
};
