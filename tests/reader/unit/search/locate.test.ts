import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { findSearchMatchPmPos } from "@reader/renderer/engine/search/locate";

describe("findSearchMatchPmPos", () => {
  it("大小写不敏感定位正文首次出现", () => {
    const doc = parseMarkdown("Intro TOKEN then token again");
    const pos = findSearchMatchPmPos(doc, "token");
    expect(pos).not.toBeNull();
    expect(doc.textBetween(pos ?? 0, (pos ?? 0) + 5)).toBe("TOKEN");
  });

  it("围栏代码里的命中可定位，与全文索引覆盖范围一致", () => {
    const doc = parseMarkdown("```js\nconst TOKEN = 1;\n```\n\nafter");
    const pos = findSearchMatchPmPos(doc, "token");
    expect(pos).not.toBeNull();
    const $pos = doc.resolve(pos ?? 0);
    expect($pos.parent.type.name).toBe("code_block");
  });

  it("数学源码与 HTML 标签语法不参与定位，标签之间的正文照常可定位", () => {
    const doc = parseMarkdown("<b>markup</b>\n\n$latent$");
    // 与内核全文索引一致：内联 HTML 的标签本身与公式源码不进索引，
    // 标签之间的正文是普通文本，两侧都覆盖。
    expect(findSearchMatchPmPos(doc, "markup")).not.toBeNull();
    expect(findSearchMatchPmPos(doc, "latent")).toBeNull();
  });

  it("wiki 目标没有文本子节点，按属性第二遍定位到链接节点", () => {
    const doc = parseMarkdown("see [[Topic]] here");
    const pos = findSearchMatchPmPos(doc, "Topic");
    expect(pos).not.toBeNull();
    expect(doc.nodeAt(pos ?? -1)?.type.name).toBe("wiki_link");
  });

  it("正文文本优先于属性命中", () => {
    const doc = parseMarkdown("plain Topic text\n\n[[Topic]]");
    const pos = findSearchMatchPmPos(doc, "Topic");
    expect(doc.nodeAt(pos ?? -1)?.isText).toBe(true);
  });

  it("空词与未命中返回 null", () => {
    const doc = parseMarkdown("content");
    expect(findSearchMatchPmPos(doc, "")).toBeNull();
    expect(findSearchMatchPmPos(doc, "absent")).toBeNull();
  });
});
