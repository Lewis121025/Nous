import { describe, expect, it } from "vitest";
import { parseLinkKind, parseMentionKind } from "../../../apps/desktop/src/shared/api";

describe("parseMentionKind", () => {
  it("accepts linked and unlinked and rejects anything else", () => {
    expect(parseMentionKind("linked")).toBe("linked");
    expect(parseMentionKind("unlinked")).toBe("unlinked");
    expect(parseMentionKind("nope")).toBeNull();
  });
});

describe("parseLinkKind", () => {
  it("accepts wiki and md and rejects anything else", () => {
    expect(parseLinkKind("wiki")).toBe("wiki");
    expect(parseLinkKind("md")).toBe("md");
    expect(parseLinkKind("nope")).toBeNull();
  });
});
