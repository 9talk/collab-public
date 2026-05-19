use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub window_x: i32,
    pub window_y: i32,
    pub window_width: u32,
    pub window_height: u32,
    pub window_maximized: bool,
    pub theme: String,
    pub locale: String,
    pub prefs: serde_json::Value,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            window_x: 0,
            window_y: 0,
            window_width: 1200,
            window_height: 800,
            window_maximized: false,
            theme: "system".to_string(),
            locale: "en".to_string(),
            prefs: serde_json::json!({}),
        }
    }
}

pub fn config_dir() -> PathBuf {
    let dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.join("collaborator")
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

pub fn load_config(path: &PathBuf) -> Result<Config, Box<dyn std::error::Error>> {
    match fs::read_to_string(path) {
        Ok(content) => {
            let config: Config = serde_json::from_str(&content)?;
            Ok(config)
        }
        Err(_) => {
            let config = Config::default();
            save_config(path, &config)?;
            Ok(config)
        }
    }
}

pub fn save_config(path: &PathBuf, config: &Config) -> Result<(), Box<dyn std::error::Error>> {
    let dir = path.parent().unwrap();
    if !dir.exists() {
        fs::create_dir_all(dir)?;
    }
    let content = serde_json::to_string_pretty(config)?;
    fs::write(path, content)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_save_and_load_config() {
        let dir = std::env::temp_dir().join("collab_config_test");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");

        let mut config = Config::default();
        config.window_width = 1200;
        config.window_height = 800;
        save_config(&path, &config).unwrap();

        let loaded = load_config(&path).unwrap();
        assert_eq!(loaded.window_width, 1200);
        assert_eq!(loaded.window_height, 800);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_load_missing_config_returns_default() {
        let path = PathBuf::from("/tmp/nonexistent_config_12345/config.json");
        let config = load_config(&path).unwrap();
        assert_eq!(config.window_width, 1200);
        assert_eq!(config.window_height, 800);
    }
}
