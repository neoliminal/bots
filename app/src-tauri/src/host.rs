//! Personal-host session transport (`host_exec`).
//!
//! Spec: openspec/specs/agent-computer/spec.md (Personal host sessions).
//! One command: run a shell command on the user's own machine over SSH.
//!
//! Guards:
//! - The target is strictly validated as `user@host` with a conservative
//!   charset and no leading `-` in either part, so it can never be parsed
//!   as an ssh option (no option injection). `--` terminates option
//!   parsing anyway — defense in depth.
//! - The target is PINNED: `host_exec` only ever talks to the one target the
//!   user configured via `host_set_target`. Charset validation alone would
//!   still let a caller reach `root@192.168.1.1` or `x@169.254.169.254`;
//!   with the pin, any other target is refused before ssh is spawned.
//! - `BatchMode=yes`: ssh never prompts; missing/locked keys fail fast
//!   with a clear error instead of hanging a session tool.
//! - The ssh process gets a minimal environment plus the user's HOME and
//!   SSH_AUTH_SOCK (ssh needs key material and known_hosts) — no app
//!   secrets. The REMOTE command's environment is whatever the remote
//!   shell provides; nothing from the app crosses the wire.
//! - Output cap / timeout / process-group kill are shared with the local
//!   provider via `session::run_capped`.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::process::Command;

use crate::session::{effective_timeout_ms, run_capped, ExecResult};

/// The one ssh target `host_exec` is allowed to reach, set from Settings via
/// `host_set_target`. `None` until the user configures a personal host.
fn pinned_target() -> &'static Mutex<Option<String>> {
    static PINNED: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    PINNED.get_or_init(|| Mutex::new(None))
}

/// True when `part` is non-empty, does not start with `-`, and uses only
/// the allowed charset. `extra` widens the charset beyond alphanumerics.
fn valid_part(part: &str, extra: &[char]) -> bool {
    !part.is_empty()
        && !part.starts_with('-')
        && part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
}

/// Validate an ssh target of the form `user@host` (host may be a DNS name
/// or IPv4 literal). Deliberately conservative: no ports, no IPv6, no `%`.
pub fn valid_target(target: &str) -> bool {
    match target.split_once('@') {
        Some((user, host)) => {
            valid_part(user, &['.', '_', '-']) && valid_part(host, &['.', '-'])
        }
        None => false,
    }
}

/// Pin the personal-host ssh target. Called from Settings when the user
/// saves (or tests) their host; every later `host_exec` must match it
/// exactly. Passing an empty string clears the pin, disabling `host_exec`.
#[tauri::command]
pub fn host_set_target(target: String) -> Result<(), String> {
    let trimmed = target.trim();
    let mut pinned = pinned_target()
        .lock()
        .map_err(|_| "host target state is poisoned".to_string())?;
    if trimmed.is_empty() {
        *pinned = None;
        return Ok(());
    }
    if !valid_target(trimmed) {
        return Err("invalid ssh target (expected user@host)".into());
    }
    *pinned = Some(trimmed.to_string());
    Ok(())
}

/// Refuse any target that is not the pinned one.
fn check_pinned(target: &str) -> Result<(), String> {
    let pinned = pinned_target()
        .lock()
        .map_err(|_| "host target state is poisoned".to_string())?;
    match pinned.as_deref() {
        None => Err(
            "no personal host is configured: set the host target in Settings first".into(),
        ),
        Some(allowed) if allowed == target => Ok(()),
        Some(_) => Err(
            "ssh target does not match the personal host configured in Settings; \
             change it there first"
                .into(),
        ),
    }
}

/// Run `cmd` on the personal host over SSH. The remote working directory is
/// whatever the remote shell defaults to (the TS provider prefixes an
/// explicit `cd`), so this command is pure transport.
#[tauri::command]
pub async fn host_exec(
    target: String,
    cmd: String,
    timeout_ms: Option<u64>,
) -> Result<ExecResult, String> {
    if !valid_target(&target) {
        return Err("invalid ssh target (expected user@host)".into());
    }
    check_pinned(&target)?;
    let timeout = Duration::from_millis(effective_timeout_ms(timeout_ms));

    let mut command = Command::new(ssh_program());
    command
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("--")
        .arg(&target)
        .arg(&cmd);
    command.env_clear();
    for (name, value) in ssh_env() {
        command.env(name, value);
    }
    run_capped(command, timeout).await
}

/// The ssh client binary. On Windows the bundled OpenSSH client lives in
/// System32\OpenSSH; use it by absolute path when present (a bare "ssh"
/// resolves through the parent's PATH, which may point at a different port).
#[cfg(windows)]
fn ssh_program() -> std::path::PathBuf {
    let system_root =
        std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let bundled = std::path::Path::new(&system_root)
        .join("System32")
        .join("OpenSSH")
        .join("ssh.exe");
    if bundled.is_file() {
        bundled
    } else {
        std::path::PathBuf::from("ssh")
    }
}

#[cfg(not(windows))]
fn ssh_program() -> std::path::PathBuf {
    std::path::PathBuf::from("ssh")
}

/// Minimal environment for the ssh client: fixed PATH plus what ssh needs to
/// find key material and known_hosts — no app secrets.
fn ssh_env() -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();
    #[cfg(not(windows))]
    env.push(("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()));
    #[cfg(windows)]
    {
        let system_root =
            std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        env.push((
            "PATH".into(),
            format!("{system_root}\\System32\\OpenSSH;{system_root}\\System32;{system_root}"),
        ));
        // Winsock/DNS need SystemRoot; ssh resolves ~/.ssh via USERPROFILE.
        env.push(("SystemRoot".into(), system_root));
        if let Ok(profile) = std::env::var("USERPROFILE") {
            env.push(("USERPROFILE".into(), profile));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        env.push(("HOME".into(), home));
    }
    if let Ok(sock) = std::env::var("SSH_AUTH_SOCK") {
        env.push(("SSH_AUTH_SOCK".into(), sock));
    }
    env
}

/// Parse `dns-sd -B _ssh._tcp` browse output into candidate hostnames
/// (`<instance>.local`, lowercased, spaces removed — a best-effort guess the
/// UI treats as an editable suggestion, verified by Save & test).
pub fn parse_dns_sd_browse(output: &str) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for line in output.lines() {
        // Browse lines: "<time>  Add  <flags>  <if>  <domain>  <type>  <instance>"
        let mut parts = line.split_whitespace();
        let _time = parts.next();
        if parts.next() != Some("Add") {
            continue;
        }
        let _flags = parts.next();
        let _ifidx = parts.next();
        let _domain = parts.next();
        let _stype = parts.next();
        let instance: Vec<&str> = parts.collect();
        if instance.is_empty() {
            continue;
        }
        let host = format!("{}.local", instance.join("").to_ascii_lowercase());
        if !hosts.contains(&host) {
            hosts.push(host);
        }
    }
    hosts
}

/// Discover SSH services on the local network via a bounded mDNS browse
/// (user-initiated from Settings — never a background probe; spec:
/// "Personal host discovery"). Returns best-effort `<host>.local` candidates.
#[tauri::command]
pub async fn host_discover() -> Result<Vec<String>, String> {
    let mut command = Command::new("dns-sd");
    command.arg("-B").arg("_ssh._tcp").arg("local.");
    command.env_clear();
    #[cfg(not(windows))]
    command.env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    #[cfg(windows)]
    {
        // dns-sd.exe exists only where Bonjour is installed; the fixed PATH
        // covers the standard install locations.
        let system_root =
            std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let program_files =
            std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
        command.env(
            "PATH",
            format!("{system_root}\\System32;{program_files}\\Bonjour"),
        );
        if let Ok(sr) = std::env::var("SystemRoot") {
            command.env("SystemRoot", sr);
        }
    }
    // dns-sd browses forever; give it a short window and kill it.
    // Discovery is a best-effort suggestion: a machine without dns-sd
    // (e.g. Windows without Bonjour) simply yields no candidates.
    match run_capped(command, Duration::from_millis(2_500)).await {
        Ok(result) => Ok(parse_dns_sd_browse(&result.stdout)),
        Err(_) => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_browse_output_into_local_hostnames() {
        let output = "\
Browsing for _ssh._tcp\n\
DATE: ---Fri 15 Aug 2026---\n\
20:41:55.862  ...STARTING...\n\
Timestamp     A/R    Flags  if Domain               Service Type         Instance Name\n\
20:41:55.863  Add        3   6 local.               _ssh._tcp.           NucBox G3\n\
20:41:55.863  Add        2   6 local.               _ssh._tcp.           studio\n\
20:41:56.001  Rmv        2   6 local.               _ssh._tcp.           gone-host\n\
20:41:55.863  Add        3   6 local.               _ssh._tcp.           NucBox G3\n";
        assert_eq!(
            parse_dns_sd_browse(output),
            vec!["nucboxg3.local".to_string(), "studio.local".to_string()]
        );
    }

    #[test]
    fn empty_or_garbage_output_yields_no_candidates() {
        assert!(parse_dns_sd_browse("").is_empty());
        assert!(parse_dns_sd_browse("no services found\nrandom noise").is_empty());
    }

    #[test]
    fn accepts_plain_user_at_host_targets() {
        assert!(valid_target("john@minipc.local"));
        assert!(valid_target("bots@192.168.1.40"));
        assert!(valid_target("a_b-c.d@host-name.example.com"));
    }

    #[test]
    fn rejects_malformed_or_injectable_targets() {
        assert!(!valid_target("minipc.local")); // no user
        assert!(!valid_target("@host"));
        assert!(!valid_target("user@"));
        assert!(!valid_target("-oProxyCommand=evil@host")); // option injection
        assert!(!valid_target("user@-evil"));
        assert!(!valid_target("user@host port")); // whitespace
        assert!(!valid_target("user@host;rm -rf /")); // shell metachars
        assert!(!valid_target("user@[::1]")); // IPv6 not supported in v1
        assert!(!valid_target("user@host:22")); // no ports
    }

    #[tokio::test]
    async fn invalid_target_is_rejected_before_any_spawn() {
        let result = host_exec("evil;true".into(), "echo hi".into(), None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid ssh target"));
    }

    /// M1: charset validation alone let a caller ssh anywhere. Only the
    /// target pinned from Settings is reachable now. One test drives the
    /// whole sequence because the pin is process-global state.
    #[tokio::test]
    async fn host_exec_only_reaches_the_pinned_target() {
        // Unpinned: even a perfectly well-formed target is refused.
        host_set_target(String::new()).unwrap();
        let err = host_exec("bots@nucbox.local".into(), "id".into(), None)
            .await
            .unwrap_err();
        assert!(err.contains("Settings"), "got: {err}");

        // Pinned: a DIFFERENT well-formed target is refused (no spawn).
        host_set_target("bots@nucbox.local".into()).unwrap();
        for target in [
            "root@192.168.1.1",
            "x@127.0.0.1",
            "x@169.254.169.254",
            "root@nucbox.local",     // same host, different user
            "bots@nucbox.local.evil", // suffix trick
        ] {
            let err = host_exec(target.into(), "id".into(), None)
                .await
                .unwrap_err();
            assert!(
                err.contains("does not match"),
                "{target} should be refused, got: {err}"
            );
        }

        // The pinned target itself passes the gate (checked without spawning
        // ssh: `check_pinned` is the whole guard).
        assert!(check_pinned("bots@nucbox.local").is_ok());

        // Setting the pin validates the same way, and "" clears it.
        assert!(host_set_target("-oProxyCommand=evil@host".into()).is_err());
        assert!(host_set_target("nouser".into()).is_err());
        assert!(host_set_target("  bots@nucbox.local  ".into()).is_ok());
        assert!(check_pinned("bots@nucbox.local").is_ok(), "trimmed on set");
        host_set_target(String::new()).unwrap();
        assert!(check_pinned("bots@nucbox.local").is_err());
    }
}
