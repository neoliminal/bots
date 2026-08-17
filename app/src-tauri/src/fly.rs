//! Fly Machines compute-session provider (`fly_*` commands).
//!
//! Spec: openspec/specs/agent-computer/spec.md — on-demand remote sessions
//! against the Fly Machines REST API (https://api.machines.dev/v1).
//!
//! Security posture:
//! - `FLY_API_TOKEN` is read from `keys/.env` via the same parser as
//!   `get_dev_api_key` and used exclusively on the Rust side; it is NEVER
//!   returned to the webview by any command.
//! - Session machines carry no secrets: the image is a stock Debian and the
//!   config injects no env (see `machine_config`), satisfying "no secrets in
//!   images".
//! - File paths are validated with the same workspace rules as local files
//!   and are rooted at `/workspace` inside the machine.
//!
//! With no token configured, `fly_status` reports `"unconfigured"` cleanly;
//! every other `fly_*` command errors with a clear message.
//!
//! File transfer runs over the exec endpoint as base64 chunks (`stat`/`tail`/
//! `head`/`base64` for reads, `printf | base64 -d | tee` for writes), so no
//! extra agent is needed inside the machine.
//!
//! The HTTP layer is factored behind the `FlyHttp` trait so unit tests run
//! against a canned fake with no live network.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Base URL of the Fly Machines REST API.
pub const FLY_API_BASE: &str = "https://api.machines.dev/v1";
/// Default Fly app that hosts session machines (override: FLY_APP_NAME in keys/.env).
pub const DEFAULT_APP_NAME: &str = "bots-sessions";
/// Machine name prefix; one machine per bot: `bots-session-<bot_id>`.
pub const MACHINE_NAME_PREFIX: &str = "bots-session-";
/// Root directory for session files inside the machine.
pub const WORKSPACE_DIR: &str = "/workspace";
/// Raw bytes per base64 transfer chunk (reads and writes).
pub const CHUNK_BYTES: usize = 48 * 1024;
/// Same per-file cap as the local workspace.
pub const MAX_FILE_BYTES: u64 = crate::workspace::MAX_FILE_BYTES;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlyProvisionResult {
    /// The Fly machine id — used as the session id by the TS layer.
    pub session_id: String,
    pub state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlyExecResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlyStatusResult {
    /// "unconfigured" | "ready" | "provisioning" | "running" | "stopped" | "destroyed" | raw state
    pub state: String,
}

/// Minimal HTTP abstraction so tests can fake the Machines API.
/// `path` is relative to the API base (e.g. `/apps/x/machines`).
pub trait FlyHttp: Send + Sync {
    fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> impl Future<Output = Result<(u16, Value), String>> + Send;
}

/// Real HTTP layer: reqwest with bearer auth against `api.machines.dev`.
pub struct ReqwestHttp {
    base: String,
    token: String,
    client: reqwest::Client,
}

impl ReqwestHttp {
    pub fn new(base: &str, token: String) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| format!("failed to build HTTP client: {e}"))?;
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            token,
            client,
        })
    }
}

impl FlyHttp for ReqwestHttp {
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), String> {
        let url = format!("{}{}", self.base, path);
        let builder = match method {
            "GET" => self.client.get(&url),
            "POST" => self.client.post(&url),
            "DELETE" => self.client.delete(&url),
            other => return Err(format!("unsupported HTTP method: {other}")),
        };
        let mut builder = builder.bearer_auth(&self.token);
        if let Some(body) = body {
            builder = builder.json(&body);
        }
        let resp = builder
            .send()
            .await
            .map_err(|e| format!("Fly API request failed: {e}"))?;
        let status = resp.status().as_u16();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("failed to read Fly API response: {e}"))?;
        let value = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        Ok((status, value))
    }
}

/// Quote a string for safe interpolation into `/bin/sh -c`.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Machine ids appear in URL paths; restrict to safe characters.
pub fn validate_machine_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("invalid session id".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Machine ownership (M2)
// ---------------------------------------------------------------------------
//
// Charset validation says nothing about WHOSE machine an id refers to: with
// only that guard, bot A could exec inside bot B's machine, or destroy any
// machine in the Fly app. Every machine this host provisions is recorded
// against the bot that provisioned it, and every later `fly_*` call must name
// the same bot. Ids this host never provisioned are refused outright.

fn machine_owners() -> &'static Mutex<HashMap<String, String>> {
    static OWNERS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    OWNERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record `machine_id` as belonging to `bot_id` (called after provisioning).
pub fn record_machine_owner(bot_id: &str, machine_id: &str) -> Result<(), String> {
    crate::workspace::validate_bot_id(bot_id)?;
    validate_machine_id(machine_id)?;
    let mut owners = machine_owners()
        .lock()
        .map_err(|_| "session ownership state is poisoned".to_string())?;
    owners.insert(machine_id.to_string(), bot_id.to_string());
    Ok(())
}

/// Refuse unless `machine_id` was provisioned by `bot_id` in this session.
pub fn require_machine_owner(bot_id: &str, machine_id: &str) -> Result<(), String> {
    crate::workspace::validate_bot_id(bot_id)?;
    validate_machine_id(machine_id)?;
    let owners = machine_owners()
        .lock()
        .map_err(|_| "session ownership state is poisoned".to_string())?;
    match owners.get(machine_id) {
        None => Err(
            "unknown session id: this machine was not provisioned by this app run — \
             provision the session again"
                .into(),
        ),
        Some(owner) if owner == bot_id => Ok(()),
        Some(_) => Err("session id belongs to a different bot".into()),
    }
}

/// Forget a machine's owner (after a destroy).
fn forget_machine_owner(machine_id: &str) {
    if let Ok(mut owners) = machine_owners().lock() {
        owners.remove(machine_id);
    }
}

/// Machine config: smallest shared-CPU guest, stock image, an init that just
/// prepares /workspace and idles. Deliberately NO `env` block — session
/// images/disks must contain no credential material (agent-computer spec).
fn machine_config() -> Value {
    json!({
        "image": "debian:bookworm-slim",
        "guest": { "cpu_kind": "shared", "cpus": 1, "memory_mb": 256 },
        "auto_destroy": false,
        "init": {
            "exec": ["/bin/sh", "-c", "mkdir -p /workspace && exec sleep infinity"]
        }
    })
}

/// Map a Fly machine state onto the session-status vocabulary.
pub fn map_state(state: &str) -> String {
    match state {
        "created" | "starting" | "replacing" => "provisioning".into(),
        "started" => "running".into(),
        "stopping" | "stopped" | "suspending" | "suspended" => "stopped".into(),
        "destroying" | "destroyed" => "destroyed".into(),
        other => other.to_string(),
    }
}

fn ensure_ok(status: u16, body: &Value, context: &str) -> Result<(), String> {
    if (200..300).contains(&status) {
        return Ok(());
    }
    let detail = body
        .get("error")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| body.to_string());
    Err(format!("Fly API {context} failed (HTTP {status}): {detail}"))
}

/// Provider client, generic over the HTTP layer for testability.
pub struct FlyClient<H: FlyHttp> {
    pub http: H,
    pub app: String,
}

impl<H: FlyHttp> FlyClient<H> {
    fn machines_path(&self) -> String {
        format!("/apps/{}/machines", self.app)
    }

    async fn wait_started(&self, machine_id: &str) -> Result<(), String> {
        let path = format!(
            "{}/{}/wait?state=started&timeout=60",
            self.machines_path(),
            machine_id
        );
        let (status, body) = self.http.request("GET", &path, None).await?;
        ensure_ok(status, &body, "wait for machine start")
    }

    /// Find-or-create the bot's session machine and ensure it is started.
    /// Reuses a stopped machine (warm restart) when one exists.
    pub async fn provision(&self, bot_id: &str) -> Result<FlyProvisionResult, String> {
        crate::workspace::validate_bot_id(bot_id)?;
        let name = format!("{MACHINE_NAME_PREFIX}{bot_id}");
        let (status, list) = self.http.request("GET", &self.machines_path(), None).await?;
        ensure_ok(status, &list, "list machines")?;
        let existing = list
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| m.get("name").and_then(Value::as_str) == Some(name.as_str()))
            .cloned();

        if let Some(machine) = existing {
            let id = machine
                .get("id")
                .and_then(Value::as_str)
                .ok_or("Fly API returned a machine without an id")?
                .to_string();
            let state = machine.get("state").and_then(Value::as_str).unwrap_or("");
            if state != "started" {
                let (s, b) = self
                    .http
                    .request(
                        "POST",
                        &format!("{}/{}/start", self.machines_path(), id),
                        None,
                    )
                    .await?;
                ensure_ok(s, &b, "start machine")?;
                self.wait_started(&id).await?;
            }
            return Ok(FlyProvisionResult {
                session_id: id,
                state: "running".into(),
            });
        }

        let body = json!({ "name": name, "config": machine_config() });
        let (s, created) = self
            .http
            .request("POST", &self.machines_path(), Some(body))
            .await?;
        ensure_ok(s, &created, "create machine")?;
        let id = created
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Fly API create response missing machine id")?
            .to_string();
        self.wait_started(&id).await?;
        Ok(FlyProvisionResult {
            session_id: id,
            state: "running".into(),
        })
    }

    /// Run a shell command in the machine, cwd `/workspace`.
    pub async fn exec(
        &self,
        machine_id: &str,
        cmd: &str,
        timeout_ms: Option<u64>,
    ) -> Result<FlyExecResult, String> {
        validate_machine_id(machine_id)?;
        let timeout_secs = (timeout_ms.unwrap_or(30_000) / 1000).clamp(1, 300);
        let wrapped = format!("cd {WORKSPACE_DIR} 2>/dev/null || mkdir -p {WORKSPACE_DIR}; cd {WORKSPACE_DIR}; {cmd}");
        let body = json!({
            "cmd": ["/bin/sh", "-c", wrapped],
            "timeout": timeout_secs
        });
        let path = format!("{}/{}/exec", self.machines_path(), machine_id);
        let (status, resp) = self.http.request("POST", &path, Some(body)).await?;
        ensure_ok(status, &resp, "exec")?;
        Ok(FlyExecResult {
            exit_code: resp
                .get("exit_code")
                .and_then(Value::as_i64)
                .map(|c| c as i32),
            stdout: resp
                .get("stdout")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            stderr: resp
                .get("stderr")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        })
    }

    /// Read a workspace file out of the machine via base64 chunks.
    pub async fn read_file(&self, machine_id: &str, rel_path: &str) -> Result<String, String> {
        crate::workspace::validate_rel_path(rel_path)?;
        let quoted = shell_quote(&format!("{WORKSPACE_DIR}/{rel_path}"));
        let size_probe = self
            .exec(machine_id, &format!("stat -c %s {quoted}"), None)
            .await?;
        if size_probe.exit_code != Some(0) {
            return Err(format!(
                "cannot read {rel_path}: {}",
                size_probe.stderr.trim()
            ));
        }
        let size: u64 = size_probe
            .stdout
            .trim()
            .parse()
            .map_err(|_| format!("unexpected stat output for {rel_path}"))?;
        if size > MAX_FILE_BYTES {
            return Err(format!("file exceeds the 5MB limit: {rel_path}"));
        }
        let mut data: Vec<u8> = Vec::with_capacity(size as usize);
        let mut offset: u64 = 0;
        while offset < size {
            let cmd = format!(
                "tail -c +{} {quoted} | head -c {} | base64",
                offset + 1,
                CHUNK_BYTES
            );
            let chunk_res = self.exec(machine_id, &cmd, None).await?;
            if chunk_res.exit_code != Some(0) {
                return Err(format!(
                    "cannot read {rel_path}: {}",
                    chunk_res.stderr.trim()
                ));
            }
            let cleaned: String = chunk_res
                .stdout
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            let chunk = B64
                .decode(cleaned.as_bytes())
                .map_err(|e| format!("invalid base64 while reading {rel_path}: {e}"))?;
            if chunk.is_empty() {
                break; // file shrank underneath us; return what we have
            }
            offset += chunk.len() as u64;
            data.extend_from_slice(&chunk);
        }
        String::from_utf8(data).map_err(|_| format!("file is not valid UTF-8: {rel_path}"))
    }

    /// Write a workspace file into the machine via base64 chunks + tee.
    pub async fn write_file(
        &self,
        machine_id: &str,
        rel_path: &str,
        content: &str,
    ) -> Result<(), String> {
        crate::workspace::validate_rel_path(rel_path)?;
        if content.len() as u64 > MAX_FILE_BYTES {
            return Err("content exceeds the 5MB limit".into());
        }
        let full = format!("{WORKSPACE_DIR}/{rel_path}");
        let quoted = shell_quote(&full);
        let dir = full.rsplit_once('/').map(|(d, _)| d).unwrap_or(WORKSPACE_DIR);
        let quoted_dir = shell_quote(dir);
        let bytes = content.as_bytes();
        let mut offset = 0usize;
        let mut first = true;
        loop {
            let end = (offset + CHUNK_BYTES).min(bytes.len());
            let encoded = B64.encode(&bytes[offset..end]);
            let cmd = if first {
                format!(
                    "mkdir -p {quoted_dir} && printf %s {encoded} | base64 -d | tee {quoted} >/dev/null"
                )
            } else {
                format!("printf %s {encoded} | base64 -d | tee -a {quoted} >/dev/null")
            };
            let res = self.exec(machine_id, &cmd, None).await?;
            if res.exit_code != Some(0) {
                return Err(format!("cannot write {rel_path}: {}", res.stderr.trim()));
            }
            first = false;
            offset = end;
            if offset >= bytes.len() {
                break;
            }
        }
        Ok(())
    }

    /// Stop the machine; optionally destroy it (ephemeral teardown).
    pub async fn stop(&self, machine_id: &str, destroy: bool) -> Result<(), String> {
        validate_machine_id(machine_id)?;
        let (status, body) = self
            .http
            .request(
                "POST",
                &format!("{}/{}/stop", self.machines_path(), machine_id),
                None,
            )
            .await?;
        ensure_ok(status, &body, "stop machine")?;
        if destroy {
            let (status, body) = self
                .http
                .request(
                    "DELETE",
                    &format!("{}/{}?force=true", self.machines_path(), machine_id),
                    None,
                )
                .await?;
            ensure_ok(status, &body, "destroy machine")?;
        }
        Ok(())
    }

    /// Current machine state, mapped to session-status vocabulary.
    pub async fn machine_state(&self, machine_id: &str) -> Result<String, String> {
        validate_machine_id(machine_id)?;
        let (status, body) = self
            .http
            .request(
                "GET",
                &format!("{}/{}", self.machines_path(), machine_id),
                None,
            )
            .await?;
        ensure_ok(status, &body, "get machine")?;
        Ok(map_state(
            body.get("state").and_then(Value::as_str).unwrap_or("unknown"),
        ))
    }
}

// ---------------------------------------------------------------------------
// Token plumbing + tauri commands
// ---------------------------------------------------------------------------

/// The FLY_API_TOKEN from keys/.env. Rust-side use only — never IPC'd.
fn fly_token() -> Option<String> {
    crate::read_keys_env_entry("FLY_API_TOKEN")
}

fn fly_app_name() -> String {
    crate::read_keys_env_entry("FLY_APP_NAME").unwrap_or_else(|| DEFAULT_APP_NAME.to_string())
}

/// Clear, actionable error for every fly_* command except fly_status.
pub fn missing_token_error() -> String {
    "Fly compute sessions are not configured: add FLY_API_TOKEN to keys/.env \
     (and optionally FLY_APP_NAME) to enable them."
        .to_string()
}

fn client() -> Result<FlyClient<ReqwestHttp>, String> {
    let token = fly_token().ok_or_else(missing_token_error)?;
    Ok(FlyClient {
        http: ReqwestHttp::new(FLY_API_BASE, token)?,
        app: fly_app_name(),
    })
}

/// Provision (find/create/start) the bot's Fly session machine, and record
/// the resulting machine as belonging to this bot: every other `fly_*`
/// command must name the same bot for that machine id.
#[tauri::command]
pub async fn fly_provision(bot_id: String) -> Result<FlyProvisionResult, String> {
    let result = client()?.provision(&bot_id).await?;
    record_machine_owner(&bot_id, &result.session_id)?;
    Ok(result)
}

/// Run a shell command in the session machine (cwd /workspace).
#[tauri::command]
pub async fn fly_exec(
    bot_id: String,
    session_id: String,
    cmd: String,
    timeout_ms: Option<u64>,
) -> Result<FlyExecResult, String> {
    require_machine_owner(&bot_id, &session_id)?;
    client()?.exec(&session_id, &cmd, timeout_ms).await
}

/// Read a session workspace file (UTF-8, max 5MB).
#[tauri::command]
pub async fn fly_read_file(
    bot_id: String,
    session_id: String,
    rel_path: String,
) -> Result<String, String> {
    require_machine_owner(&bot_id, &session_id)?;
    client()?.read_file(&session_id, &rel_path).await
}

/// Write a session workspace file (UTF-8, max 5MB), creating parent dirs.
#[tauri::command]
pub async fn fly_write_file(
    bot_id: String,
    session_id: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    require_machine_owner(&bot_id, &session_id)?;
    client()?.write_file(&session_id, &rel_path, &content).await
}

/// Stop the session machine. `destroy: true` also deletes it (default false:
/// the stopped image is retained for warm restarts, per agent-computer spec).
#[tauri::command]
pub async fn fly_stop(
    bot_id: String,
    session_id: String,
    destroy: Option<bool>,
) -> Result<(), String> {
    require_machine_owner(&bot_id, &session_id)?;
    let destroy = destroy.unwrap_or(false);
    client()?.stop(&session_id, destroy).await?;
    if destroy {
        forget_machine_owner(&session_id);
    }
    Ok(())
}

/// Provider/machine status. With no token this cleanly reports
/// "unconfigured" (never an error); with a token and no session id it
/// reports "ready"; with a session id it reports the machine's state.
/// `bot_id` is required whenever a session id is given — it must own it.
#[tauri::command]
pub async fn fly_status(
    bot_id: Option<String>,
    session_id: Option<String>,
) -> Result<FlyStatusResult, String> {
    if fly_token().is_none() {
        return Ok(FlyStatusResult {
            state: "unconfigured".into(),
        });
    }
    match session_id {
        None => Ok(FlyStatusResult {
            state: "ready".into(),
        }),
        Some(id) => {
            let bot_id = bot_id
                .ok_or_else(|| "botId is required when a sessionId is given".to_string())?;
            require_machine_owner(&bot_id, &id)?;
            Ok(FlyStatusResult {
                state: client()?.machine_state(&id).await?,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Canned-response fake for the Machines API; records every request.
    struct FakeHttp {
        responses: Mutex<Vec<(u16, Value)>>,
        calls: Mutex<Vec<(String, String, Option<Value>)>>,
    }

    impl FakeHttp {
        fn new(responses: Vec<(u16, Value)>) -> Self {
            Self {
                responses: Mutex::new(responses),
                calls: Mutex::new(Vec::new()),
            }
        }
        fn calls(&self) -> Vec<(String, String, Option<Value>)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl FlyHttp for FakeHttp {
        async fn request(
            &self,
            method: &str,
            path: &str,
            body: Option<Value>,
        ) -> Result<(u16, Value), String> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), path.to_string(), body));
            let mut responses = self.responses.lock().unwrap();
            if responses.is_empty() {
                return Err("FakeHttp: no more canned responses".into());
            }
            Ok(responses.remove(0))
        }
    }

    fn client_with(responses: Vec<(u16, Value)>) -> FlyClient<FakeHttp> {
        FlyClient {
            http: FakeHttp::new(responses),
            app: "test-app".into(),
        }
    }

    fn exec_ok(stdout: &str) -> (u16, Value) {
        (
            200,
            json!({ "exit_code": 0, "stdout": stdout, "stderr": "" }),
        )
    }

    #[tokio::test]
    async fn provision_creates_a_machine_when_none_exists() {
        let client = client_with(vec![
            (200, json!([])),                                  // list
            (200, json!({ "id": "m-123", "state": "created" })), // create
            (200, json!({})),                                  // wait started
        ]);
        let result = client.provision("bot-1").await.unwrap();
        assert_eq!(result.session_id, "m-123");
        assert_eq!(result.state, "running");
        let calls = client.http.calls();
        assert_eq!(calls[0].0, "GET");
        assert_eq!(calls[0].1, "/apps/test-app/machines");
        assert_eq!(calls[1].0, "POST");
        assert_eq!(calls[1].1, "/apps/test-app/machines");
        let body = calls[1].2.as_ref().unwrap();
        assert_eq!(body["name"], "bots-session-bot-1");
        assert_eq!(body["config"]["guest"]["cpu_kind"], "shared");
        assert_eq!(body["config"]["guest"]["cpus"], 1);
        // No secrets baked into the machine config.
        assert!(body["config"].get("env").is_none());
        assert!(calls[2].1.contains("/machines/m-123/wait?state=started"));
    }

    #[tokio::test]
    async fn provision_starts_an_existing_stopped_machine() {
        let client = client_with(vec![
            (
                200,
                json!([{ "id": "m-9", "name": "bots-session-bot-1", "state": "stopped" }]),
            ),
            (200, json!({})), // start
            (200, json!({})), // wait
        ]);
        let result = client.provision("bot-1").await.unwrap();
        assert_eq!(result.session_id, "m-9");
        let calls = client.http.calls();
        assert_eq!(calls[1].0, "POST");
        assert_eq!(calls[1].1, "/apps/test-app/machines/m-9/start");
    }

    #[tokio::test]
    async fn provision_reuses_a_started_machine_without_restarting() {
        let client = client_with(vec![(
            200,
            json!([{ "id": "m-9", "name": "bots-session-bot-1", "state": "started" }]),
        )]);
        let result = client.provision("bot-1").await.unwrap();
        assert_eq!(result.session_id, "m-9");
        assert_eq!(client.http.calls().len(), 1, "no start/create calls");
    }

    #[tokio::test]
    async fn provision_rejects_invalid_bot_ids() {
        let client = client_with(vec![]);
        assert!(client.provision("../evil").await.is_err());
        assert!(client.http.calls().is_empty());
    }

    #[tokio::test]
    async fn exec_wraps_command_with_workspace_cwd() {
        let client = client_with(vec![(
            200,
            json!({ "exit_code": 2, "stdout": "out", "stderr": "err" }),
        )]);
        let result = client.exec("m-1", "ls -la", Some(45_000)).await.unwrap();
        assert_eq!(result.exit_code, Some(2));
        assert_eq!(result.stdout, "out");
        assert_eq!(result.stderr, "err");
        let calls = client.http.calls();
        assert_eq!(calls[0].1, "/apps/test-app/machines/m-1/exec");
        let body = calls[0].2.as_ref().unwrap();
        assert_eq!(body["timeout"], 45);
        let cmd = body["cmd"].as_array().unwrap();
        assert_eq!(cmd[0], "/bin/sh");
        assert_eq!(cmd[1], "-c");
        let script = cmd[2].as_str().unwrap();
        assert!(script.contains("cd /workspace"));
        assert!(script.ends_with("ls -la"));
    }

    #[tokio::test]
    async fn exec_surfaces_api_errors() {
        let client = client_with(vec![(404, json!({ "error": "machine not found" }))]);
        let err = client.exec("m-1", "true", None).await.unwrap_err();
        assert!(err.contains("HTTP 404"));
        assert!(err.contains("machine not found"));
    }

    #[tokio::test]
    async fn exec_rejects_invalid_machine_ids() {
        let client = client_with(vec![]);
        assert!(client.exec("m/../x", "true", None).await.is_err());
        assert!(client.exec("", "true", None).await.is_err());
    }

    #[tokio::test]
    async fn read_file_decodes_base64_chunks() {
        let content = "hello fly session";
        let b64 = B64.encode(content.as_bytes());
        let client = client_with(vec![
            exec_ok(&format!("{}\n", content.len())), // stat -c %s
            exec_ok(&format!("{b64}\n")),             // single chunk
        ]);
        let result = client.read_file("m-1", "notes/a.txt").await.unwrap();
        assert_eq!(result, content);
        let calls = client.http.calls();
        let stat_cmd = calls[0].2.as_ref().unwrap()["cmd"][2].as_str().unwrap();
        assert!(stat_cmd.contains("stat -c %s '/workspace/notes/a.txt'"));
        let chunk_cmd = calls[1].2.as_ref().unwrap()["cmd"][2].as_str().unwrap();
        assert!(chunk_cmd.contains("tail -c +1"));
        assert!(chunk_cmd.contains("| base64"));
    }

    #[tokio::test]
    async fn read_file_reads_multiple_chunks() {
        // File bigger than one chunk: 48K + 10 bytes.
        let part1 = "a".repeat(CHUNK_BYTES);
        let part2 = "b".repeat(10);
        let total = CHUNK_BYTES + 10;
        let client = client_with(vec![
            exec_ok(&format!("{total}\n")),
            exec_ok(&B64.encode(part1.as_bytes())),
            exec_ok(&B64.encode(part2.as_bytes())),
        ]);
        let result = client.read_file("m-1", "big.txt").await.unwrap();
        assert_eq!(result.len(), total);
        assert!(result.ends_with("bbbbbbbbbb"));
        let calls = client.http.calls();
        assert_eq!(calls.len(), 3);
        let second_chunk = calls[2].2.as_ref().unwrap()["cmd"][2].as_str().unwrap();
        assert!(second_chunk.contains(&format!("tail -c +{}", CHUNK_BYTES + 1)));
    }

    #[tokio::test]
    async fn read_file_errors_on_missing_file_and_bad_paths() {
        let client = client_with(vec![(
            200,
            json!({ "exit_code": 1, "stdout": "", "stderr": "stat: no such file" }),
        )]);
        let err = client.read_file("m-1", "missing.txt").await.unwrap_err();
        assert!(err.contains("missing.txt"));
        let client = client_with(vec![]);
        assert!(client.read_file("m-1", "../escape").await.is_err());
        assert!(client.read_file("m-1", "/abs").await.is_err());
    }

    #[tokio::test]
    async fn read_file_enforces_size_cap() {
        let client = client_with(vec![exec_ok(&format!("{}\n", MAX_FILE_BYTES + 1))]);
        let err = client.read_file("m-1", "big.bin").await.unwrap_err();
        assert!(err.contains("5MB"));
    }

    #[tokio::test]
    async fn write_file_sends_base64_tee_chunks() {
        let client = client_with(vec![exec_ok("")]);
        client
            .write_file("m-1", "out/result.txt", "payload")
            .await
            .unwrap();
        let calls = client.http.calls();
        assert_eq!(calls.len(), 1);
        let cmd = calls[0].2.as_ref().unwrap()["cmd"][2].as_str().unwrap();
        assert!(cmd.contains("mkdir -p '/workspace/out'"));
        assert!(cmd.contains(&B64.encode("payload".as_bytes())));
        assert!(cmd.contains("base64 -d | tee '/workspace/out/result.txt'"));
        assert!(!cmd.contains("tee -a"));
    }

    #[tokio::test]
    async fn write_file_appends_subsequent_chunks() {
        let content = "x".repeat(CHUNK_BYTES + 5);
        let client = client_with(vec![exec_ok(""), exec_ok("")]);
        client.write_file("m-1", "big.txt", &content).await.unwrap();
        let calls = client.http.calls();
        assert_eq!(calls.len(), 2);
        let first = calls[0].2.as_ref().unwrap()["cmd"][2].as_str().unwrap();
        let second = calls[1].2.as_ref().unwrap()["cmd"][2].as_str().unwrap();
        assert!(first.contains("| tee '/workspace/big.txt'"));
        assert!(second.contains("| tee -a '/workspace/big.txt'"));
    }

    #[tokio::test]
    async fn write_file_rejects_oversized_and_bad_paths() {
        let client = client_with(vec![]);
        let big = "x".repeat((MAX_FILE_BYTES + 1) as usize);
        assert!(client
            .write_file("m-1", "big.txt", &big)
            .await
            .unwrap_err()
            .contains("5MB"));
        assert!(client.write_file("m-1", "../x", "d").await.is_err());
        assert!(client.http.calls().is_empty());
    }

    #[tokio::test]
    async fn stop_without_destroy_only_stops() {
        let client = client_with(vec![(200, json!({}))]);
        client.stop("m-1", false).await.unwrap();
        let calls = client.http.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "POST");
        assert_eq!(calls[0].1, "/apps/test-app/machines/m-1/stop");
    }

    #[tokio::test]
    async fn stop_with_destroy_also_deletes() {
        let client = client_with(vec![(200, json!({})), (200, json!({}))]);
        client.stop("m-1", true).await.unwrap();
        let calls = client.http.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].0, "DELETE");
        assert_eq!(calls[1].1, "/apps/test-app/machines/m-1?force=true");
    }

    #[tokio::test]
    async fn machine_state_maps_fly_states() {
        for (fly, ours) in [
            ("started", "running"),
            ("starting", "provisioning"),
            ("created", "provisioning"),
            ("stopped", "stopped"),
            ("destroyed", "destroyed"),
        ] {
            let client = client_with(vec![(200, json!({ "id": "m-1", "state": fly }))]);
            assert_eq!(client.machine_state("m-1").await.unwrap(), ours);
        }
    }

    #[test]
    fn map_state_passes_unknown_states_through() {
        assert_eq!(map_state("weird"), "weird");
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    /// M2: a machine id alone is not authority — the calling bot must own it.
    #[test]
    fn machine_ownership_binds_a_machine_to_one_bot() {
        record_machine_owner("bot-alpha", "m-owned-by-alpha").unwrap();
        record_machine_owner("bot-beta", "m-owned-by-beta").unwrap();

        assert!(require_machine_owner("bot-alpha", "m-owned-by-alpha").is_ok());

        // Another bot's machine: refused (this is the fly_exec / fly_stop
        // cross-bot escape).
        let err = require_machine_owner("bot-alpha", "m-owned-by-beta").unwrap_err();
        assert!(err.contains("different bot"), "got: {err}");

        // A machine id this host never provisioned: refused (destroying any
        // machine in the Fly app by guessing/enumerating ids).
        let err = require_machine_owner("bot-alpha", "m-someone-elses").unwrap_err();
        assert!(err.contains("unknown session id"), "got: {err}");

        // Malformed ids and bot ids are still rejected.
        assert!(require_machine_owner("bot-alpha", "m/../x").is_err());
        assert!(require_machine_owner("../evil", "m-owned-by-alpha").is_err());
        assert!(record_machine_owner("../evil", "m-x").is_err());
        assert!(record_machine_owner("bot-alpha", "m x").is_err());

        forget_machine_owner("m-owned-by-alpha");
        assert!(require_machine_owner("bot-alpha", "m-owned-by-alpha").is_err());
        forget_machine_owner("m-owned-by-beta");
    }

    /// M2: the guards run before any HTTP call is made.
    #[tokio::test]
    async fn fly_commands_refuse_unowned_machines_before_any_request() {
        let err = fly_exec(
            "bot-gamma".into(),
            "m-not-provisioned-here".into(),
            "rm -rf /".into(),
            None,
        )
        .await
        .unwrap_err();
        assert!(err.contains("unknown session id"), "got: {err}");

        let err = fly_stop(
            "bot-gamma".into(),
            "m-not-provisioned-here".into(),
            Some(true),
        )
        .await
        .unwrap_err();
        assert!(err.contains("unknown session id"), "got: {err}");

        let err = fly_read_file(
            "bot-gamma".into(),
            "m-not-provisioned-here".into(),
            "a.txt".into(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("unknown session id"), "got: {err}");

        let err = fly_write_file(
            "bot-gamma".into(),
            "m-not-provisioned-here".into(),
            "a.txt".into(),
            "x".into(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("unknown session id"), "got: {err}");
    }

    #[test]
    fn missing_token_error_is_actionable() {
        let msg = missing_token_error();
        assert!(msg.contains("FLY_API_TOKEN"));
        assert!(msg.contains("keys/.env"));
    }
}
