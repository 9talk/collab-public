use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    App, Wry,
};

pub fn build_menu(app: &App) -> Result<Menu<Wry>, tauri::Error> {
    let menu = Menu::new(app)?;

    // File menu
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "new-tile", "New Tile", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(app, "close-tile", "Close Tile", true, Some("CmdOrCtrl+W"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "open-workspace",
                "Open Workspace\u{2026}",
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?,
        ],
    )?;
    menu.append(&file_menu)?;

    // Edit menu
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &MenuItem::with_id(app, "undo", "Undo", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, "redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "cut", "Cut", true, Some("CmdOrCtrl+X"))?,
            &MenuItem::with_id(app, "copy", "Copy", true, Some("CmdOrCtrl+C"))?,
            &MenuItem::with_id(app, "paste", "Paste", true, Some("CmdOrCtrl+V"))?,
            &MenuItem::with_id(app, "select-all", "Select All", true, Some("CmdOrCtrl+A"))?,
        ],
    )?;
    menu.append(&edit_menu)?;

    // View menu
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "toggle-files", "Toggle Files", true, Some("CmdOrCtrl+B"))?,
            &MenuItem::with_id(app, "toggle-agent", "Toggle Agent", true, Some("CmdOrCtrl+Alt+B"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(app, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?,
            &MenuItem::with_id(app, "zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?,
        ],
    )?;
    menu.append(&view_menu)?;

    // Window menu
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &MenuItem::with_id(app, "minimize", "Minimize", true, Some("CmdOrCtrl+M"))?,
            &MenuItem::with_id(app, "zoom-window", "Zoom", true, None::<&str>)?,
        ],
    )?;
    menu.append(&window_menu)?;

    Ok(menu)
}
