import { describe, expect, it } from "vitest";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";

function embeds(source: string) {
  const doc = parseMarkdown(source);
  const out: { target: string; alias: string | null; anchor: string | null }[] = [];
  doc.descendants((node) => {
    if (node.type.name === "note_embed") {
      out.push({
        target: String(node.attrs["target"] ?? ""),
        alias: (node.attrs["alias"] as string | null) ?? null,
        anchor: (node.attrs["anchor"] as string | null) ?? null,
      });
    }
  });
  return out;
}

describe("笔记嵌入", () => {
  it("独立的笔记嵌入往返为 wiki 嵌入，图片嵌入仍然是图片", () => {
    expect(embeds("![[笔记]]\n")).toEqual([{ target: "笔记", alias: null, anchor: null }]);
    expect(embeds("![[笔记#小节|别名]]\n")).toEqual([
      { target: "笔记", alias: "别名", anchor: "小节" },
    ]);
    expect(embeds("![[笔记#^bid]]\n")).toEqual([
      { target: "笔记", alias: null, anchor: "^bid" },
    ]);
    const saved = serializeMarkdown(parseMarkdown("![[笔记#小节|别名]]\n"));
    expect(saved).toContain("![[笔记#小节|别名]]");
    expect(embeds("See ![[笔记]].\n")).toEqual([]);
    expect(embeds("![[shot.jpg]]\n")).toEqual([]);
  });

  it("嵌入内容自身不再展开嵌套嵌入", () => {
    const doc = parseMarkdown("![[其它]]\n", { embeds: false });
    let count = 0;
    doc.descendants((node) => {
      if (node.type.name === "note_embed") count += 1;
    });
    expect(count).toBe(0);
  });
});
