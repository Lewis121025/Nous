//! 链接记录与种类。

/// 链接语法种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    /// `[[target]]` 或 `[[target|alias]]`。
    Wiki,
    /// `[text](url)` 内部相对链接。
    Markdown,
}

impl LinkKind {
    /// SQLite 存储用的稳定字符串。
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wiki => "wiki",
            Self::Markdown => "md",
        }
    }
}

impl std::str::FromStr for LinkKind {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "wiki" => Ok(Self::Wiki),
            "md" => Ok(Self::Markdown),
            _ => Err(()),
        }
    }
}

/// 索引中的一条出链/入链。
///
/// `start_byte`/`end_byte` 指向源文件 UTF-8 字节区间，供改名时按区间替换。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkRecord {
    /// 源文件库内相对路径。
    pub from_path: String,
    /// 链接原文中的目标（wiki 为 target，md 为 url）。
    pub to_raw: String,
    /// 解析到的库内路径；死链为 `None`。
    pub to_path: Option<String>,
    /// 语法种类。
    pub kind: LinkKind,
    /// 区间起点（含）。
    pub start_byte: i64,
    /// 区间终点（不含）。
    pub end_byte: i64,
}
