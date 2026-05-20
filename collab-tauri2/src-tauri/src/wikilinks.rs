use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
pub struct WikilinkSuggestion {
    pub stem: String,
    pub path: String,
    pub ambiguous: bool,
}

#[derive(Serialize)]
pub struct Backlink {
    pub path: String,
    pub context: String,
}

/// Scan workspace markdown files for wikilinks [[target]]
fn scan_wikilinks(workspace_path: &str) -> Vec<(String, String, Vec<String>)> {
    // Returns vec of (stem, path, contexts)
    let mut results = Vec::new();
    for entry in walk_dir(workspace_path) {
        if entry.extension().map_or(false, |e| e == "md" || e == "mdx") {
            if let Ok(content) = fs::read_to_string(&entry) {
                for cap in regex::Regex::new(r"\[\[(.+?)\]\]").unwrap().captures_iter(&content) {
                    let stem = cap[1].to_string();
                    let rel = entry.strip_prefix(workspace_path).unwrap_or(&entry);
                    results.push((stem, rel.to_string_lossy().to_string(), vec![]));
                }
            }
        }
    }
    results
}

fn walk_dir(dir: &str) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            if name == ".git" || name == "node_modules" {
                continue;
            }
            if path.is_dir() {
                files.extend(walk_dir(&path.to_string_lossy()));
            } else if path.is_file() {
                files.push(path);
            }
        }
    }
    files
}

#[tauri::command]
pub fn wikilink_resolve(target: String) -> Result<Option<String>, String> {
    // Try to find a file whose stem matches the target
    let config_path = crate::config::config_path();
    let cfg = crate::config::load_config(&config_path).unwrap_or_default();

    for ws in &cfg.workspaces {
        for (stem, path, _ctx) in scan_wikilinks(ws) {
            let file_stem = Path::new(&path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if file_stem == target || stem == target {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn wikilink_suggest(partial: String) -> Result<Vec<WikilinkSuggestion>, String> {
    let config_path = crate::config::config_path();
    let cfg = crate::config::load_config(&config_path).unwrap_or_default();
    let mut suggestions = Vec::new();

    for ws in &cfg.workspaces {
        for (stem, path, _ctx) in scan_wikilinks(ws) {
            if stem.to_lowercase().contains(&partial.to_lowercase()) {
                let file_stem = Path::new(&path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                // Check if ambiguous (same stem appears in multiple files)
                let ambiguous = suggestions.iter().any(|s: &WikilinkSuggestion| s.stem == file_stem);
                suggestions.push(WikilinkSuggestion {
                    stem: file_stem,
                    path,
                    ambiguous,
                });
            }
        }
    }
    Ok(suggestions)
}

#[tauri::command]
pub fn wikilink_backlinks(file_path: String) -> Result<Vec<Backlink>, String> {
    let config_path = crate::config::config_path();
    let cfg = crate::config::load_config(&config_path).unwrap_or_default();
    let mut backlinks = Vec::new();

    let file_stem = Path::new(&file_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    for ws in &cfg.workspaces {
        for entry in walk_dir(ws) {
            if entry.extension().map_or(false, |e| e == "md" || e == "mdx") {
                if let Ok(content) = fs::read_to_string(&entry) {
                    let pattern = format!("[[{}", file_stem);
                    if content.contains(&pattern) {
                        let rel = entry.strip_prefix(ws).unwrap_or(&entry);
                        // Extract context: the line containing the wikilink
                        for line in content.lines() {
                            if line.contains(&pattern) {
                                let context = line.trim().chars().take(200).collect();
                                backlinks.push(Backlink {
                                    path: rel.to_string_lossy().to_string(),
                                    context,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(backlinks)
}
