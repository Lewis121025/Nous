import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSession, parseSession, patchSession, serializeSession } from "../../../apps/desktop/src/main/session";

describe("desktop session", () => {
  it("parses a complete session object", () => {
    const parsed = parseSession(
      JSON.stringify({
        vaultRoot: "/notes",
        currentPath: "a.md",
        window: { x: 10, y: 20, width: 800, height: 600, maximized: false },
        filesCollapsed: true,
        outlineCollapsed: false,
      }),
    );
    expect(parsed).toEqual({
      vaultRoot: "/notes",
      currentPath: "a.md",
      window: { x: 10, y: 20, width: 800, height: 600, maximized: false },
      filesCollapsed: true,
      outlineCollapsed: false,
    });
  });

  it("defaults missing pane flags to expanded", () => {
    const parsed = parseSession(
      JSON.stringify({
        vaultRoot: "/notes",
        currentPath: "a.md",
        window: null,
      }),
    );
    expect(parsed?.filesCollapsed).toBe(false);
    expect(parsed?.outlineCollapsed).toBe(false);
  });

  it("rejects invalid json and non-objects", () => {
    expect(parseSession("{")).toBeNull();
    expect(parseSession("[]")).toBeNull();
    expect(parseSession("null")).toBeNull();
  });

  it("roundtrips through a session file and patches fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-session-"));
    const file = join(dir, "session.json");
    writeFileSync(file, serializeSession({ vaultRoot: "/a", currentPath: null, window: null, filesCollapsed: false, outlineCollapsed: false }));
    expect(loadSession(file).vaultRoot).toBe("/a");
    const next = patchSession(file, { currentPath: "x.md" });
    expect(next).toEqual({
      vaultRoot: "/a",
      currentPath: "x.md",
      window: null,
      filesCollapsed: false,
      outlineCollapsed: false,
    });
    expect(loadSession(file).currentPath).toBe("x.md");
  });

  it("returns empty session when the file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "nous-session-"));
    expect(loadSession(join(dir, "missing.json"))).toEqual({
      vaultRoot: null,
      currentPath: null,
      window: null,
      filesCollapsed: false,
      outlineCollapsed: false,
    });
  });
});
