//! Nous 库内核。
//!
//! 负责打开笔记库、按相对路径读写原始字节，以及链接索引与改名事务。
//! 本 crate 不依赖 Node-API，测试直接调用此处 API。

mod error;
mod index;
mod link;
mod mention;
mod pathutil;
mod rewrite;
mod scan;
mod vault;
mod watch;

pub use error::Error;
pub use link::{LinkKind, LinkRecord};
pub use mention::{MentionKind, MentionRecord, Mentions};
pub use vault::Vault;
pub use watch::{start_watch, WatchHandle};
