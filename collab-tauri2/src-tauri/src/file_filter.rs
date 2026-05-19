use std::path::Path;

/// Default patterns to ignore (matching Electron's file-filter.ts)
const DEFAULT_PATTERNS: &[&str] = &[
    "node_modules",
    "bower_components",
    "dist",
    "build",
    "out",
    ".next",
    ".cache",
    ".venv",
    "venv",
    "site-packages",
    "__pycache__",
    ".DS_Store",
    "Thumbs.db",
    "*.min.js",
    "*.min.css",
    "*.map",
    "*.lock",
    "package-lock.json",
    "bun.lockb",
    "yarn.lock",
    "pnpm-lock.yaml",
];

/// Image file extensions
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tiff", "avif",
];

/// PDF files
const PDF_EXTENSIONS: &[&str] = &["pdf"];

pub fn is_ignored(name: &str) -> bool {
    for pattern in DEFAULT_PATTERNS {
        if let Some(prefix) = pattern.strip_suffix('*') {
            if name.starts_with(prefix) {
                return true;
            }
        } else if name == *pattern {
            return true;
        }
    }
    false
}

pub fn is_image_file(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn is_pdf_file(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| PDF_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

#[tauri::command]
pub fn file_should_ignore(path: String) -> bool {
    let name = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&path);
    is_ignored(name)
}

#[tauri::command]
pub fn file_is_image(path: String) -> bool {
    is_image_file(&path)
}

#[tauri::command]
pub fn file_is_pdf(path: String) -> bool {
    is_pdf_file(&path)
}

pub fn register_file_filter_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        file_should_ignore,
        file_is_image,
        file_is_pdf,
    ])
}
