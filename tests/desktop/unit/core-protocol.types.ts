import type { CoreClient } from "../../../apps/desktop/src/main/core-client";
import type { CoreRequest } from "../../../apps/desktop/src/main/core-protocol";
import type { FileSnapshot, WriteResult } from "../../../apps/desktop/src/shared/api";

// 本文件由桌面端类型检查编译，不执行请求；用于锁定协议的编译期约束。
declare const client: CoreClient;

const read: CoreRequest = { type: "call", id: 1, command: "fileRead", args: ["note.md"] };
if (read.command === "fileRead") {
  const path: string = read.args[0];
  void path;
}

// @ts-expect-error 命令和参数必须成对匹配，不能把其他命令的参数套给 fileRead。
const mismatched: CoreRequest = { type: "call", id: 2, command: "fileRead", args: [] };
void mismatched;

// @ts-expect-error 读取文件必须指定库内路径。
client.call("fileRead");
// @ts-expect-error 保存必须提供明确的编辑基准，不能省略冲突检查。
client.call("fileWrite", "note.md", new Uint8Array());
// @ts-expect-error 链接种类由协议限定。
client.call("linksResolve", "note.md", "target", "url");

const snapshot: Promise<FileSnapshot> = client.call("fileSnapshot", "note.md");
const saved: Promise<WriteResult> = client.call("fileWrite", "note.md", new Uint8Array(), null);
void snapshot;
void saved;
