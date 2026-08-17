//! Menu bar extra (tray icon).
//!
//! The tray menu shows one disabled line per bot ("<name> — <status>"), a
//! separator, then "Pause All Bots" and "Open Bots". The frontend rebuilds the
//! bot lines via the `tray_update` command; menu actions are forwarded to the
//! frontend as Tauri events (`tray://pause-all`, `tray://open`).

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const TRAY_ID: &str = "bots-tray";
pub const EVENT_PAUSE_ALL: &str = "tray://pause-all";
pub const EVENT_OPEN: &str = "tray://open";
const MENU_ID_PAUSE_ALL: &str = "tray-pause-all";
const MENU_ID_OPEN: &str = "tray-open";

#[derive(Debug, Clone, Deserialize)]
pub struct TrayBotItem {
    pub id: String,
    /// Preformatted line, e.g. "Scout — running".
    pub title: String,
}

fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    items: &[TrayBotItem],
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for item in items {
        // Bot status lines are informational: disabled, not clickable.
        menu.append(&MenuItem::with_id(
            app,
            format!("bot:{}", item.id),
            &item.title,
            false,
            None::<&str>,
        )?)?;
    }
    if !items.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(
        app,
        MENU_ID_PAUSE_ALL,
        "Pause All Bots",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        MENU_ID_OPEN,
        "Open Bots",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

/// Create the tray icon with an initially empty bot list. Called once at setup.
pub fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app, &[])?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Bots")
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_ID_PAUSE_ALL => {
                let _ = app.emit(EVENT_PAUSE_ALL, ());
            }
            MENU_ID_OPEN => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                let _ = app.emit(EVENT_OPEN, ());
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Rebuild the tray menu's bot lines. `items` fully replaces the previous list.
#[tauri::command]
pub fn tray_update<R: Runtime>(
    app: AppHandle<R>,
    items: Vec<TrayBotItem>,
) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "tray is not initialized".to_string())?;
    let menu = build_menu(&app, &items).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    Ok(())
}
