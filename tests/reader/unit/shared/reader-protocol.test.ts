import { expect, it } from "vitest";
import {
  parseEmptyReply,
  parseEntryOutcome,
  parseLinkKindArgument,
  parseLinkRecords,
  parseMentions,
  parseNullablePath,
  parsePaneLayoutMessage,
  parseSavedCopy,
  parseVaultEntries,
  parseVaultRestore,
  parseWriteRequest,
  parseWriteResult,
} from "@reader/shared/reader-protocol";

const bytes = new TextEncoder().encode("中文 👩‍💻\r\n");

it("空文件与不存在的磁盘基准有效，但缺失基准和伪字节不能进入写盘", () => {
  const empty = new Uint8Array();
  expect(parseWriteRequest("空文件.md", empty, null)).toEqual({
    rel: "空文件.md",
    bytes: empty,
    expected: null,
  });
  expect(parseWriteRequest("笔记.md", bytes, bytes).expected).toBe(bytes);
  for (const invalid of [undefined, [], {}, "字节", 10]) {
    expect(() => parseWriteRequest("笔记.md", invalid, bytes)).toThrow();
    expect(() => parseWriteRequest("笔记.md", bytes, invalid)).toThrow();
  }
  for (const invalid of [undefined, false, "", "路径\0.md"])
    expect(() => parseNullablePath(invalid)).toThrow();
  expect(parseNullablePath(null)).toBeNull();
});

it("保存确认严格区分提交、冲突和未知响应，警告不会丢失", () => {
  expect(parseWriteResult({ status: "saved", warning: "索引稍后重试" })).toEqual({
    status: "saved",
    warning: "索引稍后重试",
  });
  expect(parseWriteResult({ status: "conflict", disk: bytes })).toEqual({
    status: "conflict",
    disk: bytes,
  });
  expect(parseWriteResult({ status: "conflict", disk: null })).toEqual({
    status: "conflict",
    disk: null,
  });
  for (const invalid of [
    null,
    true,
    {},
    { status: "saved" },
    { status: "saved", warning: false },
    { status: "conflict" },
    { status: "conflict", disk: [] },
  ])
    expect(() => parseWriteResult(invalid)).toThrow("无法确认保存结果");
  expect(parseSavedCopy({ path: "笔记 (副本).md", warning: null })).toEqual({
    path: "笔记 (副本).md",
    warning: null,
  });
  expect(() => parseSavedCopy({ path: "", warning: null })).toThrow("无法确认副本保存结果");
  for (const path of ["../副本.md", "/库外/副本.md", "目录/../副本.md"])
    expect(() => parseSavedCopy({ path, warning: null })).toThrow("无法确认副本保存结果");
  expect(() => parseEntryOutcome({ warning: {} })).toThrow("无法确认文件操作结果");
  expect(() => parseEmptyReply({ status: "failed" })).toThrow("未收到有效的操作确认");
  expect(parseEmptyReply(undefined)).toBeUndefined();
});

it("库与目录快照要求完整结构，不能把错误响应显示为空库或恢复文件夹", () => {
  expect(parseVaultRestore({ root: "/笔记", currentPath: null })).toEqual({
    root: "/笔记",
    currentPath: null,
  });
  expect(parseVaultRestore(null)).toBeNull();
  expect(() => parseVaultRestore({ root: "/笔记" })).toThrow();
  const entries = [
    { path: "目录", kind: "directory" },
    { path: "目录/草稿.md", kind: "file", recoveryOnly: true },
  ];
  expect(parseVaultEntries(entries)).toEqual(entries);
  for (const invalid of [
    [{ path: "目录", kind: "directory", recoveryOnly: true }],
    [{ path: "笔记.md", kind: "unknown" }],
    [{ path: false, kind: "file" }],
  ])
    expect(() => parseVaultEntries(invalid)).toThrow();
  expect(
    parsePaneLayoutMessage({ filesCollapsed: false, leftWidth: 232, vaultRoot: "/注入" }),
  ).toEqual({ filesCollapsed: false, leftWidth: 232 });
  for (const invalid of [
    {},
    { filesCollapsed: false, leftWidth: Infinity },
    { filesCollapsed: "false", leftWidth: 232 },
  ])
    expect(() => parsePaneLayoutMessage(invalid)).toThrow();
});

it("索引只接受明确语法及有效字节范围，错误记录不能被当作另一种链接", () => {
  const link = {
    fromPath: "来源.md",
    toRaw: "目标",
    toPath: null,
    kind: "wiki",
    startByte: 4,
    endByte: 12,
  };
  expect(parseLinkRecords([link])).toEqual([link]);
  expect(parseLinkKindArgument("wiki")).toBe("wiki");
  expect(parseLinkKindArgument("md")).toBe("md");
  expect(() => parseLinkKindArgument("unknown")).toThrow();
  for (const change of [
    { kind: "unknown" },
    { startByte: -1 },
    { endByte: 3 },
    { startByte: 1.5 },
    { endByte: Number.MAX_SAFE_INTEGER + 1 },
    { toPath: false },
  ])
    expect(() => parseLinkRecords([{ ...link, ...change }])).toThrow();
});

it("提及种类、分组和语法必须一致，保留当前纳秒时间字段的数值范围", () => {
  const mention = {
    fromPath: "来源.md",
    fromTitle: "来源",
    mtime: 1_790_000_000_000_000_000,
    startByte: 0,
    endByte: 6,
    snippet: "目标",
    toRaw: "目标",
    kind: "linked",
    linkKind: "wiki",
  };
  const result = {
    linked: [mention],
    unlinked: [{ ...mention, kind: "unlinked", linkKind: null }],
  };
  expect(parseMentions(result)).toEqual(result);
  for (const change of [
    { kind: "unknown" },
    { linkKind: null },
    { mtime: Infinity },
    { endByte: -1 },
  ])
    expect(() => parseMentions({ linked: [{ ...mention, ...change }], unlinked: [] })).toThrow();
  expect(() => parseMentions({ linked: [], unlinked: [mention] })).toThrow();
});
