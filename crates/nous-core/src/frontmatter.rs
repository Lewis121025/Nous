//! frontmatter（YAML）到标签与属性的映射。
//!
//! v1 建模范围（刻意收窄，不做投机泛化）：
//!
//! * 只解析顶层映射；非映射文档不产出任何数据。
//! * `tags` / `tag` 键进标签索引：接受标量字符串（按逗号切分）或标量序列，
//!   元素去除前导 `#`、统一小写；空元素与纯数字元素丢弃（与行内标签共享
//!   「必须含字母」规则）。不做行内标签的字符集校验——用户显式声明的
//!   属性值按原文规范化。
//! * 其余键进属性索引：标量（字符串/数字/布尔）与标量序列（每元素一行）；
//!   嵌套映射、空值跳过，不建模。
//! * TOML frontmatter 不解析，维持源码保留。

use yaml_rust2::Yaml;

/// 一篇笔记 frontmatter 产出的标签与属性行。
pub(crate) struct FrontmatterData {
    /// 规范化标签（小写、无 `#`、去重）。
    pub tags: Vec<String>,
    /// `(key, value)` 属性行；key 保留原文大小写。
    pub attributes: Vec<(String, String)>,
}

/// 解析 YAML frontmatter 原文。
///
/// # 参数
///
/// * `yaml` frontmatter 源码（不含 `---` 分隔线）。
///
/// # 返回值
///
/// 标签与属性；语法无效或非映射文档返回空结果，不报错——
/// frontmatter 解析失败不能挡住链接与全文索引。
#[must_use]
pub(crate) fn parse(yaml: &str) -> FrontmatterData {
    let mut out = FrontmatterData {
        tags: Vec::new(),
        attributes: Vec::new(),
    };
    let Ok(mut docs) = yaml_rust2::YamlLoader::load_from_str(yaml) else {
        return out;
    };
    let Some(Yaml::Hash(map)) = docs.pop() else {
        return out;
    };
    for (key, value) in &map {
        let Yaml::String(key) = key else { continue };
        if key == "tags" || key == "tag" {
            collect_tags(value, &mut out.tags);
        } else {
            collect_attributes(key, value, &mut out.attributes);
        }
    }
    out
}

fn collect_tags(value: &Yaml, tags: &mut Vec<String>) {
    let scalars: Vec<&Yaml> = match value {
        Yaml::Array(items) => items.iter().collect(),
        Yaml::String(text) => {
            // 逗号分隔字符串是 Obsidian 惯例；`"a, b"` 与 `a, b` 同义。
            for part in text.split(',') {
                push_tag(tags, part);
            }
            return;
        }
        scalar => vec![scalar],
    };
    for scalar in scalars {
        push_tag(tags, &scalar_string(scalar));
    }
}

fn push_tag(tags: &mut Vec<String>, raw: &str) {
    let tag = raw.trim().trim_start_matches('#').trim();
    if tag.is_empty() {
        return;
    }
    let tag = tag.to_lowercase();
    // 与行内标签共享「必须含字母」规则；纯数字标签在 Obsidian 同样无效。
    if !tag.chars().any(char::is_alphabetic) {
        return;
    }
    if !tags.contains(&tag) {
        tags.push(tag);
    }
}

fn collect_attributes(key: &str, value: &Yaml, attributes: &mut Vec<(String, String)>) {
    match value {
        Yaml::Array(items) => {
            for item in items {
                push_attribute(attributes, key, item);
            }
        }
        Yaml::Hash(_) | Yaml::BadValue | Yaml::Alias(_) => {}
        scalar => push_attribute(attributes, key, scalar),
    }
}

fn push_attribute(attributes: &mut Vec<(String, String)>, key: &str, value: &Yaml) {
    if matches!(
        value,
        Yaml::Hash(_) | Yaml::Array(_) | Yaml::BadValue | Yaml::Alias(_)
    ) {
        return;
    }
    let text = scalar_string(value);
    // yaml-rust2 把 null 折叠为空字符串；空值没有过滤意义，统一跳过。
    if text.is_empty() {
        return;
    }
    attributes.push((key.to_string(), text));
}

/// 标量转展示字符串；字符串去引号原文，数字/布尔用 YAML 字面形式。
fn scalar_string(value: &Yaml) -> String {
    match value {
        Yaml::String(text) => text.clone(),
        Yaml::Integer(number) => number.to_string(),
        Yaml::Real(number) => number.clone(),
        Yaml::Boolean(flag) => flag.to_string(),
        _ => String::new(),
    }
}
