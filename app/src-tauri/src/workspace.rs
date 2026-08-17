//! Per-bot workspace filesystem commands.
//!
//! Each bot gets an isolated directory at `app_data_dir/workspaces/<bot_id>/`
//! (created on demand). Every path handed to a command is validated so it can
//! never resolve outside that bot's workspace: bot ids are restricted to
//! `[A-Za-z0-9_-]+`, relative paths may not be absolute or contain `..`, and
//! existing path prefixes are canonicalized to defeat symlink escapes.
//! Files are capped at 5 MB for both reads and writes.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;

/// Maximum size (bytes) of a single workspace file, for reads and writes.
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// Maximum directory depth `workspace_list` walks (deep trees would otherwise
/// recurse until the stack is exhausted — a SIGSEGV, not a catchable error).
pub const MAX_LIST_DEPTH: usize = 32;
/// Maximum entries `workspace_list` returns (wide trees would otherwise grow
/// an unbounded Vec and take the app down with an OOM).
pub const MAX_LIST_ENTRIES: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    /// Path relative to the bot's workspace root (unix-style separators).
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Result of a workspace listing. `truncated` is true when the walk stopped
/// early because it hit `MAX_LIST_DEPTH` or `MAX_LIST_ENTRIES` — the entries
/// returned are a valid prefix of the tree, not the whole of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListing {
    pub entries: Vec<WorkspaceEntry>,
    pub truncated: bool,
}

/// A bot id must match `^[A-Za-z0-9_-]+$`.
pub fn validate_bot_id(bot_id: &str) -> Result<(), String> {
    if bot_id.is_empty() {
        return Err("bot id must not be empty".into());
    }
    if !bot_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(
            "bot id may only contain ASCII letters, digits, '_' and '-'".into(),
        );
    }
    Ok(())
}

/// A workspace-relative path must be non-empty, relative, free of NUL and
/// backslashes, and must not contain any `..` component.
pub fn validate_rel_path(rel: &str) -> Result<(), String> {
    if rel.trim().is_empty() {
        return Err("path must not be empty".into());
    }
    if rel.contains('\0') {
        return Err("path must not contain NUL bytes".into());
    }
    if rel.contains('\\') {
        return Err("path must use '/' separators".into());
    }
    let path = Path::new(rel);
    if path.is_absolute() || rel.starts_with('/') || rel.starts_with('~') {
        return Err("absolute paths are not allowed".into());
    }
    for component in path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err("path traversal ('..') is not allowed".into()),
        }
    }
    Ok(())
}

fn exists_no_follow(path: &Path) -> bool {
    path.symlink_metadata().is_ok()
}

/// Resolve `rel` inside `root` (which must exist), rejecting traversal and
/// symlink escapes. Returns the absolute path rooted at the canonical root.
pub fn resolve_in_workspace(root: &Path, rel: &str) -> Result<PathBuf, String> {
    validate_rel_path(rel)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("workspace root is unavailable: {e}"))?;
    let joined = canonical_root.join(rel);

    // Canonicalize the deepest existing ancestor to detect symlink escapes.
    // Any non-existing tail components were already validated as plain names.
    let mut existing = joined.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !exists_no_follow(&existing) {
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_os_string());
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let canonical_existing = existing
        .canonicalize()
        .map_err(|e| format!("cannot resolve path: {e}"))?;
    if !canonical_existing.starts_with(&canonical_root) {
        return Err("path escapes the bot workspace".into());
    }
    // Return the CANONICAL path (existing prefix resolved, validated tail
    // re-appended) rather than the raw join: callers operate on exactly the
    // path that was checked, so no intermediate symlink can be swapped in
    // between the check and the use.
    let mut resolved = canonical_existing;
    for name in tail.iter().rev() {
        resolved.push(name);
    }
    if !resolved.starts_with(&canonical_root) {
        return Err("path escapes the bot workspace".into());
    }
    Ok(resolved)
}

/// Recursively list entries under `root`, sorted by relative path.
/// Symlinks are skipped entirely (never followed). The walk is bounded by
/// `MAX_LIST_DEPTH` and `MAX_LIST_ENTRIES`; hitting either stops the walk and
/// flags the listing as truncated instead of blowing the stack or the heap.
pub fn list_in(root: &Path) -> Result<WorkspaceListing, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("workspace root is unavailable: {e}"))?;
    let mut entries = Vec::new();
    let mut truncated = false;
    collect_entries(
        &canonical_root,
        &canonical_root,
        0,
        &mut entries,
        &mut truncated,
    )?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(WorkspaceListing { entries, truncated })
}

fn collect_entries(
    root: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<WorkspaceEntry>,
    truncated: &mut bool,
) -> Result<(), String> {
    if depth >= MAX_LIST_DEPTH {
        *truncated = true;
        return Ok(());
    }
    let read_dir =
        fs::read_dir(dir).map_err(|e| format!("cannot list {}: {e}", dir.display()))?;
    for entry in read_dir {
        if out.len() >= MAX_LIST_ENTRIES {
            *truncated = true;
            return Ok(());
        }
        let entry = entry.map_err(|e| format!("cannot read directory entry: {e}"))?;
        let path = entry.path();
        let meta = match path.symlink_metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            // Never follow or report symlinks.
            continue;
        }
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if meta.is_dir() {
            out.push(WorkspaceEntry {
                path: rel,
                is_dir: true,
                size: 0,
            });
            collect_entries(root, &path, depth + 1, out, truncated)?;
        } else {
            out.push(WorkspaceEntry {
                path: rel,
                is_dir: false,
                size: meta.len(),
            });
        }
    }
    Ok(())
}

/// Read a UTF-8 file inside `root`, enforcing the 5 MB cap.
///
/// The cap is applied to the bytes actually read (a bounded `take`), not to a
/// prior `stat`: a file that grows between the two calls cannot slip past it.
pub fn read_in(root: &Path, rel: &str) -> Result<String, String> {
    let path = resolve_in_workspace(root, rel)?;
    let meta = fs::symlink_metadata(&path).map_err(|_| format!("file not found: {rel}"))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(format!("not a file: {rel}"));
    }
    let file = fs::File::open(&path).map_err(|e| format!("cannot read {rel}: {e}"))?;
    let mut buf: Vec<u8> = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("cannot read {rel}: {e}"))?;
    if buf.len() as u64 > MAX_FILE_BYTES {
        return Err(format!("file exceeds the 5MB limit: {rel}"));
    }
    String::from_utf8(buf).map_err(|_| format!("file is not valid UTF-8: {rel}"))
}

/// Write a file inside `root`, creating parent directories, enforcing the cap.
pub fn write_in(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("content exceeds the 5MB limit".into());
    }
    let path = resolve_in_workspace(root, rel)?;
    if exists_no_follow(&path) && !path.is_file() {
        return Err(format!("not a writable file: {rel}"));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create parent directories: {e}"))?;
    }
    fs::write(&path, content).map_err(|e| format!("cannot write {rel}: {e}"))
}

/// Delete a file or directory (recursively) inside `root`.
/// The workspace root itself cannot be deleted.
pub fn delete_in(root: &Path, rel: &str) -> Result<(), String> {
    let path = resolve_in_workspace(root, rel)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("workspace root is unavailable: {e}"))?;
    let meta = path
        .symlink_metadata()
        .map_err(|_| format!("not found: {rel}"))?;
    let canonical = if meta.file_type().is_symlink() {
        // A symlink itself may be removed; do not follow it.
        path.clone()
    } else {
        path.canonicalize()
            .map_err(|e| format!("cannot resolve path: {e}"))?
    };
    if canonical == canonical_root {
        return Err("cannot delete the workspace root".into());
    }
    if meta.file_type().is_symlink() || meta.is_file() {
        fs::remove_file(&path).map_err(|e| format!("cannot delete {rel}: {e}"))
    } else {
        fs::remove_dir_all(&path).map_err(|e| format!("cannot delete {rel}: {e}"))
    }
}

/// Resolve (and create on demand) `app_data_dir/workspaces/<bot_id>/`.
/// Shared with the compute-session layer (`session.rs`): local sessions
/// execute inside this same root, so sync-back is inherent.
pub fn workspace_root(app: &tauri::AppHandle, bot_id: &str) -> Result<PathBuf, String> {
    validate_bot_id(bot_id)?;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    let root = base.join("workspaces").join(bot_id);
    fs::create_dir_all(&root).map_err(|e| format!("cannot create workspace: {e}"))?;
    Ok(root)
}

#[tauri::command]
pub fn workspace_list(
    app: tauri::AppHandle,
    bot_id: String,
) -> Result<WorkspaceListing, String> {
    let root = workspace_root(&app, &bot_id)?;
    list_in(&root)
}

#[tauri::command]
pub fn workspace_read(
    app: tauri::AppHandle,
    bot_id: String,
    rel_path: String,
) -> Result<String, String> {
    let root = workspace_root(&app, &bot_id)?;
    read_in(&root, &rel_path)
}

#[tauri::command]
pub fn workspace_write(
    app: tauri::AppHandle,
    bot_id: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    let root = workspace_root(&app, &bot_id)?;
    write_in(&root, &rel_path, &content)
}

#[tauri::command]
pub fn workspace_delete(
    app: tauri::AppHandle,
    bot_id: String,
    rel_path: String,
) -> Result<(), String> {
    let root = workspace_root(&app, &bot_id)?;
    delete_in(&root, &rel_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn workspace() -> TempDir {
        TempDir::new().expect("create temp workspace")
    }

    #[test]
    fn bot_id_accepts_safe_characters() {
        assert!(validate_bot_id("bot-1_A").is_ok());
        assert!(validate_bot_id("abc123").is_ok());
    }

    #[test]
    fn bot_id_rejects_empty_and_unsafe() {
        assert!(validate_bot_id("").is_err());
        assert!(validate_bot_id("../evil").is_err());
        assert!(validate_bot_id("a/b").is_err());
        assert!(validate_bot_id("a b").is_err());
        assert!(validate_bot_id("a.b").is_err());
        assert!(validate_bot_id("bот").is_err()); // non-ASCII
    }

    #[test]
    fn rel_path_accepts_nested_names() {
        assert!(validate_rel_path("notes.txt").is_ok());
        assert!(validate_rel_path("a/b/c.md").is_ok());
        assert!(validate_rel_path("./a.txt").is_ok());
    }

    #[test]
    fn rel_path_rejects_traversal_and_absolute() {
        assert!(validate_rel_path("").is_err());
        assert!(validate_rel_path("   ").is_err());
        assert!(validate_rel_path("../secret").is_err());
        assert!(validate_rel_path("a/../../secret").is_err());
        assert!(validate_rel_path("/etc/passwd").is_err());
        assert!(validate_rel_path("~/x").is_err());
        assert!(validate_rel_path("a\\b").is_err());
        assert!(validate_rel_path("a\0b").is_err());
    }

    #[test]
    fn resolve_stays_inside_workspace() {
        let ws = workspace();
        let path = resolve_in_workspace(ws.path(), "sub/file.txt").unwrap();
        assert!(path.starts_with(ws.path().canonicalize().unwrap()));
    }

    #[test]
    fn resolve_rejects_traversal() {
        let ws = workspace();
        assert!(resolve_in_workspace(ws.path(), "../outside.txt").is_err());
        assert!(resolve_in_workspace(ws.path(), "a/../../outside.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlink_dir_escape() {
        let ws = workspace();
        let outside = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), ws.path().join("link")).unwrap();
        let err = resolve_in_workspace(ws.path(), "link/file.txt").unwrap_err();
        assert!(err.contains("escapes"), "unexpected error: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlink_file_escape() {
        let ws = workspace();
        let outside = TempDir::new().unwrap();
        let target = outside.path().join("secret.txt");
        fs::write(&target, "secret").unwrap();
        std::os::unix::fs::symlink(&target, ws.path().join("alias.txt")).unwrap();
        let err = resolve_in_workspace(ws.path(), "alias.txt").unwrap_err();
        assert!(err.contains("escapes"), "unexpected error: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_dangling_symlink() {
        let ws = workspace();
        std::os::unix::fs::symlink("/nonexistent/xyz", ws.path().join("dead")).unwrap();
        assert!(resolve_in_workspace(ws.path(), "dead").is_err());
    }

    #[test]
    fn write_read_delete_roundtrip() {
        let ws = workspace();
        write_in(ws.path(), "a/b/notes.txt", "hello").unwrap();
        assert_eq!(read_in(ws.path(), "a/b/notes.txt").unwrap(), "hello");
        let entries = list_in(ws.path()).unwrap().entries;
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["a", "a/b", "a/b/notes.txt"]);
        assert_eq!(entries[2].size, 5);
        assert!(!entries[2].is_dir);
        delete_in(ws.path(), "a/b/notes.txt").unwrap();
        assert!(read_in(ws.path(), "a/b/notes.txt").is_err());
        delete_in(ws.path(), "a").unwrap();
        assert!(list_in(ws.path()).unwrap().entries.is_empty());
    }

    /// M4: a deep tree must not recurse until the stack dies.
    #[test]
    fn list_stops_at_the_depth_limit() {
        let ws = workspace();
        let mut deep = ws.path().to_path_buf();
        for i in 0..(MAX_LIST_DEPTH + 20) {
            deep = deep.join(format!("d{i}"));
        }
        fs::create_dir_all(&deep).unwrap();
        let listing = list_in(ws.path()).unwrap();
        assert!(listing.truncated, "deep tree must report truncation");
        assert_eq!(listing.entries.len(), MAX_LIST_DEPTH);
    }

    /// M4: a wide tree must not grow an unbounded Vec.
    #[test]
    fn list_stops_at_the_entry_limit() {
        let ws = workspace();
        for i in 0..(MAX_LIST_ENTRIES + 50) {
            fs::write(ws.path().join(format!("f{i}.txt")), "x").unwrap();
        }
        let listing = list_in(ws.path()).unwrap();
        assert!(listing.truncated, "wide tree must report truncation");
        assert_eq!(listing.entries.len(), MAX_LIST_ENTRIES);
    }

    #[test]
    fn small_listings_are_not_truncated() {
        let ws = workspace();
        write_in(ws.path(), "a.txt", "hi").unwrap();
        let listing = list_in(ws.path()).unwrap();
        assert!(!listing.truncated);
        assert_eq!(listing.entries.len(), 1);
    }

    /// L2: the path handed back is the canonical one, so the operation runs
    /// on exactly the path that was validated.
    #[cfg(unix)]
    #[test]
    fn resolve_returns_a_canonical_path_through_inner_symlinks() {
        let ws = workspace();
        let real = ws.path().join("real");
        fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, ws.path().join("alias")).unwrap();
        let resolved = resolve_in_workspace(ws.path(), "alias/file.txt").unwrap();
        assert_eq!(resolved, real.canonicalize().unwrap().join("file.txt"));
        assert!(!resolved.to_string_lossy().contains("alias"));
    }

    /// L2: the size cap applies to bytes read, not to a prior stat.
    #[test]
    fn read_cap_counts_bytes_actually_read() {
        let ws = workspace();
        let path = ws.path().join("grown.txt");
        fs::write(&path, "x".repeat(10)).unwrap();
        // Now make it oversized behind the earlier metadata's back.
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(MAX_FILE_BYTES + 1).unwrap();
        drop(file);
        let err = read_in(ws.path(), "grown.txt").unwrap_err();
        assert!(err.contains("5MB"), "got: {err}");
    }

    #[test]
    fn write_rejects_oversized_content() {
        let ws = workspace();
        let big = "x".repeat((MAX_FILE_BYTES + 1) as usize);
        let err = write_in(ws.path(), "big.txt", &big).unwrap_err();
        assert!(err.contains("5MB"));
    }

    #[test]
    fn read_rejects_oversized_file() {
        let ws = workspace();
        let path = ws.path().join("big.txt");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_FILE_BYTES + 1).unwrap();
        let err = read_in(ws.path(), "big.txt").unwrap_err();
        assert!(err.contains("5MB"));
    }

    #[test]
    fn delete_rejects_workspace_root() {
        let ws = workspace();
        assert!(delete_in(ws.path(), ".").is_err());
    }

    #[test]
    fn list_skips_symlinks() {
        let ws = workspace();
        write_in(ws.path(), "real.txt", "data").unwrap();
        #[cfg(unix)]
        {
            let outside = TempDir::new().unwrap();
            std::os::unix::fs::symlink(outside.path(), ws.path().join("link")).unwrap();
        }
        let entries = list_in(ws.path()).unwrap().entries;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "real.txt");
    }
}
