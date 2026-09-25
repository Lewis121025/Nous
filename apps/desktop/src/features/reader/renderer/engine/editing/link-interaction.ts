import { Plugin } from "prosemirror-state";
import type { LinkKind } from "../../../shared/api";
import { hasUrlScheme } from "../../../shared/link-target";

/**
 * 编辑表面始终保留普通点击的光标与选区语义，仅修饰键点击打开链接或本地图片。
 * @param open 经工作区保存门禁与目标校验的打开操作。
 * @returns 拦截浏览器原生链接导航的插件，不直接操作磁盘或外部浏览器。
 */
export function linkInteraction(open: (kind: LinkKind, raw: string) => void): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        click(_view, event) {
          if (!(event.target instanceof Element) || event.button !== 0) return false;
          const anchor = event.target.closest("a[href]");
          // 浏览器默认导航不能接管 Electron 窗口；普通点击仍由编辑器处理选区。
          if (anchor !== null) event.preventDefault();
          if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false;
          const wiki = event.target.closest<HTMLElement>("[data-wiki-target]");
          const image = event.target.closest<HTMLImageElement>("img[data-image-src]");
          const target =
            anchor?.getAttribute("href") ??
            wiki?.dataset["wikiTarget"] ??
            image?.dataset["imageSrc"];
          if (!target || (anchor === null && wiki === null && hasUrlScheme(target))) return false;
          event.preventDefault();
          open(
            anchor !== null
              ? "md"
              : wiki !== null || image?.dataset["imageKind"] === "wiki"
                ? "wiki"
                : "md",
            target,
          );
          return true;
        },
      },
    },
  });
}
