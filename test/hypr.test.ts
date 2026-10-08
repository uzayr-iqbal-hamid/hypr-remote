import { describe, expect, test } from "bun:test";

import { dsp, luaString, syntaxOf, wrongSyntax } from "../src/hypr";

const ADDRESS = "0x55d0c0ffee00";

describe("dsp", () => {
  test("writes each dispatcher as a hyprlang string", () => {
    expect(dsp.workspace(2).legacy).toBe("workspace 2");
    expect(dsp.focusWindow(ADDRESS).legacy).toBe(`focuswindow address:${ADDRESS}`);
    expect(dsp.closeWindow(ADDRESS).legacy).toBe(`closewindow address:${ADDRESS}`);
    expect(dsp.killWindow(ADDRESS).legacy).toBe(`killwindow address:${ADDRESS}`);
    expect(dsp.toggleFloating(ADDRESS).legacy).toBe(`togglefloating address:${ADDRESS}`);
    expect(dsp.fullscreen().legacy).toBe("fullscreen 0");
    expect(dsp.moveWindow(ADDRESS, 3).legacy).toBe(`movetoworkspacesilent 3,address:${ADDRESS}`);
    expect(dsp.moveCursor(10, 20).legacy).toBe("movecursor 10 20");
    expect(dsp.exec("hyprlock").legacy).toBe("exec hyprlock");
  });

  test("writes each dispatcher as a Lua expression", () => {
    expect(dsp.workspace(2).lua).toBe("hl.dsp.focus({ workspace = 2 })");
    expect(dsp.focusWindow(ADDRESS).lua).toBe(`hl.dsp.focus({ window = "address:${ADDRESS}" })`);
    expect(dsp.closeWindow(ADDRESS).lua).toBe(`hl.dsp.window.close({ window = "address:${ADDRESS}" })`);
    expect(dsp.killWindow(ADDRESS).lua).toBe(`hl.dsp.window.kill({ window = "address:${ADDRESS}" })`);
    expect(dsp.toggleFloating(ADDRESS).lua).toBe(`hl.dsp.window.float({ window = "address:${ADDRESS}" })`);
    expect(dsp.fullscreen().lua).toBe(`hl.dsp.window.fullscreen({ mode = "fullscreen" })`);
    expect(dsp.moveWindow(ADDRESS, 3).lua).toBe(
      `hl.dsp.window.move({ window = "address:${ADDRESS}", workspace = 3, follow = false })`,
    );
    expect(dsp.moveCursor(10, 20).lua).toBe("hl.dsp.cursor.move({ x = 10, y = 20 })");
    expect(dsp.exec("hyprlock").lua).toBe(`hl.dsp.exec_cmd("hyprlock")`);
  });
});

describe("luaString", () => {
  test("leaves a plain string alone", () => {
    expect(luaString("xdg-open 'https://example.com/?q=1&r=2'")).toBe(`"xdg-open 'https://example.com/?q=1&r=2'"`);
  });

  test("escapes what would end the string or the line", () => {
    expect(luaString(`a"b`)).toBe(`"a\\034b"`);
    expect(luaString("a\\b")).toBe(`"a\\092b"`);
    expect(luaString("a\nb")).toBe(`"a\\010b"`);
  });

  test.skipIf(!Bun.which("luajit"))("survives a real Lua unchanged", () => {
    for (const value of [
      `") os.execute("id") --`,
      `\\") os.execute("id") --`,
      "]] .. os.getenv('HOME') .. [[",
      "tab\there, newline\nhere, return\rhere",
      "trailing backslash \\",
      "digits right after a quote \"123",
      "ünïcödé ✓",
    ]) {
      const result = Bun.spawnSync(["luajit", "-e", `io.write(${luaString(value)})`]);
      expect(result.stdout.toString()).toBe(value);
    }
  });
});

describe("syntaxOf", () => {
  test("reads the config provider from status", () => {
    expect(syntaxOf({ configProvider: "hyprlang" })).toBe("legacy");
    expect(syntaxOf({ configProvider: "lua" })).toBe("lua");
  });

  test("takes a Hyprland too old to say for hyprlang", () => {
    expect(syntaxOf({})).toBe("legacy");
    expect(syntaxOf(null)).toBe("legacy");
  });
});

describe("wrongSyntax", () => {
  const luaError =
    `error: [string "return hl.dispatch(workspace 2)"]:1: ')' expected near '2'\n\n` +
    " → Note: dispatch in lua is a shorthand for hl.dispatch(...), your syntax might need to be updated.";

  test("spots a dispatcher string sent to Lua", () => {
    expect(wrongSyntax("legacy", luaError)).toBe(true);
    expect(wrongSyntax("legacy", "ok")).toBe(false);
  });

  test("spots a Lua expression sent to hyprlang", () => {
    expect(wrongSyntax("lua", "Invalid dispatcher\n")).toBe(true);
    expect(wrongSyntax("lua", "ok")).toBe(false);
    expect(wrongSyntax("lua", luaError)).toBe(false);
  });
});
