import { contextBridge } from "electron";
import type { NousApi } from "../shared/api";

const api: NousApi = {};

contextBridge.exposeInMainWorld("nous", api);
