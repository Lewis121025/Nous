import type { LinkKind, ReaderApi, VaultEntry, RenameOutcome } from "../../shared/api";
import { externalUrl, hasUrlScheme } from "../../shared/link-target";
import type { AttachmentImporter } from "../../shared/attachments";
import { createAutosave } from "../engine/document/autosave";
import { ReaderDocument } from "./document.svelte";
import { ReaderNavigation } from "./navigation.svelte";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 成功反馈只属于产生它的文档版本；需要处理的错误不随输入自动消失。 */
type WorkspaceNotice =
  | { kind: "attention"; source: "operation" | "save"; message: string; detail: string }
  | { kind: "confirmation"; message: string; epoch: number; revision: number };

/**
 * 工作区协调器：拥有笔记库、文件列表与串行切换门禁，文档和导航各自拥有内部状态。
 * 所有离开当前文档的操作先冲刷保存；监视事件在切换或写盘结束后重新读取。
 */
export class ReaderWorkspaceController {
  /** 唯一活动文档，不暴露编辑器实例给工作区视图。 */
  readonly document: ReaderDocument;
  /** 与当前文档绑定的目录、引用与定位。 */
  readonly navigation: ReaderNavigation;
  private root = $state<string | null>(null);
  private listed = $state<VaultEntry[]>([]);
  private filePaths = $derived(
    this.listed.filter((entry) => entry.kind === "file").map((entry) => entry.path),
  );
  private notice = $state<WorkspaceNotice | null>(null);
  private backgroundError = $state("");
  private transitioning = $state(true);
  private duplicating = $state(false);
  private composing = $state(false);
  private refreshEpoch = 0;
  private pendingRefresh = false;
  private idleWaiters: Array<() => void> = [];
  private compositionWaiters: Array<() => void> = [];
  private readonly autosave;

  /** @param api 外壳注入的阅读器能力；构造不订阅事件，挂载时由 start 订阅。 */
  constructor(private readonly api: ReaderApi) {
    this.document = new ReaderDocument(api);
    this.navigation = new ReaderNavigation(this.document);
    this.autosave = createAutosave({
      isDirty: () => this.document.dirty && !this.composing,
      save: () => this.persist(),
    });
  }

  /** 当前库根路径。 */
  get vaultRoot() {
    return this.root;
  }
  /** 当前库的文件列表。 */
  get files() {
    return this.filePaths;
  }
  /** 包含空文件夹的目录快照。 */
  get entries() {
    return this.listed;
  }
  /** 文件操作的结果提示。 */
  get message() {
    const notice = this.notice;
    if (notice === null) return "";
    if (
      notice.kind === "confirmation" &&
      (notice.epoch !== this.document.epoch || notice.revision !== this.document.editRevision)
    )
      return "";
    return notice.message;
  }
  /** 操作错误与警告使用明确提示；普通成功消息不抢占辅助技术的即时播报。 */
  get messageNeedsAttention() {
    return this.notice?.kind === "attention";
  }
  /** 技术详情仅在用户展开后显示；即时播报只包含影响和处理建议。 */
  get messageDetail() {
    return this.notice?.kind === "attention" ? this.notice.detail : "";
  }
  /** 后台失败单独展示，不能被普通文件操作或成功保存抹掉。 */
  get healthMessage() {
    return this.backgroundError;
  }
  /** 切换期间界面禁止编辑，避免异步加载覆盖输入。 */
  get switching() {
    return this.transitioning;
  }
  /** 副本写入期间仍允许编辑，但不能切换文件。 */
  get copying() {
    return this.duplicating;
  }

  /** 组词期间允许继续编辑，但暂停提交、离开文档与外部重载。 */
  get isComposing() {
    return this.composing;
  }

  /** @param active 原生输入法是否仍持有未确认的候选文本。结束后重新计时并恢复外部刷新。 */
  setComposing(active: boolean): void {
    if (active === this.composing) return;
    this.composing = active;
    if (active) this.autosave.dispose();
    else {
      const waiters = this.compositionWaiters;
      this.compositionWaiters = [];
      for (const resolve of waiters) resolve();
      if (this.document.dirty) this.autosave.touch();
      this.resumeVaultRefresh();
    }
  }

  /**
   * @param message 布局等操作的影响与处理建议；空字符串表示清除操作消息。
   * @param error 可选原始错误，保留在可展开详情中，不混入即时播报。
   */
  report(message: string, error?: unknown): void {
    this.notice =
      message === ""
        ? null
        : {
            kind: "attention",
            source: "operation",
            message,
            detail: error === undefined ? "" : errorText(error),
          };
  }

  /** 用户已查看操作消息；保存冲突与后台故障仍由各自状态保留。 */
  dismissMessage = (): void => {
    this.notice = null;
  };

  private announce(message: string): void {
    this.notice =
      message === ""
        ? null
        : {
            kind: "confirmation",
            message,
            epoch: this.document.epoch,
            revision: this.document.editRevision,
          };
  }

  /** 捕获附件所属的库、路径和编辑会话；异步读取结束后不能借用新文档的身份。 */
  captureAttachmentImporter(): AttachmentImporter {
    const root = this.root;
    const path = this.document.path;
    const epoch = this.document.epoch;
    return (name, bytes) => {
      if (root === null || path === null || epoch !== this.document.epoch || root !== this.root)
        return Promise.reject(new Error("文档已切换，请回到原笔记重新插入附件"));
      return this.api.attachmentImport(root, path, name, bytes);
    };
  }

  /**
   * 挂载时订阅笔记库变更；每个控制器只能由所属工作区挂载一次。
   * @returns 卸载清理函数，取消计时和监视订阅。
   */
  start(): () => void {
    const unsubscribe = this.api.subscribeVaultChanged((event) => {
      if (event.status === "changed") {
        if (event.healthy) this.backgroundError = "";
        void this.onVaultChanged();
      } else {
        const impact =
          event.status === "worker-error"
            ? "内核已停止，无法继续保存。请保留窗口并复制尚未保存的内容，再重启应用。"
            : event.status === "watch-error"
              ? "文件监视中断，外部修改可能不会及时出现。请重新打开笔记库。"
              : "索引刷新失败，检索和引用可能过期；正文仍可保存。请检查文件权限后重新打开笔记库。";
        this.backgroundError = `${impact} ${event.message}`;
      }
    });
    return () => {
      this.autosave.dispose();
      unsubscribe();
    };
  }

  /** 恢复上次笔记库和文档；失败显示原因，最终释放启动门禁。 */
  async restore(): Promise<void> {
    try {
      const restored = await this.api.vaultRestore();
      if (restored === null) return;
      this.root = restored.root;
      await this.refreshList();
      if (restored.currentPath !== null && this.files.includes(restored.currentPath)) {
        await this.loadFile(restored.currentPath);
      } else await this.api.sessionSetCurrent(null);
    } catch (error) {
      this.report(error instanceof Error ? error.message : "恢复会话失败");
    } finally {
      this.finishTransition();
    }
  }

  /** 打开用户选择的库；取消选择、冲突或保存失败时保留原库与编辑。 */
  openVault = async (): Promise<void> => {
    try {
      await this.withSavedDocument(async () => {
        const root = await this.api.vaultOpen();
        if (root === null) return;
        this.root = root;
        this.backgroundError = "";
        this.clearDocument();
        this.report("");
        await this.refreshList();
      });
    } catch (error) {
      this.report(`打开库失败：${errorText(error)}`);
    }
  };

  /** @param path 待打开的库内路径；保存门禁拒绝时保持当前文档。 */
  openFile = async (path: string): Promise<void> => {
    if (path === this.document.path) return;
    try {
      await this.withSavedDocument(() => this.loadFile(path));
    } catch (error) {
      this.report(`打开文件失败：${errorText(error)}`);
    }
  };

  /** @param kind 链接语法。@param raw 链接原文；过期解析结果不切换新文档。 */
  openLink = async (kind: LinkKind, raw: string): Promise<void> => {
    if (this.document.path === null || this.transitioning || this.duplicating || this.composing)
      return;
    const { path, epoch } = this.document;
    try {
      if (hasUrlScheme(raw)) {
        await this.api.openExternal(externalUrl(raw));
        return;
      }
      const to = await this.api.linksResolve(path, raw, kind);
      if (epoch !== this.document.epoch || this.transitioning || this.duplicating) return;
      if (to === null) {
        this.report("死链，无法跳转");
        return;
      }
      await this.openFile(to);
    } catch (error) {
      if (epoch === this.document.epoch) this.report(`打开链接失败：${errorText(error)}`);
    }
  };

  /** 编辑器变更后启动停键保存；附件不会产生写入。 */
  markDirty = (): void => {
    if (!this.document.canEdit) return;
    this.document.markDirty();
    if (!this.composing) this.autosave.touch();
  };

  /** 手动保存与快捷键复用同一串行调度。 */
  requestSave = (): void => {
    if (this.composing) return;
    void this.autosave.flush();
  };

  /**
   * 关闭请求等待正在进行的操作，再通过与文件切换相同的保存门禁。
   * @returns 当前操作完成且最新编辑安全保存时为 true；失败保留窗口与编辑。
   */
  async flushBeforeClose(): Promise<boolean> {
    if (this.composing) {
      this.report("请先完成输入法组词，再关闭窗口。");
      return false;
    }
    while (this.transitioning || this.duplicating)
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    const ready = await this.withSavedDocument(async () => true);
    if (!ready && this.message === "") this.report("当前编辑尚未保存，请处理后再关闭。");
    return ready === true;
  }

  /** 新建笔记后打开，新建文件夹时保留当前文档；返回对话框错误或 null。 */
  createEntry(path: string, kind: VaultEntry["kind"]): Promise<string | null> {
    return this.mutateEntries(
      "创建",
      () => this.api.entryCreate(path, kind),
      (current) => (kind === "file" ? path : current),
      false,
    );
  }

  /** 文件和文件夹统一移动；当前文档跟随新路径，其他笔记的链接更新后重新加载。 */
  renameEntry(from: string, to: string): Promise<string | null> {
    if (from === to) return Promise.resolve(null);
    return this.mutateEntries(
      "重命名或移动",
      () => this.api.entryRename(from, to),
      (current) => {
        if (current === from) return to;
        return current?.startsWith(`${from}/`) ? `${to}${current.slice(from.length)}` : current;
      },
      true,
    );
  }

  /** 移入系统废纸篓；关闭被删除目录中的当前文档，失败时保留编辑。 */
  trashEntry(path: string): Promise<string | null> {
    return this.mutateEntries(
      "移到废纸篓",
      () => this.api.entryTrash(path),
      (current) => (current === path || current?.startsWith(`${path}/`) ? null : current),
      false,
    );
  }

  /** 由主进程定位库内条目，错误通过工作区提示。 */
  revealEntry = async (path: string): Promise<void> => {
    try {
      await this.api.entryReveal(path);
    } catch (error) {
      this.report(`无法显示文件：${errorText(error)}`);
    }
  };

  private async mutateEntries(
    label: string,
    operation: () => Promise<RenameOutcome>,
    nextPath: (current: string | null) => string | null,
    reload: boolean,
  ): Promise<string | null> {
    let committed = false;
    let pathAfter: string | null = this.document.path;
    try {
      const completed = await this.withSavedDocument(async () => {
        const before = this.document.path;
        pathAfter = nextPath(before);
        const result = await operation();
        committed = true;
        if (pathAfter !== before || reload) {
          if (pathAfter === null) {
            this.clearDocument();
            await this.api.sessionSetCurrent(null);
          } else await this.loadFile(pathAfter);
        }
        await this.refreshList();
        this.report(result.warning === null ? "" : `操作已完成。${result.warning}`);
        return true;
      });
      // 门禁拒绝表示操作未执行，不能当作成功让对话框丢掉输入。
      if (!completed)
        return this.document.dirty
          ? "当前编辑尚未保存，请先处理保存问题后重试。"
          : "正在处理其他操作，请稍后重试。";
      return null;
    } catch (error) {
      if (!committed) return `${label}失败：${errorText(error)}`;
      if (reload || this.document.path !== pathAfter) this.clearDocument();
      this.report(
        `${label}已完成${pathAfter === null ? "" : `，当前路径 ${pathAfter}`}，但界面更新失败，请重新打开：${errorText(error)}`,
      );
      try {
        await this.refreshList();
      } catch (refreshError) {
        this.report(`${this.message}；文件列表刷新失败：${errorText(refreshError)}`);
      }
      return null;
    }
  }

  /** 另存副本保留原文件；写入期间输入由文档状态带入新路径。 */
  saveCopy = async (): Promise<void> => {
    const doc = this.document;
    if (
      doc.path === null ||
      this.transitioning ||
      this.duplicating ||
      this.composing ||
      doc.saving ||
      !doc.canEdit
    )
      return;
    this.duplicating = true;
    this.autosave.dispose();
    let savedPath: string | null = null;
    try {
      if (!(await this.navigation.settleAttachments())) {
        this.report("附件尚未完成导入，请重试剩余附件，或关闭附件错误提示后再另存。");
        return;
      }
      const copy = await doc.copy(this.navigation.snapshot, async () => {
        while (this.composing)
          await new Promise<void>((resolve) => this.compositionWaiters.push(resolve));
      });
      savedPath = copy.path;
      if (copy.refreshError !== null) throw new Error(copy.refreshError);
      this.navigation.resetReferences();
      if (copy.warning !== null) this.report(`副本已创建为 ${copy.path}。${copy.warning}`);
      else
        this.announce(
          `副本已保存为 ${copy.path}。${doc.dirty ? "后续编辑尚未保存。" : "原文件已保留。"}`,
        );
      await this.api.sessionSetCurrent(copy.path);
      await this.refreshList();
      await this.refreshMentions();
    } catch (error) {
      if (savedPath === null) doc.recordSaveError(error);
      else
        this.report(
          `副本已保存为 ${savedPath}，但工作区状态未能更新。请从文件栏重新打开该副本；若问题持续，请查看详细原因。`,
          error,
        );
    } finally {
      this.duplicating = false;
      this.resumeVaultRefresh();
      if (doc.dirty) this.autosave.touch();
      this.notifyIdle();
    }
  };

  private async withSavedDocument<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.transitioning || this.duplicating || this.composing) return undefined;
    this.transitioning = true;
    try {
      if (!(await this.navigation.settleAttachments())) {
        this.report("附件尚未完成导入，请重试剩余附件，或关闭附件错误提示后再离开。");
        return undefined;
      }
      await this.autosave.flush();
      if (this.document.dirty || this.composing) return undefined;
      return await operation();
    } finally {
      this.finishTransition();
    }
  }

  private finishTransition(): void {
    this.transitioning = false;
    this.resumeVaultRefresh();
    this.notifyIdle();
  }

  private notifyIdle(): void {
    if (this.transitioning || this.duplicating) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private clearDocument(): void {
    this.document.clear();
    this.navigation.clear();
  }

  private async loadFile(path: string): Promise<void> {
    this.document.load(path, await this.api.fileSnapshot(path));
    this.navigation.resetReferences();
    this.announce(this.document.dirty ? "已恢复上次未保存的编辑，请检查后保存。" : "");
    await this.api.sessionSetCurrent(path);
    await this.refreshMentions();
  }

  private async persist(): Promise<void> {
    if (this.duplicating || this.composing) return;
    try {
      const result = await this.document.save(this.navigation.snapshot);
      if (result?.status === "saved") {
        if (result.warning !== null)
          this.notice = {
            kind: "attention",
            source: "save",
            message: `本次内容已保存。${result.warning}`,
            detail: "",
          };
        // 正文提交只清理保存自身的消息，不能把布局或会话失败误当成已解决。
        else if (this.notice?.kind !== "attention" || this.notice.source === "save")
          this.notice = null;
        await this.refreshMentions();
      }
    } finally {
      this.resumeVaultRefresh();
    }
  }

  private async refreshList(): Promise<void> {
    const root = this.root;
    const epoch = this.document.epoch;
    const files = await this.api.vaultEntries();
    if (root === this.root && epoch === this.document.epoch) this.listed = files;
  }

  private async refreshMentions(): Promise<void> {
    const error = await this.navigation.refreshMentions(this.api);
    if (error !== null && this.message === "") this.report(error);
  }

  private get refreshBlocked(): boolean {
    return this.transitioning || this.duplicating || this.composing || this.document.saving;
  }

  /** 附件导入、重试或关闭失败提示后，重新读取此前为保留插入上下文而推迟的磁盘版本。 */
  resumeExternalRefresh = (): void => {
    this.resumeVaultRefresh();
  };

  private resumeVaultRefresh(): void {
    if (!this.pendingRefresh || this.refreshBlocked) return;
    this.pendingRefresh = false;
    void this.onVaultChanged();
  }

  private async onVaultChanged(): Promise<void> {
    if (this.refreshBlocked) {
      this.pendingRefresh = true;
      return;
    }
    const doc = this.document;
    const { path, epoch, originalBytes } = doc;
    const request = ++this.refreshEpoch;
    try {
      await this.refreshList();
      if (epoch !== doc.epoch || path === null || this.transitioning) return;
      const snapshot = await this.api.fileSnapshot(path);
      const attachmentsReady = await this.navigation.settleAttachments();
      if (epoch !== doc.epoch || request !== this.refreshEpoch) return;
      if (!attachmentsReady) {
        this.pendingRefresh = true;
        return;
      }
      if (this.refreshBlocked || originalBytes !== doc.originalBytes) {
        this.pendingRefresh = true;
        this.resumeVaultRefresh();
        return;
      }
      doc.refresh(snapshot.disk, snapshot.diskError);
      if (doc.path === null) {
        this.navigation.clear();
        await this.api.sessionSetCurrent(null);
      } else if (doc.path === path) await this.refreshMentions();
    } catch (error) {
      if (epoch === doc.epoch && !this.transitioning)
        this.report(`读取外部变更失败：${errorText(error)}`);
    }
  }
}
