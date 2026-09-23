import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  DEFAULT_LEFT_WIDTH,
  DEFAULT_RIGHT_WIDTH,
  emptySession,
  loadSession,
  parsePaneLayout,
  parseSession,
  patchSession,
  serializeSession,
} from "../../../apps/desktop/src/main/session";

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "nous-session-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("desktop session", () => {
  it("parses a complete session object", () => {
    const parsed = parseSession(
      JSON.stringify({
        vaultRoot: "/notes",
        currentPath: "a.md",
        window: { x: 10, y: 20, width: 800, height: 600, maximized: false },
        filesCollapsed: true,
        leftWidth: 200,
        rightCollapsed: false,
        rightWidth: 320,
        rightSplit: true,
        rightSlots: [
          { viewId: "backlinks", pinnedPath: "a.md" },
          { viewId: "outline", pinnedPath: null },
        ],
        backlinksInDocument: true,
      }),
    );
    expect(parsed).toEqual({
      vaultRoot: "/notes",
      currentPath: "a.md",
      window: { x: 10, y: 20, width: 800, height: 600, maximized: false },
      filesCollapsed: true,
      leftWidth: 200,
      rightCollapsed: false,
      rightWidth: 320,
      rightSplit: true,
      rightSlots: [
        { viewId: "backlinks", pinnedPath: "a.md" },
        { viewId: "outline", pinnedPath: null },
      ],
      backlinksInDocument: true,
    });
  });

  it("maps old outlineCollapsed onto rightCollapsed and fills sidebar defaults", () => {
    const parsed = parseSession(
      JSON.stringify({
        vaultRoot: "/notes",
        currentPath: "a.md",
        window: null,
        filesCollapsed: false,
        outlineCollapsed: true,
      }),
    );
    expect(parsed?.rightCollapsed).toBe(true);
    expect(parsed?.leftWidth).toBe(DEFAULT_LEFT_WIDTH);
    expect(parsed?.rightWidth).toBe(DEFAULT_RIGHT_WIDTH);
    expect(parsed?.rightSplit).toBe(false);
    expect(parsed?.rightSlots).toEqual([{ viewId: "backlinks", pinnedPath: null }]);
    expect(parsed?.backlinksInDocument).toBe(false);
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
    expect(parsed?.rightCollapsed).toBe(false);
  });

  it("rejects invalid json and non-objects", () => {
    expect(parseSession("{")).toBeNull();
    expect(parseSession("[]")).toBeNull();
    expect(parseSession("null")).toBeNull();
  });

  it("roundtrips through a session file and patches fields", () => {
    const dir = temporaryDirectory();
    const file = join(dir, "session.json");
    writeFileSync(file, serializeSession(emptySession));
    expect(loadSession(file).vaultRoot).toBeNull();
    const next = patchSession(file, { vaultRoot: "/a", currentPath: "x.md" });
    expect(next.vaultRoot).toBe("/a");
    expect(next.currentPath).toBe("x.md");
    expect(next.rightSlots).toEqual([{ viewId: "backlinks", pinnedPath: null }]);
    expect(loadSession(file).currentPath).toBe("x.md");
  });

  it("returns empty session when the file is missing", () => {
    const dir = temporaryDirectory();
    expect(loadSession(join(dir, "missing.json"))).toEqual(emptySession);
  });

  it("parses pane layout without reading vaultRoot from the payload", () => {
    const panes = parsePaneLayout({
      vaultRoot: "/evil",
      currentPath: "stolen.md",
      filesCollapsed: true,
      leftWidth: 200,
      rightCollapsed: true,
      rightWidth: 320,
      rightSplit: false,
      rightSlots: [{ viewId: "outline", pinnedPath: "a.md" }],
      backlinksInDocument: true,
    });
    expect(panes).toEqual({
      filesCollapsed: true,
      leftWidth: 200,
      rightCollapsed: true,
      rightWidth: 320,
      rightSplit: false,
      rightSlots: [{ viewId: "outline", pinnedPath: "a.md" }],
      backlinksInDocument: true,
    });
    expect(panes).not.toHaveProperty("vaultRoot");
  });

  it("patching panes leaves vaultRoot and currentPath untouched", () => {
    const dir = temporaryDirectory();
    const file = join(dir, "session.json");
    writeFileSync(
      file,
      serializeSession({
        ...emptySession,
        vaultRoot: "/notes",
        currentPath: "a.md",
      }),
    );
    const panes = parsePaneLayout({
      filesCollapsed: true,
      leftWidth: 220,
      rightCollapsed: false,
      rightWidth: 300,
      rightSplit: true,
      rightSlots: [
        { viewId: "backlinks", pinnedPath: "a.md" },
        { viewId: "outline", pinnedPath: null },
      ],
      backlinksInDocument: true,
    });
    expect(panes).not.toBeNull();
    const next = patchSession(file, panes ?? {});
    expect(next.vaultRoot).toBe("/notes");
    expect(next.currentPath).toBe("a.md");
    expect(next.filesCollapsed).toBe(true);
    expect(next.rightSplit).toBe(true);
    expect(next.backlinksInDocument).toBe(true);
  });
});
