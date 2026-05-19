use regex::Regex;

const URL_REGEX: &str = r##"(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"'':,.!?{}|\\^~\[\]`()<>]"##;
const URL_COLOR: &str = "\x1b[38;2;0;150;255m";
const RESET: &str = "\x1b[0m";

/// Wrap bare http/https URLs in PTY output with ANSI color codes.
#[tauri::command]
pub fn colorize_urls(text: String) -> String {
    let re = Regex::new(URL_REGEX).unwrap();
    re.replace_all(&text, |caps: &regex::Captures| {
        format!("{}{}{}", URL_COLOR, &caps[0], RESET)
    })
    .to_string()
}

pub fn register_colorize_commands(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![colorize_urls])
}
