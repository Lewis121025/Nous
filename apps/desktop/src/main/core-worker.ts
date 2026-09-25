import { parentPort, workerData } from "node:worker_threads";
import { createCoreService, type CoreService } from "./core-service";
import type { CoreCommand, CoreInput, CoreOutput, CoreRequest } from "./core-protocol";

const port = parentPort;
if (port === null || typeof workerData !== "string") {
  throw new Error("内核线程缺少主进程通道或数据目录");
}

const send = (message: CoreOutput): void => port.postMessage(message);

// 服务结果是无环数据，字节已复制为独占缓冲区；只转移返回值，绝不转移保存请求。
function resultBuffers(value: unknown, buffers = new Set<ArrayBuffer>()): Set<ArrayBuffer> {
  if (value instanceof Uint8Array) {
    if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) resultBuffers(item, buffers);
  }
  return buffers;
}

const service = createCoreService(workerData, (event) => send({ type: "changed", event }));

// 映射签名保留命令与参数的对应关系，新增命令不需要额外分派分支或类型断言。
const commands: {
  [C in CoreCommand]: (...args: Parameters<CoreService[C]>) => ReturnType<CoreService[C]>;
} = service;

function execute<C extends CoreCommand>(request: CoreRequest<C>): unknown {
  return commands[request.command](...request.args);
}

// 同步完成一条消息后才接下一条，保留保存、切库、停机的提交顺序。
port.on("message", (request: CoreInput) => {
  if (request.type === "shutdown") {
    service.shutdown();
    send({ type: "stopped" });
    port.close();
    return;
  }
  try {
    const value = execute(request);
    port.postMessage({ type: "result", id: request.id, value } satisfies CoreOutput, [
      ...resultBuffers(value),
    ]);
  } catch (error) {
    send({
      type: "error",
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
