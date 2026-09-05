//! Read-only GitHub release history. Installation eligibility stays with Tauri's updater.
use crate::AppError;
use semver::Version;
use serde::Serialize;
use serde_json::Value;
use std::{
    io::Read,
    time::{Duration, Instant},
};

const REPOSITORY_API: &str = "https://api.github.com/repos/jy018361-ui/audit-toolbox";
const MAX_PAGES: usize = 10;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNotes {
    current_version: String,
    target_version: String,
    releases: Vec<ReleaseNote>,
    commits: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseNote {
    version: String,
    title: String,
    body: String,
    published_at: String,
}

fn version(text: &str) -> Result<Version, String> {
    Version::parse(text.strip_prefix('v').unwrap_or(text))
        .map_err(|_| "版本号格式无效，无法确定更新说明范围。".to_string())
}

fn meaningful_body(body: &str) -> bool {
    body.lines().map(str::trim).any(|line| {
        !line.is_empty()
            && line != "请查看本次 Release 的更新说明。"
            && !line.starts_with("**Full Changelog**:")
            && !line.starts_with("https://github.com/jy018361-ui/audit-toolbox/compare/")
    })
}

fn collect_notes(
    current: &str,
    target: &str,
    mut fetch: impl FnMut(&str) -> Result<Value, String>,
) -> Result<ReleaseNotes, String> {
    let current_v = version(current)?;
    let target_v = version(target)?;
    if target_v.cmp_precedence(&current_v).is_lt() {
        return Err("目标版本低于当前版本，不能生成升级说明。".into());
    }
    let same_version = current_v.cmp_precedence(&target_v).is_eq();
    let mut result = ReleaseNotes {
        current_version: current_v.to_string(),
        target_version: target_v.to_string(),
        releases: vec![],
        commits: vec![],
        warnings: vec![],
    };
    let mut base_tag = format!("v{current_v}");
    let mut target_tag = format!("v{target_v}");
    // 本版说明为空时，要拿“上一版本 → 当前版本”的提交记录补齐，所以
    // 记录低于当前版本里最新的那个标签（含预发布版本比较规则）。
    let mut previous_v: Option<Version> = None;
    let mut previous_tag: Option<String> = None;
    let mut selected = Vec::new();
    for page in 1..=MAX_PAGES {
        let value = match fetch(&format!("/releases?per_page=100&page={page}")) {
            Ok(value) => value,
            Err(error) if page > 1 => {
                result.warnings.push(error);
                break;
            }
            Err(error) => return Err(error),
        };
        let rows = value.as_array().ok_or("GitHub 发布记录格式异常。")?;
        for row in rows {
            if row["draft"].as_bool().unwrap_or(true) {
                continue;
            }
            let tag = row["tag_name"].as_str().unwrap_or_default();
            let Ok(v) = version(tag) else {
                continue;
            };
            if v.cmp_precedence(&current_v).is_eq() {
                base_tag = tag.to_string();
            }
            if v.cmp_precedence(&target_v).is_eq() {
                target_tag = tag.to_string();
            }
            if v.cmp_precedence(&current_v).is_lt()
                && previous_v
                    .as_ref()
                    .is_none_or(|p| v.cmp_precedence(p).is_gt())
            {
                previous_v = Some(v.clone());
                previous_tag = Some(tag.to_string());
            }
            // Do not use publication order or string ordering (alpha.10 > alpha.9).
            if v.cmp_precedence(&target_v).is_gt()
                || (!same_version && !v.cmp_precedence(&current_v).is_gt())
                || (same_version && !v.cmp_precedence(&current_v).is_eq())
            {
                continue;
            }
            let body = row["body"].as_str().unwrap_or_default();
            selected.push((
                v.clone(),
                ReleaseNote {
                    version: v.to_string(),
                    title: row["name"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(tag)
                        .to_string(),
                    body: if meaningful_body(body) {
                        body.to_string()
                    } else {
                        String::new()
                    },
                    published_at: row["published_at"].as_str().unwrap_or_default().to_string(),
                },
            ));
        }
        if rows.len() < 100 {
            break;
        }
        if page == MAX_PAGES {
            result
                .warnings
                .push("发布记录超过读取上限，以下说明可能不完整。".into());
        }
    }
    selected.sort_by(|a, b| b.0.cmp_precedence(&a.0));
    selected.dedup_by(|a, b| a.0.cmp_precedence(&b.0).is_eq());
    result.releases = selected.into_iter().map(|(_, note)| note).collect();
    let missing_target = !result.releases.iter().any(|r| {
        version(&r.version)
            .unwrap()
            .cmp_precedence(&target_v)
            .is_eq()
    });
    if missing_target {
        result
            .warnings
            .push("未找到目标版本的 GitHub Release，可能尚未发布或版本标签不匹配。".into());
    }
    let target_body_empty = result.releases.iter().any(|r| {
        version(&r.version)
            .unwrap()
            .cmp_precedence(&target_v)
            .is_eq()
            && r.body.is_empty()
    });
    let incomplete = missing_target || result.releases.iter().any(|r| r.body.is_empty());
    let commit_base: Option<String> = if same_version {
        // 更新完成后用户看到的是“本版说明”，正文为空时用上一版本到当前版本的提交记录补齐，
        // 不能只剩一句“此版本未填写更新说明”。
        match previous_tag {
            Some(tag) if !missing_target && target_body_empty => Some(tag),
            _ => {
                if !missing_target && target_body_empty {
                    result.warnings.push(
                        "本版未填写更新说明，也没有找到更早的版本标签，无法用提交记录补齐。".into(),
                    );
                }
                None
            }
        }
    } else if incomplete {
        Some(base_tag.clone())
    } else {
        None
    };
    if let Some(base) = commit_base {
        result.warnings.push(if same_version {
            "本版未填写更新说明；下方提交记录就是这一版相对上一版的全部变更。".into()
        } else {
            "部分版本未填写更新说明；下方补充整个升级区间的 GitHub 提交标题（不是功能总结）。"
                .into()
        });
        for page in 1..=MAX_PAGES {
            let value = match fetch(&format!(
                "/compare/{base}...{target_tag}?per_page=100&page={page}"
            )) {
                Ok(value) => value,
                Err(error) => {
                    result.warnings.push(error);
                    break;
                }
            };
            if value["status"].as_str() != Some("ahead") {
                result
                    .warnings
                    .push("版本标签不在同一向前升级链上，无法可靠归纳提交差异。".into());
                break;
            }
            let Some(commits) = value["commits"].as_array() else {
                result
                    .warnings
                    .push("GitHub 提交记录格式异常，差异说明可能不完整。".into());
                break;
            };
            for commit in commits {
                if let Some(message) = commit["commit"]["message"].as_str() {
                    result
                        .commits
                        .push(message.lines().next().unwrap_or_default().to_string());
                }
            }
            if commits.len() < 100 {
                break;
            }
            if page == MAX_PAGES {
                result
                    .warnings
                    .push("提交记录超过读取上限，未展示的提交请在 GitHub 查看。".into());
            }
        }
    }
    Ok(result)
}

pub fn load(current: &str, target: &str) -> Result<ReleaseNotes, AppError> {
    let run = || -> Result<ReleaseNotes, String> {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("AuditToolbox-ReleaseNotes")
            .build()
            .map_err(|_| "无法初始化更新说明连接。")?;
        let started = Instant::now();
        collect_notes(current, target, |path| {
            if started.elapsed() > Duration::from_secs(45) {
                return Err("更新说明读取超时，可能未能读取完整区间，请重试。".into());
            }
            let response = client
                .get(format!("{REPOSITORY_API}{path}"))
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .send()
                .map_err(|_| "无法连接 GitHub 获取更新说明，请检查网络后重试。")?;
            match response.status().as_u16() {
                200 => {}
                403 | 429 => return Err("GitHub 请求受限，请稍后重试更新说明。".into()),
                404 => return Err("GitHub 未找到发布记录或版本标签，无法读取更新说明。".into()),
                status => {
                    return Err(format!(
                        "GitHub 更新说明请求失败（HTTP {status}），请稍后重试。"
                    ));
                }
            }
            let mut bytes = Vec::new();
            response
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "更新说明读取中断，请重试。")?;
            if bytes.len() > 4 * 1024 * 1024 {
                return Err("GitHub 更新说明响应过大，已停止读取。".into());
            }
            serde_json::from_slice(&bytes).map_err(|_| "GitHub 更新说明格式异常。".into())
        })
    };
    run().map_err(|message| AppError::new("UPDATE_NOTES_UNAVAILABLE", message, true, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn release(v: &str, body: &str) -> Value {
        json!({"tag_name":v,"body":body,"draft":false})
    }

    #[test]
    fn semantic_range_excludes_current_future_and_drafts() {
        let notes = collect_notes("2.0.0-alpha.9", "2.0.0-alpha.11", |_| {
            Ok(json!([
                release("v2.0.0-alpha.9", "old"), release("v2.0.0-alpha.11", "new"),
                release("v2.0.0-alpha.10", "middle"), release("v2.0.0", "future"),
                {"tag_name":"v2.0.0-alpha.10","body":"draft","draft":true},
                release("not-a-version", "bad")
            ]))
        })
        .unwrap();
        assert_eq!(
            notes
                .releases
                .iter()
                .map(|r| r.body.as_str())
                .collect::<Vec<_>>(),
            ["new", "middle"]
        );
        assert!(notes.warnings.is_empty());
    }
    #[test]
    fn reads_all_pages_not_just_first_page_or_date_order() {
        let mut pages = 0;
        let notes = collect_notes("1.0.0", "1.0.2", |path| {
            pages += 1;
            if path.ends_with("page=1") {
                Ok(Value::Array(vec![release("v0.1.0", "old"); 100]))
            } else {
                Ok(json!([
                    release("v1.0.2", "latest"),
                    release("v1.0.1", "middle")
                ]))
            }
        })
        .unwrap();
        assert_eq!(pages, 2);
        assert_eq!(notes.releases.len(), 2);
    }
    #[test]
    fn empty_placeholder_notes_fall_back_to_paginated_commit_titles() {
        let notes = collect_notes("1.0.0", "1.0.1", |path| {
            if path.starts_with("/releases") { return Ok(json!([release("1.0.0", "old"), release("v1.0.1", "请查看本次 Release 的更新说明。") ])); }
            assert!(path.starts_with("/compare/1.0.0...v1.0.1?"));
            if path.ends_with("page=1") { Ok(json!({"status":"ahead","commits":vec![json!({"commit":{"message":"修复导航\n细节"}});100]})) }
            else { Ok(json!({"status":"ahead","commits":[{"commit":{"message":"补充测试"}}]})) }
        }).unwrap();
        assert_eq!(notes.commits.len(), 101);
        assert_eq!(notes.commits[0], "修复导航");
        assert!(!notes.warnings.is_empty());
    }
    #[test]
    fn current_version_shows_its_notes_without_diff() {
        let notes = collect_notes("1.0.0", "1.0.0", |path| {
            assert!(path.starts_with("/releases"));
            Ok(json!([
                release("v1.0.0", "本版说明"),
                release("v1.1.0", "future")
            ]))
        })
        .unwrap();
        assert_eq!(notes.releases.len(), 1);
        assert!(notes.commits.is_empty());
    }

    #[test]
    fn current_version_with_empty_body_uses_previous_tag_commits() {
        let notes = collect_notes("2.0.0-alpha.50", "2.0.0-alpha.50", |path| {
            if path.starts_with("/releases") {
                return Ok(json!([
                    release("v2.0.0-alpha.50", "请查看本次 Release 的更新说明。"),
                    release("v2.0.0-alpha.49", "上一版"),
                    release("v2.0.0-alpha.48", "更早")
                ]));
            }
            assert!(path.starts_with("/compare/v2.0.0-alpha.49...v2.0.0-alpha.50?"));
            Ok(json!({
                "status": "ahead",
                "commits": [
                    {"commit": {"message": "fix(标题栏): 空白处可拖动\n细节"}},
                    {"commit": {"message": "feat(更新说明): 空说明用提交记录补齐"}}
                ]
            }))
        })
        .unwrap();
        assert_eq!(notes.releases.len(), 1);
        assert!(notes.releases[0].body.is_empty());
        assert_eq!(
            notes.commits,
            vec![
                "fix(标题栏): 空白处可拖动",
                "feat(更新说明): 空说明用提交记录补齐"
            ]
        );
        assert!(
            notes
                .warnings
                .iter()
                .any(|w| w.contains("本版未填写更新说明"))
        );
    }
    #[test]
    fn invalid_ranges_rejected_before_network() {
        for (current, target) in [("bad", "1.0.0"), ("2.0.0", "1.0.0"), ("1.0.0", "../evil")] {
            assert!(collect_notes(current, target, |_| panic!("must not fetch")).is_err());
        }
    }
    #[test]
    fn network_failure_is_not_reported_as_no_changes() {
        assert!(collect_notes("1.0.0", "1.0.1", |_| Err("GitHub 请求受限".into())).is_err());
        let notes = collect_notes("1.0.0", "1.0.1", |path| {
            if path.starts_with("/releases") {
                Ok(json!([]))
            } else {
                Err("标签不存在".into())
            }
        })
        .unwrap();
        assert!(notes.warnings.iter().any(|w| w == "标签不存在"));
    }

    #[test]
    fn changelog_link_alone_is_not_a_change_summary() {
        assert!(!meaningful_body(
            "**Full Changelog**: https://github.com/jy018361-ui/audit-toolbox/compare/v1.0.0...v1.0.1"
        ));
        assert!(meaningful_body("## 更新内容\n- 修复导出"));
    }

    #[test]
    fn release_repository_matches_the_installer_endpoint() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let repository = REPOSITORY_API
            .strip_prefix("https://api.github.com/repos/")
            .unwrap();
        assert!(
            config["plugins"]["updater"]["endpoints"][0]
                .as_str()
                .unwrap()
                .starts_with(&format!("https://github.com/{repository}/releases/"))
        );
    }

    #[test]
    #[ignore = "只读访问公开 GitHub Release API，需联网"]
    fn github_live_release_notes() {
        let result = load(env!("CARGO_PKG_VERSION"), env!("CARGO_PKG_VERSION")).unwrap();
        assert!(
            !result.releases.is_empty() || !result.warnings.is_empty(),
            "未发布的构建必须明确提示缺少 Release"
        );
    }
}
