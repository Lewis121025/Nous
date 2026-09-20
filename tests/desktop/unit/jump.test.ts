/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount, type Component } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import DocumentEditor from "@renderer/DocumentEditor.svelte";
import type { MarkdownEditorApi } from "@renderer/engine/editor-api";
import type { OutlineItem } from "@renderer/engine/outline";

const OriginalScrollIntoView = HTMLElement.prototype.scrollIntoView;

describe("outline jump", () => {
  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = OriginalScrollIntoView;
  });

  it("scrolls the heading to the start of the reading pane, not just barely into view", () => {
    const scrolled: Array<{ tag: string; text: string; options: unknown }> = [];
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement, options?: unknown) {
      scrolled.push({
        tag: this.tagName,
        text: this.textContent?.trim() ?? "",
        options,
      });
    };

    const target = document.createElement("div");
    document.body.append(target);
    let api: MarkdownEditorApi | null = null;
    let outline: OutlineItem[] = [];
    const app = mount(DocumentEditor as Component, {
      target,
      props: {
        path: "Note.md",
        source: "# Alpha\n\nintro\n\n# Beta\n\nbody\n",
        onDirty: () => {},
        onSave: () => {},
        onOpenLink: () => {},
        onOutline: (items: OutlineItem[]) => {
          outline = items;
        },
        register: (next: MarkdownEditorApi | null) => {
          api = next;
        },
      },
    });
    flushSync();

    const beta = outline.find((item) => item.text === "Beta");
    expect(api).not.toBeNull();
    expect(beta).toBeDefined();
    api?.jumpTo(beta?.pos ?? -1);

    expect(scrolled).toContainEqual({
      tag: "H1",
      text: "Beta",
      options: { block: "start", inline: "nearest" },
    });

    unmount(app);
    target.remove();
  });
});
