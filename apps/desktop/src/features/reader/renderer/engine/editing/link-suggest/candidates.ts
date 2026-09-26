/**
 * 链接补全候选排序：编辑器内联补全、链接对话框与源码模式共用。
 *
 * 纯函数、零依赖。排序规则可解释：
 *
 * 1. 子串命中优先于子序列（模糊）命中；
 * 2. 子串命中越靠前越好，命中文件名或路径段开头有额外加分；
 * 3. 子序列命中按跨度打分，跨度越短越好；
 * 4. 空查询保持传入顺序（库文件列表本身按路径排序）。
 */

/** 一条补全候选。 */
export type LinkSuggestion = {
  /** 应插入到光标处的文本。 */
  value: string;
  /** 展示主行。 */
  label: string;
  /** 展示副行；空串表示没有。 */
  detail: string;
};

/** 弹层一次展示的候选上限。 */
export const SUGGESTION_LIMIT = 8;

/**
 * 库内 Markdown 路径的补全排序。
 *
 * @param query 已输入的目标片段；空串返回前 `SUGGESTION_LIMIT` 条。
 * @param files 库内相对路径（调用方已过滤 `.md`）。
 */
export function rankFileCandidates(query: string, files: readonly string[]): LinkSuggestion[] {
  const needle = query.trim().toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of files) {
    const score = scoreFile(needle, path);
    if (score !== null) scored.push({ path, score });
  }
  scored.sort(
    (left, right) =>
      right.score - left.score || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  return scored.slice(0, SUGGESTION_LIMIT).map(({ path }) => ({
    value: path.slice(0, path.length - 3),
    label: basename(path),
    detail: path,
  }));
}

/**
 * 目标文件标题的锚点补全排序。
 *
 * @param query 已输入的锚点片段。
 * @param headings 目标文件的标题文本，按文档顺序。
 */
export function rankHeadingCandidates(
  query: string,
  headings: readonly string[],
): LinkSuggestion[] {
  const needle = query.trim().toLowerCase();
  const scored: Array<{ text: string; score: number; index: number }> = [];
  headings.forEach((text, index) => {
    const lower = text.toLowerCase();
    const at = needle === "" ? 0 : lower.indexOf(needle);
    if (needle === "" || at >= 0) scored.push({ text, score: 1000 - at - index * 0.01, index });
    else {
      const span = subsequenceSpan(lower, needle);
      if (span !== null) scored.push({ text, score: 500 - span, index });
    }
  });
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return scored.slice(0, SUGGESTION_LIMIT).map(({ text }) => ({
    value: text,
    label: text,
    detail: "标题",
  }));
}

/** 插入值去掉 `.md` 后缀；wiki 目标以无扩展名形式最常用。 */
function basename(path: string): string {
  const stem = path.slice(0, path.length - 3);
  return stem.slice(stem.lastIndexOf("/") + 1);
}

function scoreFile(needle: string, path: string): number | null {
  if (needle === "") return 1;
  const lower = path.toLowerCase();
  const stem = lower.slice(0, lower.length - 3);
  const name = stem.slice(stem.lastIndexOf("/") + 1);
  const at = lower.indexOf(needle);
  if (at >= 0) {
    let score = 1000 - at;
    if (at === 0 || lower[at - 1] === "/") score += 300;
    if (name.startsWith(needle)) score += 200;
    return score;
  }
  const span = subsequenceSpan(lower, needle);
  return span === null ? null : 500 - span;
}

/** 子序列命中的首尾跨度；未命中返回 null。 */
function subsequenceSpan(haystack: string, needle: string): number | null {
  let from = 0;
  let start = -1;
  let end = -1;
  for (const ch of needle) {
    const at = haystack.indexOf(ch, from);
    if (at < 0) return null;
    if (start < 0) start = at;
    end = at + 1;
    from = at + 1;
  }
  return start < 0 ? null : end - start;
}
