import type { LinkKind, ReaderApi, VaultEntry, RenameOutcome } from "../../shared/api";
import { deadLinkCreatePath, type DeadLinkOffer } from "../engine/navigation/dead-link";
import { externalUrl, hasUrlScheme } from "../../shared/link-target";
import type { AttachmentImporter } from "../../shared/attachments";
import { createAutosave } from "../engine/document/autosave";
import { ReaderDocument } from "./document.svelte";
import { ReaderHistory, type ReadingStep } from "./history.svelte";
import { ReaderNavigation } from "./navigation.svelte";
import { ReaderSearch } from "./search.svelte";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 标题锚点与 `^` 块引用共用跳转失败文案。 */
function missingAnchor(anchor: string | null, openedFile: boolean): string {
  const kind = anchor?.startsWith("^") ? "块" : "标题";
  const label = anchor ?? "";
  return openedFile
    ? `未找到${kind}「${label}」，已打开文件开头`
    : `未找到${kind}「${label}」，锚点可能已失效`;
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
  /** 全库搜索；结果属于当前库，切库必须丢弃。 */
  readonly search: ReaderSearch;
  /** 阅读栈：后退/前进导航与落点恢复。 */
  readonly history: ReaderHistory;
  /** 当前文档的导航落点；进入阅读栈的下一个条目。 */
  private currentStep: { path: string; anchor: string | null } | null = null;
  /** Markdown 文档的当前视图；默认排版。 */
  private view = $state<"wysiwyg" | "source">("wysiwyg");
  /** 会话内按文件记住源码视图选择；不持久化，重启回到排版。非响应式记录表。 */
  private readonly sourceViews: Record<string, true> = {};
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
  private candidateSelection = $state<{ paths: string[]; anchor: string | null } | null>(null);
  /** 死链可以创建的笔记；`null` 表示没有等待确认的创建。 */
  private deadLink = $state<DeadLinkOffer | null>(null);
  private refreshEpoch = 0;
  private pendingRefresh = false;
  private idleWaiters: Array<() => void> = [];
  private compositionWaiters: Array<() => void> = [];
  private readonly autosave;

  /** @param api 外壳注入的阅读器能力；构造不订阅事件，挂载时由 start 订阅。 */
  constructor(private readonly api: ReaderApi) {
    this.document = new ReaderDocument(api);
    this.navigation = new ReaderNavigation(this.document);
    this.search = new ReaderSearch(api);
    this.history = new ReaderHistory();
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
  /** 当前 Markdown 文档的视图模式；非 Markdown 文档该值无意义。 */
  get viewMode(): "wysiwyg" | "source" {
    return this.view;
  }

  /**
   * 切换排版/源码视图。
   *
   * 排版文档模型是 Markdown 的有损投影；源码视图直接编辑字节，
   * 「排版表达不了的语法保存时被重写」由源码模式从构造上消除。
   * 切换以当前活动表面的快照为交接文本：未保存编辑随文本带过去，
   * 保存基准与脏标记不变。存在无法保真保存的编辑（needsSourceRepair）
   * 时拒绝切换——恢复记录属于排版会话，不能静默丢弃。
   */
  toggleViewMode = async (): Promise<void> => {
    const path = this.document.path;
    if (path === null || this.document.content?.kind !== "markdown") return;
    if (this.transitioning || this.duplicating || this.composing) return;
    if (this.document.needsSourceRepair) {
      this.report("当前文档存在无法保真保存的编辑，请先处理保存问题再切换视图。");
      return;
    }
    try {
      // 先冲刷挂起的保存；冲突失败时编辑随快照文本带到新表面。
      await this.autosave.flush();
      if (this.transitioning || this.duplicating || this.document.path !== path) return;
      // ignoreBOM：BOM 是文件字节的一部分，切换视图必须原样带走。
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        this.navigation.snapshot().bytes,
      );
      this.document.replaceSourceText(text);
      this.view = this.view === "wysiwyg" ? "source" : "wysiwyg";
      if (this.view === "source") this.sourceViews[path] = true;
      else delete this.sourceViews[path];
      // 新表面挂载在微任务里；尽力把焦点交过去，失败不打断切换。
      await Promise.resolve();
      this.navigation.focusEditor();
    } catch (error) {
      this.report(`切换视图失败：${errorText(error)}`, error);
    }
  };

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
      this.search.reset();
      await this.refreshList();
      // 阅读栈按当前文件列表过滤；已删除文件的条目不再误导导航。
      const files = this.files;
      this.history.restore(restored.history, (path) => files.includes(path));
      if (restored.currentPath !== null && files.includes(restored.currentPath)) {
        await this.loadFile(restored.currentPath);
        // 初始落点不入栈：与浏览器一致，恢复的起点没有「上一步」。
        this.currentStep = { path: restored.currentPath, anchor: null };
      } else {
        await this.api.sessionSetCurrent(null);
        this.currentStep = null;
      }
      this.persistHistory();
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
        this.search.reset();
        this.candidateSelection = null;
        this.deadLink = null;
        // 阅读栈属于旧库；会话侧的清空由主进程 vaultOpen 负责。
        this.history.clear();
        this.currentStep = null;
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
      await this.withSavedDocument(async () => {
        // 门禁已通过、加载成功才入栈：失败不留下幽灵历史。
        const previous = this.captureCurrentStep();
        await this.loadFile(path);
        if (previous !== null) this.history.pushStep(previous);
        this.currentStep = { path, anchor: null };
        this.persistHistory();
      });
    } catch (error) {
      this.report(`打开文件失败：${errorText(error)}`);
    }
  };

  /** 后退到上一个阅读位置；门禁拒绝或栈空时不动。 */
  navigateBack = async (): Promise<void> => {
    await this.navigateHistory("back");
  };

  /** 前进到下一个阅读位置；门禁拒绝或栈空时不动。 */
  navigateForward = async (): Promise<void> => {
    await this.navigateHistory("forward");
  };

  private async navigateHistory(direction: "back" | "forward"): Promise<void> {
    if (this.currentStep === null) return;
    const current = this.history.captureStep(this.currentStep);
    const target = direction === "back" ? this.history.peekBack() : this.history.peekForward();
    if (target === null) return;
    try {
      await this.withSavedDocument(async () => {
        if (target.path !== this.document.path) await this.loadFile(target.path);
        if (direction === "back") this.history.commitBack(current);
        else this.history.commitForward(current);
        this.currentStep = { path: target.path, anchor: target.anchor };
        if (target.anchor !== null) {
          // 锚点落点优先于滚动位置；标题已失效时打开文件并可见提示。
          await this.navigation.openHeadingAnchor(target.path, target.anchor, this.openFile, () =>
            this.report(missingAnchor(target.anchor, true)),
          );
        } else {
          this.history.applyScroll(target);
        }
        this.persistHistory();
      });
    } catch (error) {
      this.report(`${direction === "back" ? "后退" : "前进"}失败：${errorText(error)}`);
    }
  }

  /** 当前落点加滚动位置；没有打开文档时为 null。 */
  private captureCurrentStep(): ReadingStep | null {
    return this.currentStep === null ? null : this.history.captureStep(this.currentStep);
  }

  /**
   * 阅读栈写入会话；失败不打断导航。
   *
   * 会话文件故障已由同链路的 `sessionSetCurrent` 写入可见地上报，
   * 这里不重复弹同一条错误。
   */
  private persistHistory(): void {
    void this.api.sessionSetHistory(this.history.snapshot()).catch(() => {});
  }

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
      const target = await this.api.linksResolve(path, raw, kind);
      if (epoch !== this.document.epoch || this.transitioning || this.duplicating) return;
      switch (target.status) {
        case "dead": {
          const offer = deadLinkCreatePath(path, raw, kind);
          if (offer === null) {
            this.report("死链，无法跳转");
            return;
          }
          this.deadLink = offer;
          return;
        }
        case "ambiguous":
          // 同名多候选不静默取一，交给用户选择；锚点在选择后继续生效。
          this.candidateSelection = { paths: target.candidates, anchor: target.anchor };
          return;
        case "resolved":
          await this.openResolved(target.path, target.anchor);
          return;
      }
    } catch (error) {
      if (epoch === this.document.epoch) this.report(`打开链接失败：${errorText(error)}`);
    }
  };

  /** 歧义链接的候选（升序）；`null` 表示没有等待中的选择。 */
  get linkCandidates() {
    return this.candidateSelection;
  }

  /** 关闭候选选择，不打开任何目标。 */
  dismissLinkCandidates = (): void => {
    this.candidateSelection = null;
  };

  /** 等待确认的死链创建；`null` 表示没有。 */
  get deadLinkOffer() {
    return this.deadLink;
  }

  /** 放弃从死链创建笔记。 */
  dismissDeadLink = (): void => {
    this.deadLink = null;
  };

  /**
   * 按死链原文创建笔记并打开。
   *
   * 父目录不存在或名称冲突时保留当前文档，并给出创建失败原因。
   */
  confirmDeadLink = async (): Promise<void> => {
    const offer = this.deadLink;
    this.deadLink = null;
    if (offer === null) return;
    const error = await this.createEntry(offer.path, "file");
    if (error !== null) {
      this.report(error);
      return;
    }
    if (offer.anchor !== null) await this.openResolved(offer.path, offer.anchor);
  };

  /** 打开用户选中的候选；锚点在场时继续定位标题。 */
  chooseLinkCandidate = async (chosen: string): Promise<void> => {
    const selection = this.candidateSelection;
    this.candidateSelection = null;
    if (selection === null) return;
    try {
      await this.openResolved(chosen, selection.anchor);
    } catch (error) {
      this.report(`打开链接失败：${errorText(error)}`);
    }
  };

  /** 打开唯一解析目标；带锚点时定位标题，失效锚点可见提示而不是空吞。 */
  private async openResolved(path: string, anchor: string | null): Promise<void> {
    if (anchor === null) {
      await this.openFile(path);
      return;
    }
    if (path === this.document.path) {
      // 当前文档用活动大纲：未保存的新标题同样有效。
      if (!this.navigation.jumpToHeadingText(anchor)) {
        this.report(missingAnchor(anchor, false));
        return;
      }
      // 同文档锚点跳转也算阅读栈的一跳，后退可回到跳转前的位置。
      const previous = this.captureCurrentStep();
      if (previous !== null) this.history.pushStep(previous);
      this.currentStep = { path, anchor };
      this.persistHistory();
      return;
    }
    await this.navigation.openHeadingAnchor(path, anchor, this.openFile, () =>
      this.report(missingAnchor(anchor, true)),
    );
    // openFile 已入栈并记录落点；这里把锚点补进当前条目。
    if (this.document.path === path && this.currentStep?.path === path)
      this.currentStep = { path, anchor };
  }

  /**
   * 补全弹层：解析链接目标并返回其标题文本。
   *
   * 目标死链、歧义或索引失败都退化为空候选——补全是尽力而为的辅助能力，
   * 不为它弹错误提示，也不打断写作。
   */
  suggestHeadings = async (target: string, kind: LinkKind): Promise<string[]> => {
    const from = this.document.path;
    if (from === null || target.trim() === "") return [];
    try {
      const resolved = await this.api.linksResolve(from, target, kind);
      if (resolved.status !== "resolved") return [];
      const headings = await this.api.indexHeadings(resolved.path);
      return headings.map((heading) => heading.text);
    } catch {
      return [];
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
      null,
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
      (history) => history.remapPath(from, to),
    );
  }

  /** 移入系统废纸篓；关闭被删除目录中的当前文档，失败时保留编辑。 */
  trashEntry(path: string): Promise<string | null> {
    return this.mutateEntries(
      "移到废纸篓",
      () => this.api.entryTrash(path),
      (current) => (current === path || current?.startsWith(`${path}/`) ? null : current),
      false,
      (history) => history.remapPath(path, null),
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
    remapHistory: ((history: ReaderHistory) => void) | null,
  ): Promise<string | null> {
    let committed = false;
    let pathAfter: string | null = this.document.path;
    try {
      const completed = await this.withSavedDocument(async () => {
        const before = this.document.path;
        pathAfter = nextPath(before);
        const result = await operation();
        committed = true;
        // 阅读栈跟随改名/移动；删除的条目直接移除。
        if (remapHistory !== null) {
          remapHistory(this.history);
          if (this.currentStep !== null) {
            const mapped = nextPath(this.currentStep.path);
            this.currentStep = mapped === null ? null : { ...this.currentStep, path: mapped };
          }
          this.persistHistory();
        }
        // 改名后的当前文档保留源码视图选择。
        if (pathAfter !== null && this.view === "source") this.sourceViews[pathAfter] = true;
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
      await this.refreshReferences();
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
    this.view = "wysiwyg";
  }

  private async loadFile(path: string): Promise<void> {
    this.document.load(path, await this.api.fileSnapshot(path));
    // 恢复记录属于排版会话；带恢复记录的文件强制排版视图，
    // 否则记住的源码视图会让未写入磁盘的编辑静默缺席。
    this.view =
      Object.hasOwn(this.sourceViews, path) && !this.document.needsSourceRepair
        ? "source"
        : "wysiwyg";
    this.navigation.resetReferences();
    this.announce(this.document.dirty ? "已恢复上次未保存的编辑，请检查后保存。" : "");
    await this.api.sessionSetCurrent(path);
    await this.refreshReferences();
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
        await this.refreshReferences();
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

  private async refreshReferences(): Promise<void> {
    const error = await this.navigation.refreshReferences(this.api);
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
      } else if (doc.path === path) await this.refreshReferences();
    } catch (error) {
      if (epoch === doc.epoch && !this.transitioning)
        this.report(`读取外部变更失败：${errorText(error)}`);
    }
  }
}
