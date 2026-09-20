import { describe, expect, it } from "vitest";
import { uniqueBacklinks } from "@engine/backlinks";

describe("uniqueBacklinks", () => {
  it("keeps the first occurrence of each source file", () => {
    const links = [
      { fromPath: "A.md", startByte: 0 },
      { fromPath: "B.md", startByte: 10 },
      { fromPath: "A.md", startByte: 40 },
      { fromPath: "B.md", startByte: 80 },
    ];
    expect(uniqueBacklinks(links).map((item) => item.fromPath)).toEqual(["A.md", "B.md"]);
    expect(uniqueBacklinks(links)[0]?.startByte).toBe(0);
  });
});
