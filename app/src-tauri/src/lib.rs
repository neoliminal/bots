mod fly;
mod host;
mod mcp;
mod session;
mod tray;
mod webfetch;
mod workspace;

use std::path::{Path, PathBuf};

/// DEV ONLY: locate `keys/.env` by walking up parent directories from the
/// executable's directory and the current working directory, then return the
/// value of `OPENROUTER_API_KEY` from it. The key value is never logged.
///
/// Gated on `debug_assertions`: this command does not exist in a release
/// build, and it is not registered in the release invoke handler either (see
/// `run`), so a shipped app exposes no path from the webview to `keys/.env`.
/// Error strings are deliberately generic — the absolute path of the secrets
/// file is logged host-side only, never returned to the webview.
#[cfg(debug_assertions)]
#[tauri::command]
fn get_dev_api_key() -> Result<String, String> {
    let env_path = find_keys_env().ok_or_else(|| {
        "keys/.env not found in any parent directory of the executable or cwd".to_string()
    })?;
    let contents = std::fs::read_to_string(&env_path).map_err(|e| {
        eprintln!("get_dev_api_key: failed to read {}: {e}", env_path.display());
        "failed to read keys/.env".to_string()
    })?;
    parse_openrouter_key(&contents).ok_or_else(|| {
        eprintln!(
            "get_dev_api_key: OPENROUTER_API_KEY not found in {}",
            env_path.display()
        );
        "OPENROUTER_API_KEY not found in keys/.env".to_string()
    })
}

/// Walk up from each starting directory until a directory containing
/// `keys/.env` is found.
pub(crate) fn find_keys_env() -> Option<PathBuf> {
    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            starts.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    for start in starts {
        let mut dir: Option<&Path> = Some(start.as_path());
        while let Some(d) = dir {
            let candidate = d.join("keys").join(".env");
            if candidate.is_file() {
                return Some(candidate);
            }
            dir = d.parent();
        }
    }
    None
}

/// Parse a single named entry from dotenv-style file contents.
/// Ignores comments and surrounding whitespace; strips matching quotes.
///
/// This is deliberately NOT exposed as a generic getter command: only
/// `OPENROUTER_API_KEY` (via `get_dev_api_key`) is ever handed to the
/// webview, and `FLY_API_TOKEN` is consumed Rust-side only by the `fly_*`
/// commands (`fly.rs`) — it never crosses the IPC boundary.
pub(crate) fn parse_env_entry(contents: &str, name: &str) -> Option<String> {
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        if let Some((entry_name, value)) = line.split_once('=') {
            if entry_name.trim() == name {
                let mut value = value.trim();
                if value.len() >= 2
                    && ((value.starts_with('"') && value.ends_with('"'))
                        || (value.starts_with('\'') && value.ends_with('\'')))
                {
                    value = &value[1..value.len() - 1];
                }
                if value.is_empty() {
                    return None;
                }
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Parse `OPENROUTER_API_KEY=...` from dotenv-style file contents.
/// Only reachable from the debug-only `get_dev_api_key` command (and its
/// tests); in a release build nothing calls it.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn parse_openrouter_key(contents: &str) -> Option<String> {
    parse_env_entry(contents, "OPENROUTER_API_KEY")
}

/// Read a named entry from `keys/.env` (dev secrets file). Rust-side use only.
pub(crate) fn read_keys_env_entry(name: &str) -> Option<String> {
    let env_path = find_keys_env()?;
    let contents = std::fs::read_to_string(&env_path).ok()?;
    parse_env_entry(&contents, name)
}

/// Set (or clear, with `None`) the dock badge count (macOS). On platforms
/// without a numeric badge (Windows taskbar) this is best-effort: failures
/// are swallowed so the frontend's unread bookkeeping never errors.
#[tauri::command]
fn set_badge_count(window: tauri::WebviewWindow, count: Option<i64>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        window.set_badge_count(count).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_badge_count(count);
        Ok(())
    }
}

/// A file name for `save_text_file` must be a bare name: no separators, no
/// leading dot, no NUL, and non-empty after trimming.
pub(crate) fn validate_save_file_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("file name must not be empty".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains('\0') {
        return Err("file name must not contain path separators".into());
    }
    if trimmed.starts_with('.') {
        return Err("file name must not start with '.'".into());
    }
    Ok(())
}

/// Save UTF-8 text into the user's Downloads folder (WKWebView ignores the
/// anchor `download` attribute, so in-app exports — e.g. persona template
/// files — go through this command). Never overwrites: an existing name gets
/// a ` (n)` suffix. Returns the absolute path written. Capped at 5 MB.
#[tauri::command]
fn save_text_file(
    app: tauri::AppHandle,
    file_name: String,
    contents: String,
) -> Result<String, String> {
    use tauri::Manager;
    validate_save_file_name(&file_name)?;
    if contents.len() as u64 > workspace::MAX_FILE_BYTES {
        return Err("file exceeds the 5 MB limit".into());
    }
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("could not resolve the Downloads folder: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let target = next_free_download_path(&dir, file_name.trim())?;
    std::fs::write(&target, contents)
        .map_err(|e| format!("failed to write {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().into_owned())
}

/// Pick a path in `dir` that nothing occupies yet, adding a ` (n)` suffix on
/// collision. Existence is probed with `symlink_metadata`, which does NOT
/// follow links: a dangling symlink planted at the target name still counts
/// as occupied (`Path::exists` would report `false` and let `fs::write`
/// follow the link to an attacker-chosen location). As a belt-and-braces
/// check the chosen path is refused outright if anything — symlink included —
/// exists there.
pub(crate) fn next_free_download_path(dir: &Path, file_name: &str) -> Result<PathBuf, String> {
    fn occupied(path: &Path) -> bool {
        path.symlink_metadata().is_ok()
    }
    let (stem, ext) = match file_name.find('.') {
        Some(idx) => (&file_name[..idx], &file_name[idx..]),
        None => (file_name, ""),
    };
    let mut target = dir.join(file_name);
    let mut counter = 1;
    while occupied(&target) {
        target = dir.join(format!("{stem} ({counter}){ext}"));
        counter += 1;
        if counter > 1000 {
            return Err("could not find a free file name in Downloads".into());
        }
    }
    if target.symlink_metadata().is_ok() {
        return Err("refusing to write over an existing entry".into());
    }
    Ok(target)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());

    // Two handler lists: the debug one additionally exposes `get_dev_api_key`.
    // A release build has no command that hands `keys/.env` to the webview.
    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        get_dev_api_key,
        workspace::workspace_list,
        workspace::workspace_read,
        workspace::workspace_write,
        workspace::workspace_delete,
        session::session_local_exec,
        host::host_exec,
        host::host_set_target,
        host::host_discover,
        fly::fly_provision,
        fly::fly_exec,
        fly::fly_read_file,
        fly::fly_write_file,
        fly::fly_stop,
        fly::fly_status,
        webfetch::web_fetch,
        mcp::mcp_connect,
        mcp::mcp_call,
        mcp::mcp_disconnect,
        mcp::mcp_servers,
        tray::tray_update,
        set_badge_count,
        save_text_file
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        workspace::workspace_list,
        workspace::workspace_read,
        workspace::workspace_write,
        workspace::workspace_delete,
        session::session_local_exec,
        host::host_exec,
        host::host_set_target,
        host::host_discover,
        fly::fly_provision,
        fly::fly_exec,
        fly::fly_read_file,
        fly::fly_write_file,
        fly::fly_stop,
        fly::fly_status,
        webfetch::web_fetch,
        mcp::mcp_connect,
        mcp::mcp_call,
        mcp::mcp_disconnect,
        mcp::mcp_servers,
        tray::tray_update,
        set_badge_count,
        save_text_file
    ]);

    builder
        .setup(|app| {
            #[cfg(desktop)]
            tray::setup_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{parse_env_entry, parse_openrouter_key};

    #[test]
    fn parses_plain_key() {
        assert_eq!(
            parse_openrouter_key("OPENROUTER_API_KEY=sk-or-abc123"),
            Some("sk-or-abc123".to_string())
        );
    }

    #[test]
    fn parses_quoted_key_with_comments_and_export() {
        let contents = "# comment\nexport OPENROUTER_API_KEY=\"sk-or-xyz\"\nOTHER=1\n";
        assert_eq!(
            parse_openrouter_key(contents),
            Some("sk-or-xyz".to_string())
        );
    }

    #[test]
    fn missing_or_empty_key_is_none() {
        assert_eq!(parse_openrouter_key("OTHER=1"), None);
        assert_eq!(parse_openrouter_key("OPENROUTER_API_KEY="), None);
    }

    #[test]
    fn parse_env_entry_finds_named_entries_independently() {
        let contents =
            "# keys\nOPENROUTER_API_KEY=sk-or-1\nexport FLY_API_TOKEN='fm2_abc'\nFLY_APP_NAME=my-app\n";
        assert_eq!(
            parse_env_entry(contents, "FLY_API_TOKEN"),
            Some("fm2_abc".to_string())
        );
        assert_eq!(
            parse_env_entry(contents, "FLY_APP_NAME"),
            Some("my-app".to_string())
        );
        assert_eq!(
            parse_env_entry(contents, "OPENROUTER_API_KEY"),
            Some("sk-or-1".to_string())
        );
        assert_eq!(parse_env_entry(contents, "MISSING"), None);
    }

    #[test]
    fn parse_env_entry_does_not_match_prefixes() {
        assert_eq!(parse_env_entry("FLY_API_TOKEN_EXTRA=x", "FLY_API_TOKEN"), None);
        assert_eq!(parse_env_entry("FLY_API_TOKEN=", "FLY_API_TOKEN"), None);
    }

    #[test]
    fn save_file_name_rules() {
        use super::validate_save_file_name;
        assert!(validate_save_file_name("notes.md").is_ok());
        assert!(validate_save_file_name("").is_err());
        assert!(validate_save_file_name("a/b").is_err());
        assert!(validate_save_file_name(".ssh").is_err());
        assert!(validate_save_file_name("a\0b").is_err());
    }

    #[test]
    fn download_path_skips_existing_plain_files() {
        use super::next_free_download_path;
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        let picked = next_free_download_path(dir.path(), "a.txt").unwrap();
        assert_eq!(picked, dir.path().join("a (1).txt"));
    }

    /// L1: a DANGLING symlink planted at the target name must count as
    /// occupied. `Path::exists()` reports false for it, which previously let
    /// `fs::write` follow the link and write outside Downloads.
    #[cfg(unix)]
    #[test]
    fn download_path_refuses_to_follow_a_dangling_symlink() {
        use super::next_free_download_path;
        let dir = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        let victim = outside.path().join("victim.txt");
        std::os::unix::fs::symlink(&victim, dir.path().join("export.txt")).unwrap();
        assert!(!dir.path().join("export.txt").exists(), "dangling by design");

        let picked = next_free_download_path(dir.path(), "export.txt").unwrap();
        assert_eq!(picked, dir.path().join("export (1).txt"));
        std::fs::write(&picked, "data").unwrap();
        assert!(!victim.exists(), "write escaped through the symlink");
    }

    /// A live symlink is likewise never written through.
    #[cfg(unix)]
    #[test]
    fn download_path_skips_a_live_symlink() {
        use super::next_free_download_path;
        let dir = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        let victim = outside.path().join("victim.txt");
        std::fs::write(&victim, "original").unwrap();
        std::os::unix::fs::symlink(&victim, dir.path().join("export.txt")).unwrap();

        let picked = next_free_download_path(dir.path(), "export.txt").unwrap();
        std::fs::write(&picked, "data").unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "original");
    }
}
