//! 监视库目录变更并在防抖后回调。

use std::path::Path;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult};

use crate::error::Error;

/// 保持监视器存活；drop 后停止监视。
pub struct WatchHandle {
    _debouncer: notify_debouncer_full::Debouncer<
        notify::RecommendedWatcher,
        notify_debouncer_full::RecommendedCache,
    >,
}

/// 递归监视 `root`，在 `debounce` 静默后调用 `on_change`。
///
/// 回调在监视线程上执行，必须自行处理锁与错误。
///
/// # Errors
///
/// 无法启动操作系统监视器时返回 IO 错误。
pub fn start_watch<F>(
    root: impl AsRef<Path>,
    debounce: Duration,
    on_change: F,
) -> Result<WatchHandle, Error>
where
    F: Fn() + Send + 'static,
{
    let root = root.as_ref();
    let mut debouncer = new_debouncer(debounce, None, move |result: DebounceEventResult| {
        if result.is_ok() {
            on_change();
        }
    })
    .map_err(|err| Error::Io(std::io::Error::other(err)))?;
    debouncer
        .watch(root, RecursiveMode::Recursive)
        .map_err(|err| Error::Io(std::io::Error::other(err)))?;
    Ok(WatchHandle {
        _debouncer: debouncer,
    })
}
