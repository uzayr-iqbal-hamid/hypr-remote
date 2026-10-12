import { dispatch, dsp, hyprJson, type Client, type Monitor } from "../hypr";

export type Window = {
  address: string;
  title: string;
  app: string;
  workspace: number;
  focused: boolean;
  fullscreen: boolean;
  floating: boolean;
};

/** `name` is the id as text unless the workspace was given a name in Hyprland. */
export type Workspace = { id: number; name: string; windows: number; monitor: string };

export type DesktopSnapshot = {
  workspaces: Workspace[];
  activeWorkspace: number | null;
  activeWindow: string | null;
  windows: Window[];
  monitors: { name: string; label: string; focused: boolean; workspace: number }[];
};

export async function readDesktop(): Promise<DesktopSnapshot> {
  const [workspaces, active, clients, monitors] = await Promise.all([
    hyprJson<Workspace[]>("workspaces"),
    hyprJson<{ id: number }>("activeworkspace"),
    hyprJson<Client[]>("clients"),
    hyprJson<Monitor[]>("monitors"),
  ]);
  return toSnapshot(workspaces, active, clients, monitors);
}

/** Hyprland's replies, any of which may have failed, as the phone sees them. */
export function toSnapshot(
  workspaces: Workspace[] | null,
  active: { id: number } | null,
  clients: Client[] | null,
  monitors: Monitor[] | null,
): DesktopSnapshot {
  const windows = (clients ?? [])
    // Negative ids are special workspaces (scratchpads); not reachable here.
    .filter((client) => client.workspace.id > 0 && client.title !== "")
    .sort((a, b) => a.workspace.id - b.workspace.id || a.focusHistoryID - b.focusHistoryID)
    .map((client) => ({
      address: client.address,
      title: client.title,
      app: appName(client.class),
      workspace: client.workspace.id,
      focused: client.focusHistoryID === 0,
      fullscreen: client.fullscreen > 0,
      floating: client.floating,
    }));

  return {
    workspaces: (workspaces ?? [])
      .filter((workspace) => workspace.id > 0)
      .map(({ id, name, windows, monitor }) => ({ id, name, windows, monitor }))
      .sort((a, b) => a.id - b.id),
    activeWorkspace: active?.id ?? null,
    activeWindow: windows.find((window) => window.focused)?.title ?? null,
    windows,
    monitors: (monitors ?? []).map((monitor) => ({
      name: monitor.name,
      label: monitorLabel(monitor),
      focused: monitor.focused,
      workspace: monitor.activeWorkspace.id,
    })),
  };
}

/** "laptop" for a built-in panel, otherwise the model ("benq gw2255"). */
export function monitorLabel(monitor: Pick<Monitor, "name" | "model">): string {
  if (/^(eDP|LVDS|DSI)-/.test(monitor.name)) return "laptop";
  return (monitor.model.trim() || monitor.name).toLowerCase();
}

// Last segments of reverse-DNS classes that say nothing about the app.
const GENERIC = new Set(["desktop", "app", "application", "client", "bin"]);

/**
 * A window class as a person would say it: `org.gnome.Nautilus` is nautilus,
 * `org.telegram.desktop` is telegram, `youtube_music` is youtube music.
 */
export function appName(windowClass: string): string {
  const parts = windowClass.toLowerCase().split(".").filter(Boolean);
  while (parts.length > 1 && GENERIC.has(parts.at(-1)!)) parts.pop();
  return (parts.at(-1) ?? "").replaceAll("_", " ");
}

/**
 * With `binds:workspace_back_and_forth` on, switching to the workspace you're
 * already on jumps back to the previous one — from a remote, that reads as the
 * button doing something random. So the current workspace is a no-op.
 */
export async function switchWorkspace(id: number) {
  const active = await hyprJson<{ id: number }>("activeworkspace");
  if (active?.id === id) return;
  await dispatch(dsp.workspace(id));
}

export type WindowOp = "focus" | "close" | "fullscreen" | "float" | "kill";

/** Addresses are validated as 0x-hex by the action schema before arriving here. */
export async function windowCommand(op: WindowOp, address: string) {
  switch (op) {
    case "focus":
      await dispatch(dsp.focusWindow(address));
      break;
    // Asks politely, as the close button would: unsaved work gets a prompt.
    case "close":
      await dispatch(dsp.closeWindow(address));
      break;
    // For frozen apps that ignore a polite close.
    case "kill":
      await dispatch(dsp.killWindow(address));
      break;
    case "float":
      await dispatch(dsp.toggleFloating(address));
      break;
    // Hyprland's fullscreen only takes the focused window, so focus it first.
    case "fullscreen":
      if (await dispatch(dsp.focusWindow(address))) await dispatch(dsp.fullscreen());
      break;
  }
}

export async function moveWindow(address: string, workspace: number) {
  await dispatch(dsp.moveWindow(address, workspace));
}
