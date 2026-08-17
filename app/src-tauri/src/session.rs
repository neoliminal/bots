//! Local compute-session provider (`session_local_exec`).
//!
//! Spec: openspec/specs/agent-computer/spec.md — the LOCAL provider runs
//! commands directly inside the bot's existing workspace directory (the same
//! root `workspace.rs` serves), so the local workspace IS the session
//! filesystem and sync-back is inherent.
//!
//! Guards:
//! - cwd is locked to the bot's workspace root (`/bin/sh -c` on Unix,
//!   `cmd.exe /d /s /c` on Windows, with `current_dir` = workspace; HOME —
//!   and USERPROFILE on Windows — also point there).
//! - Environment is fully sanitized: the child inherits NOTHING from the app
//!   process (`env_clear`), then receives a minimal allowlist (PATH, HOME,
//!   TMPDIR, LANG, SHELL). In particular no `*_KEY` / `*_TOKEN` / `*_SECRET`
//!   variables can leak — they are stripped along with everything else.
//! - Combined stdout+stderr output is capped at 256 KB; hitting the cap
//!   kills the process group and marks the result truncated.
//! - Timeout defaults to 30 s, clamps to 300 s max; on expiry the whole
//!   process GROUP is SIGKILLed so backgrounded children die too.

use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Combined stdout+stderr cap (bytes).
pub const MAX_OUTPUT_BYTES: usize = 256 * 1024;
/// Default command timeout when the caller passes none.
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Hard ceiling for the command timeout.
pub const MAX_TIMEOUT_MS: u64 = 300_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    /// Process exit code; `None` when killed by signal (timeout/truncation).
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// True when output hit the 256 KB cap (process group was killed).
    pub truncated: bool,
    /// True when the timeout expired (process group was killed).
    pub timed_out: bool,
    pub duration_ms: u64,
}

/// Clamp a requested timeout into [1, MAX_TIMEOUT_MS], defaulting to
/// DEFAULT_TIMEOUT_MS when absent or zero.
pub fn effective_timeout_ms(requested: Option<u64>) -> u64 {
    match requested {
        None | Some(0) => DEFAULT_TIMEOUT_MS,
        Some(ms) => ms.min(MAX_TIMEOUT_MS),
    }
}

/// The minimal environment handed to local session commands. Built from
/// scratch (never inherited), so app secrets and any `*_KEY` / `*_TOKEN` /
/// `*_SECRET` variables in the parent environment are stripped by
/// construction.
#[cfg(not(windows))]
pub fn sanitized_env(workspace: &Path) -> Vec<(String, String)> {
    vec![
        ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
        ("HOME".into(), workspace.to_string_lossy().into_owned()),
        (
            "TMPDIR".into(),
            std::env::temp_dir().to_string_lossy().into_owned(),
        ),
        ("LANG".into(), "en_US.UTF-8".into()),
        ("SHELL".into(), "/bin/sh".into()),
    ]
}

#[cfg(windows)]
pub fn sanitized_env(workspace: &Path) -> Vec<(String, String)> {
    let system_root =
        std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let temp = std::env::temp_dir().to_string_lossy().into_owned();
    let ws = workspace.to_string_lossy().into_owned();
    vec![
        (
            "PATH".into(),
            // OpenSSH is included for parity with the Unix PATH (where
            // /usr/bin provides ssh): bots probe/reach personal hosts from
            // session commands.
            format!(
                "{system_root}\\System32;{system_root};{system_root}\\System32\\Wbem;\
                 {system_root}\\System32\\WindowsPowerShell\\v1.0;\
                 {system_root}\\System32\\OpenSSH"
            ),
        ),
        // Winsock/DNS and most system tooling break without SystemRoot.
        ("SystemRoot".into(), system_root.clone()),
        ("ComSpec".into(), format!("{system_root}\\System32\\cmd.exe")),
        ("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into()),
        ("HOME".into(), ws.clone()),
        ("USERPROFILE".into(), ws),
        ("TEMP".into(), temp.clone()),
        ("TMP".into(), temp),
    ]
}

/// True for environment variable names that must never reach a session
/// (defense-in-depth documentation of the allowlist policy above).
/// Exercised by the sanitization tests; not needed at runtime because the
/// environment is allowlist-built, never filtered.
#[allow(dead_code)]
pub fn is_secret_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    upper.ends_with("_KEY") || upper.ends_with("_TOKEN") || upper.ends_with("_SECRET")
}

/// SIGKILL the whole process group led by `pid` (children included). Shared
/// with `mcp.rs`, whose servers are spawned into their own group too.
#[cfg(unix)]
pub(crate) fn kill_process_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        // Negative pid targets the whole process group (children included).
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

/// Kill the whole tree of processes below `pid` (children included).
/// `taskkill /T /F` is the closest Windows equivalent of a Unix
/// process-group SIGKILL.
#[cfg(windows)]
pub(crate) fn kill_process_group(pid: Option<u32>) {
    use std::os::windows::process::CommandExt as _;
    if let Some(pid) = pid {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

/// CREATE_NO_WINDOW: child processes must never flash a console window over
/// the app. Shared by every process this host spawns on Windows.
#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(not(any(unix, windows)))]
pub(crate) fn kill_process_group(_pid: Option<u32>) {}

/// Append `chunk` to `buf` while keeping the COMBINED total under
/// MAX_OUTPUT_BYTES. Returns true when the cap was hit.
fn append_capped(buf: &mut Vec<u8>, chunk: &[u8], combined_len: usize) -> bool {
    let remaining = MAX_OUTPUT_BYTES.saturating_sub(combined_len);
    if chunk.len() >= remaining {
        buf.extend_from_slice(&chunk[..remaining]);
        true
    } else {
        buf.extend_from_slice(chunk);
        false
    }
}

/// Strip the `\\?\` verbatim prefix `canonicalize` adds on Windows: cmd.exe
/// (and plenty of other tooling) refuses verbatim paths as a working
/// directory. A no-op on Unix and for UNC paths.
pub(crate) fn simplified(path: std::path::PathBuf) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy().into_owned();
        if let Some(stripped) = text.strip_prefix(r"\\?\") {
            if !stripped.starts_with("UNC") {
                return std::path::PathBuf::from(stripped);
            }
        }
    }
    path
}

/// The platform shell wrapped around a session command string.
#[cfg(not(windows))]
fn shell_command(cmd: &str) -> Command {
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(cmd);
    command
}

/// `cmd.exe /d /s /c "<cmd>"`. Raw args bypass the MSVC quoting rules that
/// would otherwise mangle the command string; `/s` makes cmd strip exactly
/// the outer quotes we add; `/d` skips AutoRun registry commands.
#[cfg(windows)]
fn shell_command(cmd: &str) -> Command {
    use std::os::windows::process::CommandExt as _;
    let comspec = std::env::var("ComSpec")
        .unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".to_string());
    let mut std_command = std::process::Command::new(comspec);
    std_command
        .raw_arg("/d")
        .raw_arg("/s")
        .raw_arg("/c")
        .raw_arg(format!("\"{cmd}\""));
    Command::from(std_command)
}

/// Execute `cmd` via the platform shell with cwd locked to `root`.
pub async fn exec_in(root: &Path, cmd: &str, timeout_ms: Option<u64>) -> Result<ExecResult, String> {
    let root = simplified(
        root.canonicalize()
            .map_err(|e| format!("workspace root is unavailable: {e}"))?,
    );
    let timeout = Duration::from_millis(effective_timeout_ms(timeout_ms));

    let mut command = shell_command(cmd);
    command.current_dir(&root).env_clear();
    for (name, value) in sanitized_env(&root) {
        command.env(name, value);
    }
    run_capped(command, timeout).await
}

/// Run an already-configured command with the shared output cap, timeout,
/// and process-group kill semantics. Used by the local session provider
/// (`exec_in`) and the personal-host SSH provider (`host.rs`).
pub async fn run_capped(mut command: Command, timeout: Duration) -> Result<ExecResult, String> {
    let started = Instant::now();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to spawn command: {e}"))?;
    let pid = child.id();
    let mut stdout = child.stdout.take().ok_or("child stdout unavailable")?;
    let mut stderr = child.stderr.take().ok_or("child stderr unavailable")?;

    let mut out_buf: Vec<u8> = Vec::new();
    let mut err_buf: Vec<u8> = Vec::new();
    let mut out_open = true;
    let mut err_open = true;
    let mut truncated = false;
    let mut timed_out = false;
    let mut out_chunk = [0u8; 8192];
    let mut err_chunk = [0u8; 8192];

    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);

    while out_open || err_open {
        tokio::select! {
            read = stdout.read(&mut out_chunk), if out_open => match read {
                Ok(0) | Err(_) => out_open = false,
                Ok(n) => {
                    let combined = out_buf.len() + err_buf.len();
                    if append_capped(&mut out_buf, &out_chunk[..n], combined) && !truncated {
                        truncated = true;
                        kill_process_group(pid);
                    }
                }
            },
            read = stderr.read(&mut err_chunk), if err_open => match read {
                Ok(0) | Err(_) => err_open = false,
                Ok(n) => {
                    let combined = out_buf.len() + err_buf.len();
                    if append_capped(&mut err_buf, &err_chunk[..n], combined) && !truncated {
                        truncated = true;
                        kill_process_group(pid);
                    }
                }
            },
            _ = &mut deadline => {
                timed_out = true;
                kill_process_group(pid);
                break;
            }
        }
    }

    // Reap the child; after SIGKILL this returns promptly. Bound it anyway.
    let exit_code = match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(Ok(status)) => status.code(),
        _ => {
            kill_process_group(pid);
            None
        }
    };

    Ok(ExecResult {
        exit_code,
        stdout: String::from_utf8_lossy(&out_buf).into_owned(),
        stderr: String::from_utf8_lossy(&err_buf).into_owned(),
        truncated,
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// Run a shell command inside the bot's local workspace (LOCAL provider).
/// This is the user's own Mac: the calling tool layer gates this behind
/// human approval (see src/lib/sessions/tools.ts).
#[tauri::command]
pub async fn session_local_exec(
    app: tauri::AppHandle,
    bot_id: String,
    cmd: String,
    timeout_ms: Option<u64>,
) -> Result<ExecResult, String> {
    let root = crate::workspace::workspace_root(&app, &bot_id)?;
    exec_in(&root, &cmd, timeout_ms).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn workspace() -> TempDir {
        TempDir::new().expect("create temp workspace")
    }

    #[test]
    fn timeout_defaults_and_clamps() {
        assert_eq!(effective_timeout_ms(None), DEFAULT_TIMEOUT_MS);
        assert_eq!(effective_timeout_ms(Some(0)), DEFAULT_TIMEOUT_MS);
        assert_eq!(effective_timeout_ms(Some(5_000)), 5_000);
        assert_eq!(effective_timeout_ms(Some(900_000)), MAX_TIMEOUT_MS);
    }

    #[test]
    fn secret_name_matcher_covers_key_token_secret() {
        assert!(is_secret_env_name("OPENROUTER_API_KEY"));
        assert!(is_secret_env_name("FLY_API_TOKEN"));
        assert!(is_secret_env_name("my_secret"));
        assert!(!is_secret_env_name("PATH"));
        assert!(!is_secret_env_name("HOME"));
    }

    #[tokio::test]
    async fn runs_a_simple_command() {
        let ws = workspace();
        let result = exec_in(ws.path(), "echo hello", None).await.unwrap();
        assert_eq!(result.exit_code, Some(0));
        // cmd.exe emits \r\n; trim before comparing.
        assert_eq!(result.stdout.trim(), "hello");
        assert_eq!(result.stderr, "");
        assert!(!result.truncated);
        assert!(!result.timed_out);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn env_is_sanitized_no_inherited_secrets() {
        // A secret-looking variable set in the app process must never be
        // visible to the session command.
        std::env::set_var("BOTS_TEST_SNEAKY_API_KEY", "super-secret");
        std::env::set_var("BOTS_TEST_SNEAKY_TOKEN", "super-secret");
        std::env::set_var("BOTS_TEST_SNEAKY_SECRET", "super-secret");
        let ws = workspace();
        let result = exec_in(ws.path(), "env", None).await.unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.stdout.contains("SNEAKY"), "leaked: {}", result.stdout);
        assert!(!result.stdout.contains("super-secret"));
        // Only the allowlist (plus vars sh itself sets, like PWD) survives.
        for line in result.stdout.lines() {
            if let Some((name, _)) = line.split_once('=') {
                assert!(!is_secret_env_name(name), "secret-like env leaked: {name}");
            }
        }
        assert!(result.stdout.contains("PATH=/usr/bin:/bin:/usr/sbin:/sbin"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn env_is_sanitized_no_inherited_secrets_windows() {
        std::env::set_var("BOTS_TEST_SNEAKY_API_KEY", "super-secret");
        std::env::set_var("BOTS_TEST_SNEAKY_TOKEN", "super-secret");
        std::env::set_var("BOTS_TEST_SNEAKY_SECRET", "super-secret");
        let ws = workspace();
        // `set` with no args lists the child's environment.
        let result = exec_in(ws.path(), "set", None).await.unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert!(!result.stdout.contains("SNEAKY"), "leaked: {}", result.stdout);
        assert!(!result.stdout.contains("super-secret"));
        for line in result.stdout.lines() {
            if let Some((name, _)) = line.split_once('=') {
                assert!(!is_secret_env_name(name), "secret-like env leaked: {name}");
            }
        }
        assert!(result.stdout.contains("System32"), "got: {}", result.stdout);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cwd_is_locked_to_the_workspace() {
        let ws = workspace();
        let canonical = ws.path().canonicalize().unwrap();
        let result = exec_in(ws.path(), "pwd && echo data > made-here.txt", None)
            .await
            .unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout.trim(), canonical.to_string_lossy());
        assert!(canonical.join("made-here.txt").is_file());
        // HOME points at the workspace too, so `~` stays inside it.
        let home = exec_in(ws.path(), "echo \"$HOME\"", None).await.unwrap();
        assert_eq!(home.stdout.trim(), canonical.to_string_lossy());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cwd_is_locked_to_the_workspace_windows() {
        let ws = workspace();
        let canonical = simplified(ws.path().canonicalize().unwrap());
        // `cd` with no args prints the working directory in cmd.exe.
        let result = exec_in(ws.path(), "cd && echo data> made-here.txt", None)
            .await
            .unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout.trim(), canonical.to_string_lossy());
        assert!(canonical.join("made-here.txt").is_file());
        // USERPROFILE points at the workspace, so `~`-style lookups stay inside.
        let home = exec_in(ws.path(), "echo %USERPROFILE%", None).await.unwrap();
        assert_eq!(home.stdout.trim(), canonical.to_string_lossy());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_is_capped_at_256kb() {
        let ws = workspace();
        // ~1 MB of 'a' characters; the cap must cut this to 256 KB.
        let result = exec_in(
            ws.path(),
            "head -c 1048576 /dev/zero | tr '\\0' 'a'",
            Some(30_000),
        )
        .await
        .unwrap();
        assert!(result.truncated);
        assert!(result.stdout.len() + result.stderr.len() <= MAX_OUTPUT_BYTES);
        assert_eq!(result.stdout.len(), MAX_OUTPUT_BYTES);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn output_is_capped_at_256kb_windows() {
        let ws = workspace();
        // ~1 MB of 'a' characters via PowerShell; the cap must cut this off.
        let result = exec_in(
            ws.path(),
            "powershell -NoProfile -Command \"'a' * 1048576\"",
            Some(60_000),
        )
        .await
        .unwrap();
        assert!(result.truncated);
        assert!(result.stdout.len() + result.stderr.len() <= MAX_OUTPUT_BYTES);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_the_whole_process_group() {
        let ws = workspace();
        // Background child would write a marker 2s in; the foreground sleeps
        // longer than the timeout. The group kill must take both down.
        let started = Instant::now();
        let result = exec_in(
            ws.path(),
            "( sleep 2; echo late > marker.txt ) & sleep 60",
            Some(500),
        )
        .await
        .unwrap();
        assert!(result.timed_out);
        assert!(result.exit_code.is_none(), "killed by signal, no exit code");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "did not return promptly"
        );
        // Give the (dead) background child's would-be write time to happen.
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(
            !ws.path().join("marker.txt").exists(),
            "background child survived the group kill"
        );
    }

    /// Windows counterpart: `taskkill /T` must take the whole tree down,
    /// including the `start /b` background child. `ping -n` is the portable
    /// cmd.exe sleep (`timeout` refuses redirected stdin).
    #[cfg(windows)]
    #[tokio::test]
    async fn timeout_kills_the_whole_process_tree_windows() {
        let ws = workspace();
        let started = Instant::now();
        let result = exec_in(
            ws.path(),
            "start /b cmd /c \"ping -n 4 127.0.0.1 >nul & echo late> marker.txt\" & ping -n 61 127.0.0.1 >nul",
            Some(500),
        )
        .await
        .unwrap();
        assert!(result.timed_out);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "did not return promptly"
        );
        // Give the (dead) background child's would-be write time to happen.
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(
            !ws.path().join("marker.txt").exists(),
            "background child survived the tree kill"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn nonzero_exit_codes_are_reported() {
        let ws = workspace();
        let result = exec_in(ws.path(), "echo oops >&2; exit 3", None).await.unwrap();
        assert_eq!(result.exit_code, Some(3));
        assert_eq!(result.stderr, "oops\n");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn nonzero_exit_codes_are_reported_windows() {
        let ws = workspace();
        let result = exec_in(ws.path(), "echo oops>&2 & exit 3", None).await.unwrap();
        assert_eq!(result.exit_code, Some(3));
        assert_eq!(result.stderr.trim(), "oops");
    }
}
