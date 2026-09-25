/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo } from "prosemirror-history";
import { search, getSearchState } from "prosemirror-search";
import SearchPanel from "@reader/renderer/components/editors/EditorSearch.svelte";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";

let view: EditorView;
let panel: ReturnType<typeof mount>;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  await unmount(panel);
  view.destroy();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("跨格式查找并替换正文，保留链接地址和公式；一次撤销恢复全部替换", () => {
  const host = document.createElement("div");
  const controls = document.createElement("div");
  document.body.append(controls, host);
  view = new EditorView(host, {
    state: EditorState.create({
      doc: parseMarkdown("# 目标\n\n目**标** 与 [目标](https://example.com/目标) 及 $目标$\n"),
      plugins: [history(), search()],
    }),
    handleScrollToSelection: () => true,
  });
  const before = serializeMarkdown(view.state.doc);
  panel = mount(SearchPanel, {
    target: controls,
    props: { view, state: view.state, onClose: () => {} },
  });
  flushSync();
  const inputs = controls.querySelectorAll("input");
  inputs[0]!.value = "目标";
  inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
  controls.querySelector<HTMLButtonElement>('[aria-label="替换选项"]')!.click();
  flushSync();
  inputs[1]!.value = "新词";
  inputs[1]!.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(document.activeElement).toBe(inputs[0]);
  expect(getSearchState(view.state)?.query.search).toBe("目标");
  [...controls.querySelectorAll("button")]
    .find((button) => button.textContent === "全部替换")!
    .click();
  const saved = serializeMarkdown(view.state.doc);
  expect(saved).toContain("# 新词");
  expect(saved).toContain("[新词](https://example.com/目标)");
  expect(saved).toContain("$目标$");
  expect(view.state.doc.textContent).not.toContain("目标");
  undo(view.state, view.dispatch);
  expect(serializeMarkdown(view.state.doc)).toBe(before);
});

it("查找默认收起替换；中文组词回车不跳转，任意控件可用 Escape 返回正文", () => {
  const host = document.createElement("div");
  const controls = document.createElement("div");
  document.body.append(controls, host);
  view = new EditorView(host, {
    state: EditorState.create({ doc: parseMarkdown("目标 目标"), plugins: [search()] }),
    handleScrollToSelection: () => true,
  });
  const onClose = vi.fn();
  panel = mount(SearchPanel, { target: controls, props: { view, state: view.state, onClose } });
  flushSync();
  const input = controls.querySelector<HTMLInputElement>('[aria-label="查找"]')!;
  const toggle = controls.querySelector<HTMLButtonElement>('[aria-label="替换选项"]')!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(controls.querySelector('[hidden] [aria-label="替换为"]')).not.toBeNull();
  input.value = "目标";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  const before = view.state.selection;
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
  );
  expect(view.state.selection.eq(before)).toBe(true);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(view.state.selection.empty).toBe(false);
  toggle.click();
  flushSync();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(controls.querySelector('[hidden] [aria-label="替换为"]')).toBeNull();
  toggle.focus();
  toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(view.hasFocus()).toBe(true);
  expect(view.state.doc.textContent).toBe("目标 目标");
});

it("查找组词期间不跳转、替换或退出，输入法结束键不冒充查找命令", () => {
  const host = document.createElement("div");
  const controls = document.createElement("div");
  document.body.append(controls, host);
  view = new EditorView(host, {
    state: EditorState.create({ doc: parseMarkdown("目标 目标"), plugins: [search()] }),
    handleScrollToSelection: () => true,
  });
  const onClose = vi.fn();
  panel = mount(SearchPanel, { target: controls, props: { view, state: view.state, onClose } });
  flushSync();
  const input = controls.querySelector('[aria-label="查找"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("缺少查找输入框");
  input.value = "目标";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  const before = view.state;
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  for (const button of controls.querySelectorAll("button")) button.click();
  expect(view.state.doc.eq(before.doc)).toBe(true);
  expect(view.state.selection.eq(before.selection)).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  for (const key of ["Enter", "Escape"]) {
    const event = new KeyboardEvent("keydown", { key, keyCode: 229, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(view.state.selection.eq(before.selection)).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(view.state.selection.empty).toBe(false);
});
