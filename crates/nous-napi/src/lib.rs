//! Node-API 绑定：只转发 `nous-core`，不在此层写业务。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use nous_core::{LinkKind, Vault, WatchHandle};

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

fn vault_ref(state: &AppState) -> &Vault {
    state.vault.as_ref()
}

/// 打开库并开始监视。
///
/// `on_changed` 在防抖后的监视线程上调用，主进程应据此通知渲染进程。
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
    let state = lock_state()?;
    let state = state
        .as_ref()
        .ok_or_else(|| Error::from_reason("尚未打开库"))?;
    vault_ref(state).list_files().map_err(to_napi)
}

/// 读取文件原始字节。
///
/// # Errors
///
/// 未打开库、越界或不存在。
#[napi]
pub fn file_read(rel: String) -> Result<Buffer> {
    let state = lock_state()?;
    let state = state
        .as_ref()
        .ok_or_else(|| Error::from_reason("尚未打开库"))?;
    let bytes = vault_ref(state).read(&rel).map_err(to_napi)?;
    Ok(Buffer::from(bytes))
}

/// 原子写入文件并重建索引。
///
/// # Errors
///
/// 未打开库或越界。
#[napi]
pub fn file_write(rel: String, bytes: Buffer) -> Result<()> {
    let state = lock_state()?;
    let state = state
        .as_ref()
        .ok_or_else(|| Error::from_reason("尚未打开库"))?;
    vault_ref(state)
        .write(&rel, bytes.as_ref())
        .map_err(to_napi)
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
    let state = lock_state()?;
    let state = state
        .as_ref()
        .ok_or_else(|| Error::from_reason("尚未打开库"))?;
    Ok(vault_ref(state).resolve_link(&from, &raw, kind))
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
    let state = lock_state()?;
    let state = state
        .as_ref()
        .ok_or_else(|| Error::from_reason("尚未打开库"))?;
    Ok(vault_ref(state)
        .links_to(&path)
        .map_err(to_napi)?
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
    let state = lock_state()?;
    let state = state
        .as_ref()
        .ok_or_else(|| Error::from_reason("尚未打开库"))?;
    Ok(vault_ref(state)
        .links_from(&path)
        .map_err(to_napi)?
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
    let state = lock_state()?;
    let state = state
        .as_ref()
        .ok_or_else(|| Error::from_reason("尚未打开库"))?;
    let mentions = vault_ref(state).mentions_to(&path).map_err(to_napi)?;
    Ok(JsMentions {
        linked: mentions.linked.into_iter().map(to_js_mention).collect(),
        unlinked: mentions.unlinked.into_iter().map(to_js_mention).collect(),
    })
}

/// 改名并更新全库链接。
///
/// # Errors
///
/// 未打开库、目标已存在或写盘失败。
#[napi]
pub fn entry_rename(from: String, to: String) -> Result<()> {
    let state = lock_state()?;
    let state = state
        .as_ref()
        .ok_or_else(|| Error::from_reason("尚未打开库"))?;
    vault_ref(state).rename(&from, &to).map_err(to_napi)
}
