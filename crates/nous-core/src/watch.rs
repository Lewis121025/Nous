//! 监视库目录变更并在防抖后回调。

use std::path::{Path, PathBuf};
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
    F: Fn(Result<Vec<PathBuf>, String>) + Send + 'static,
{
    let root = root.as_ref();
    let mut debouncer = new_debouncer(debounce, None, move |result: DebounceEventResult| {
        on_change(
            result
                .map(|events| {
                    let mut paths: Vec<_> = events
                        .into_iter()
                        .flat_map(|event| event.event.paths)
                        .collect();
                    paths.sort();
                    paths.dedup();
                    paths
                })
                .map_err(|errors| {
                    errors
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join("；")
                }),
        );
    })
    .map_err(|err| Error::Io(std::io::Error::other(err)))?;
    debouncer
        .watch(root, RecursiveMode::Recursive)
        .map_err(|err| Error::Io(std::io::Error::other(err)))?;
    Ok(WatchHandle {
        _debouncer: debouncer,
    })
}
