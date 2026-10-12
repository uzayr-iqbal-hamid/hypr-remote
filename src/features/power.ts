import { dispatch, dsp } from "../hypr";
import { run } from "../run";

/**
 * Launched through Hyprland rather than as our child, so the lock screen
 * outlives this server and isn't killed if its service restarts.
 */
export async function lockScreen() {
  await dispatch(dsp.exec("hyprlock"));
}

const SYSTEMCTL = { sleep: "suspend", restart: "reboot", "shut-down": "poweroff" } as const;
export type PowerOp = keyof typeof SYSTEMCTL;

/**
 * Each of these ends the connection to the phone, so the caller replies first
 * and this runs a moment later.
 */
export async function powerOff(op: PowerOp) {
  await run(["systemctl", SYSTEMCTL[op]]);
}
