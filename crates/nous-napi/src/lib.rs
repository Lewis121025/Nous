//! Node-API 绑定：只转发 `nous-core`，不在此层写业务。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use nous_core::{LinkKind, Vault, WatchHandle, WriteOutcome};

struct AppState {
    vault: Arc<Vault>,
    _watch: WatchHandle,
}

static STATE: Mutex<Option<AppState>> = Mutex::new(None);

fn to_napi(err: nous_core::Error) -> Error {
    Error::from_reason(err.to_string())
}

fn lock_state() -> Result<std::sync::MutexGuard<'static, Option<AppState>>> {
    STATE
        .lock()
        .map_err(|_| Error::from_reason("内核状态锁已毒化"))
}

/// 在整个内核调用期间持有状态锁，切库不能使正在执行的操作失去归属。
fn with_vault<T>(
    operation: impl FnOnce(&Vault) -> std::result::Result<T, nous_core::Error>,
) -> Result<T> {
    let state = lock_state()?;
    let state = state
        .as_ref()
        .ok_or_else(|| Error::from_reason("尚未打开库"))?;
    operation(&state.vault).map_err(to_napi)
}

/// 打开库并开始监视。
///
/// `root` 是库目录，`index_dir` 是库外的派生索引与恢复目录。
/// 监视线程在防抖与索引刷新后，将 `on_changed` 投递给持有内核的 JS 线程。
/// 成功后替换当前库及其监视器；失败时保留原库。
///
/// # Errors
///
/// 打不开目录、索引或监视器时失败。
#[napi]
pub fn vault_open(root: String, index_dir: String, on_changed: JsFunction) -> Result<()> {
    let tsfn: ThreadsafeFunction<bool, ErrorStrategy::Fatal> = on_changed
        .create_threadsafe_function(0, |ctx| ctx.env.get_boolean(ctx.value).map(|v| vec![v]))?;
    let vault = Arc::new(Vault::open(&root, &index_dir).map_err(to_napi)?);
    let watched = Arc::clone(&vault);
    let watch = nous_core::start_watch(root, Duration::from_millis(300), move || {
        if matches!(watched.refresh_index(), Ok(true)) {
            tsfn.call(true, ThreadsafeFunctionCallMode::NonBlocking);
        }
    })
    .map_err(to_napi)?;
    let mut state = lock_state()?;
    *state = Some(AppState {
        vault,
        _watch: watch,
    });
    Ok(())
}

/// 关闭当前库并停止监视。
///
/// # Errors
///
/// 锁毒化时失败。
#[napi]
pub fn vault_close() -> Result<()> {
    let mut state = lock_state()?;
    *state = None;
    Ok(())
}

/// 列出库内相对路径。
///
/// # Errors
///
/// 未打开库或读目录失败。
#[napi]
pub fn vault_list() -> Result<Vec<String>> {
    with_vault(Vault::list_files)
}

/// 读取文件原始字节。
///
/// # Errors
///
/// 未打开库、越界或不存在。
#[napi]
pub fn file_read(rel: String) -> Result<Buffer> {
    with_vault(|vault| vault.read(&rel)).map(Buffer::from)
}

/// 已持久化的恢复草稿。
#[napi(object)]
pub struct JsDraft {
    /// 编辑内容。
    pub bytes: Buffer,
    /// 原编辑基准；缺失表示新文件。
    pub base: Option<Buffer>,
}

/// 编辑器加载快照，文件删除时仍可恢复草稿。
#[napi(object)]
pub struct JsFileSnapshot {
    /// 磁盘内容；缺失表示文件已删除。
    pub disk: Option<Buffer>,
    /// 尚未提交的编辑。
    pub draft: Option<JsDraft>,
}

/// 获取 `rel` 的磁盘内容与恢复草稿。
///
/// # Errors
///
/// 未打开库、越界或读取失败。
#[napi]
pub fn file_snapshot(rel: String) -> Result<JsFileSnapshot> {
    let snapshot = with_vault(|vault| vault.snapshot(&rel))?;
    Ok(JsFileSnapshot {
        disk: snapshot.disk.map(Buffer::from),
        draft: snapshot.draft.map(|draft| JsDraft {
            bytes: Buffer::from(draft.bytes),
            base: draft.base.map(Buffer::from),
        }),
    })
}

/// 文件提交结果，冲突时附带磁盘版本。
#[napi(object)]
pub struct JsWriteResult {
    /// `saved` 或 `conflict`。
    pub status: String,
    /// 冲突的磁盘字节；缺失也可能表示文件被删除。
    pub disk: Option<Buffer>,
    /// 已提交后的同步、索引或清理警告。
    pub warning: Option<String>,
}

/// 按 `expected` 基准保存 `bytes`，返回提交状态或冲突。
///
/// # Errors
///
/// 未打开库、越界、草稿持久化或内容提交失败。
#[napi]
pub fn file_write(rel: String, bytes: Buffer, expected: Option<Buffer>) -> Result<JsWriteResult> {
    let result = with_vault(|vault| vault.write(&rel, bytes.as_ref(), expected.as_deref()))?;
    Ok(match result {
        WriteOutcome::Saved { warning } => JsWriteResult {
            status: "saved".into(),
            disk: None,
            warning,
        },
        WriteOutcome::Conflict { disk } => JsWriteResult {
            status: "conflict".into(),
            disk: disk.map(Buffer::from),
            warning: None,
        },
    })
}

/// 新副本的路径与提交后警告。
#[napi(object)]
pub struct JsSavedCopy {
    /// 实际创建的相对路径。
    pub path: String,
    /// 内容已保存后的警告。
    pub warning: Option<String>,
}

/// 将当前 `bytes` 写入唯一命名的新副本，`expected` 用于恢复基准。
///
/// # Errors
///
/// 未打开库、路径非法或副本提交失败。
#[napi]
pub fn file_write_copy(
    rel: String,
    bytes: Buffer,
    expected: Option<Buffer>,
) -> Result<JsSavedCopy> {
    let copy = with_vault(|vault| vault.write_copy(&rel, bytes.as_ref(), expected.as_deref()))?;
    Ok(JsSavedCopy {
        path: copy.path,
        warning: copy.warning,
    })
}

/// 解析链接目标。
///
/// `kind` 为 `wiki` 或 `md`。
///
/// # Errors
///
/// 未打开库或 kind 非法。
#[napi]
pub fn links_resolve(from: String, raw: String, kind: String) -> Result<Option<String>> {
    let kind: LinkKind = kind
        .parse()
        .map_err(|()| Error::from_reason("未知链接种类"))?;
    with_vault(|vault| Ok(vault.resolve_link(&from, &raw, kind)))
}

/// 一条索引中的链接。
#[napi(object)]
pub struct JsLinkRecord {
    /// 源文件相对路径。
    pub from_path: String,
    /// 链接原文中的目标。
    pub to_raw: String,
    /// 解析到的路径；死链为 `null`。
    pub to_path: Option<String>,
    /// `wiki` 或 `md`。
    pub kind: String,
    /// 字节区间起点（含）。
    pub start_byte: i64,
    /// 字节区间终点（不含）。
    pub end_byte: i64,
}

fn to_js(link: nous_core::LinkRecord) -> JsLinkRecord {
    JsLinkRecord {
        from_path: link.from_path,
        to_raw: link.to_raw,
        to_path: link.to_path,
        kind: link.kind.as_str().to_string(),
        start_byte: link.start_byte,
        end_byte: link.end_byte,
    }
}

/// 一条已链接或未链接提及。
#[napi(object)]
pub struct JsMentionRecord {
    /// 源文件相对路径。
    pub from_path: String,
    /// 源文件展示标题。
    pub from_title: String,
    /// 源文件内容修改时间（自纪元起的纳秒）。
    pub mtime: i64,
    /// 命中区间起点（含）。
    pub start_byte: i64,
    /// 命中区间终点（不含）。
    pub end_byte: i64,
    /// 命中所在段落。
    pub snippet: String,
    /// `linked` 或 `unlinked`。
    pub kind: String,
    /// 已链接时为 `wiki`/`md`；未链接为 `null`。
    pub link_kind: Option<String>,
    /// 已链接为链接原文目标；未链接为命中文本。
    pub to_raw: String,
}

/// 指向一篇笔记的已链接与未链接提及。
#[napi(object)]
pub struct JsMentions {
    /// 索引里的入链。
    pub linked: Vec<JsMentionRecord>,
    /// 正文里尚未做成链接的出现。
    pub unlinked: Vec<JsMentionRecord>,
}

fn to_js_mention(mention: nous_core::MentionRecord) -> JsMentionRecord {
    JsMentionRecord {
        from_path: mention.from_path,
        from_title: mention.from_title,
        mtime: mention.mtime,
        start_byte: mention.start_byte,
        end_byte: mention.end_byte,
        snippet: mention.snippet,
        kind: mention.kind.as_str().to_string(),
        link_kind: mention.link_kind.map(|kind| kind.as_str().to_string()),
        to_raw: mention.to_raw,
    }
}

/// 指向 `path` 的入链。
///
/// # Errors
///
/// 未打开库。
#[napi]
pub fn index_links_to(path: String) -> Result<Vec<JsLinkRecord>> {
    Ok(with_vault(|vault| vault.links_to(&path))?
        .into_iter()
        .map(to_js)
        .collect())
}

/// `path` 的出链。
///
/// # Errors
///
/// 未打开库。
#[napi]
pub fn index_links_from(path: String) -> Result<Vec<JsLinkRecord>> {
    Ok(with_vault(|vault| vault.links_from(&path))?
        .into_iter()
        .map(to_js)
        .collect())
}

/// 指向 `path` 的已链接提及与未链接提及。
///
/// # Errors
///
/// 未打开库。
#[napi]
pub fn index_mentions_to(path: String) -> Result<JsMentions> {
    let mentions = with_vault(|vault| vault.mentions_to(&path))?;
    Ok(JsMentions {
        linked: mentions.linked.into_iter().map(to_js_mention).collect(),
        unlinked: mentions.unlinked.into_iter().map(to_js_mention).collect(),
    })
}

/// 文件已经完成改名，索引或日志清理可能仍需重试。
#[napi(object)]
pub struct JsRenameOutcome {
    /// 提交后的警告；无警告时缺失。
    pub warning: Option<String>,
}

/// 将 `from` 改名为 `to` 并更新全库链接，返回提交后的警告。
///
/// # Errors
///
/// 未打开库、目标已存在或写盘失败。
#[napi]
pub fn entry_rename(from: String, to: String) -> Result<JsRenameOutcome> {
    let result = with_vault(|vault| vault.rename(&from, &to))?;
    Ok(JsRenameOutcome {
        warning: result.warning,
    })
}
