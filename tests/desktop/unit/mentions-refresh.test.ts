import { describe, expect, it } from "vitest";
import type { Mentions } from "../../../apps/desktop/src/shared/api";
import { commitMentionsRefresh } from "@engine/mentions-refresh";

const topic: Mentions = {
  linked: [],
  unlinked: [],
};

const other: Mentions = {
  linked: [
    {
      fromPath: "A.md",
      fromTitle: "A",
      mtime: 1,
      startByte: 0,
      endByte: 1,
      snippet: "[[B]]",
      kind: "linked",
      linkKind: "wiki",
      toRaw: "B",
    },
  ],
  unlinked: [],
};

describe("commitMentionsRefresh", () => {
  it("discards a stale generation so an older fetch cannot blank the current note", () => {
    const committed = commitMentionsRefresh({
      startedGen: 1,
      latestGen: 2,
      current: "B.md",
      fetched: { "A.md": topic, "Pin.md": other },
    });
    expect(committed).toBeNull();
  });

  it("applies the fetch that still matches the latest generation", () => {
    const committed = commitMentionsRefresh({
      startedGen: 2,
      latestGen: 2,
      current: "B.md",
      fetched: { "B.md": other, "Pin.md": topic },
    });
    expect(committed).toEqual({
      mentionCache: { "B.md": other, "Pin.md": topic },
      followMentions: other,
    });
  });
});
