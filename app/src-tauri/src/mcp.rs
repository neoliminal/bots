// MCP client (stdio transport): the plugin layer of tool-extensibility.
// Spec: openspec/specs/tool-extensibility/spec.md ("MCP server integration")
//
// The webview registers servers (user-initiated only) via `mcp_connect`,
// passing the command line and the NAMES of keys/.env entries to inject as
// env vars — the values are resolved Rust-side (read_keys_env_entry) and
// never cross the IPC boundary, per the security spec's egress-injection
// rule. Servers are contained: a crash or hang fails that server's calls
// with an error string; one reconnect attempt is made per failed call.
//
// Protocol: JSON-RPC 2.0, newline-delimited, per the MCP stdio transport.
// Only tools are consumed (tools/list, tools/call) — resources/prompts are
// out of scope for this pass (design D4).

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const PROTOCOL_VERSION: &str = "2025-06-18";
/// Longest single JSON-RPC line accepted from a server (L3): without a cap a
/// misbehaving server can grow the read buffer until the app is OOM-killed.
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// PATH handed to MCP server processes. Fixed, never inherited: the parent's
/// PATH is user-login state that would otherwise decide which binary a bare
/// command name resolves to. The Homebrew/`/usr/local` entries are what makes
/// the normal `npx`/`node` MCP server case work.
#[cfg(not(windows))]
fn child_path() -> String {
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string()
}

/// Windows equivalent: system dirs plus the standard Node.js install and npm
/// global-bin locations (the normal `node`-based MCP server case).
#[cfg(windows)]
fn child_path() -> String {
    let system_root =
        std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let mut dirs = vec![format!("{system_root}\\System32"), system_root];
    let program_files =
        std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
    dirs.push(format!("{program_files}\\nodejs"));
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(format!("{appdata}\\npm"));
    }
    dirs.join(";")
}

/// keys/.env entries that belong to the app itself and must never be handed
/// to a third-party MCP server process (H6).
pub const RESERVED_ENV_KEYS: [&str; 3] =
    ["OPENROUTER_API_KEY", "FLY_API_TOKEN", "FLY_APP_NAME"];

/// Program names that are shells / generic interpreters. Spawning one of
/// these with caller-supplied args is arbitrary code execution with an
/// app secret attached, which is exactly what `mcp_connect` must not be.
const DENIED_COMMANDS: &[&str] = &[
    "sh", "bash", "zsh", "dash", "ash", "ksh", "csh", "tcsh", "fish", "busybox", "env", "sudo",
    "doas", "su", "eval", "exec", "osascript", "perl", "ruby", "php", "xargs", "open",
    // Windows shells / script hosts / LOLBins.
    "cmd", "command", "powershell", "pwsh", "wscript", "cscript", "mshta", "rundll32", "wsl",
    "forfiles", "start", "conhost",
];

/// Script-file extensions that can never be an MCP server command: they need
/// a shell/script host to run, and (for batch files in particular) their
/// argument quoting cannot be made injection-safe.
const DENIED_EXTENSIONS: &[&str] = &[
    ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".jse", ".wsf", ".wsh", ".msc", ".scr",
    ".com",
];

/// Argument forms that turn an otherwise fine interpreter (`node`, `deno`,
/// `bun`, …) into "run this string": rejected outright.
const DENIED_ARGS: &[&str] = &[
    "-c", "-e", "--eval", "--exec", "-Command", "--command", "-EncodedCommand",
];

/// One tool a connected server exposes, as sent to the webview.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolInfo {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// JSON Schema for the arguments object (MCP `inputSchema`).
    #[serde(rename = "inputSchema", default = "default_schema")]
    pub input_schema: Value,
}

fn default_schema() -> Value {
    json!({ "type": "object", "properties": {} })
}

/// Server status row for the settings UI.
#[derive(Debug, Clone, Serialize)]
pub struct McpServerStatus {
    pub name: String,
    pub tools: Vec<McpToolInfo>,
}

/// What it takes to (re)spawn a server.
#[derive(Debug, Clone)]
struct ServerConfig {
    command: String,
    args: Vec<String>,
    env_keys: Vec<String>,
}

struct ServerProc {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

struct ManagedServer {
    config: ServerConfig,
    proc: ServerProc,
    tools: Vec<McpToolInfo>,
}

/// A registered server. The process lives behind its OWN mutex (L3): the
/// registry lock is only ever held long enough to look an entry up, so a
/// server that takes the full 60 s call timeout — or the ~2.5 min
/// call+kill+respawn+retry path — no longer blocks calls to every other
/// server. `tools` is a lock-free-ish snapshot for the settings UI, so
/// listing servers never waits on a busy one either.
#[derive(Clone)]
struct ServerEntry {
    inner: Arc<Mutex<ManagedServer>>,
    tools: Arc<std::sync::Mutex<Vec<McpToolInfo>>>,
}

impl ServerEntry {
    fn new(managed: ManagedServer) -> Self {
        let tools = Arc::new(std::sync::Mutex::new(managed.tools.clone()));
        Self {
            inner: Arc::new(Mutex::new(managed)),
            tools,
        }
    }

    fn tools_snapshot(&self) -> Vec<McpToolInfo> {
        self.tools
            .lock()
            .map(|t| t.clone())
            .unwrap_or_default()
    }

    fn set_tools(&self, tools: Vec<McpToolInfo>) {
        if let Ok(mut slot) = self.tools.lock() {
            *slot = tools;
        }
    }
}

fn servers() -> &'static Mutex<HashMap<String, ServerEntry>> {
    static SERVERS: OnceLock<Mutex<HashMap<String, ServerEntry>>> = OnceLock::new();
    SERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Is `name` an acceptable keys/.env entry to inject into a server process?
///
/// Server env keys are user-chosen third-party credentials (e.g.
/// `HELPDESK_API_KEY`), so the allowlist is a shape rule plus a hard block on
/// the app's own secrets: `SCREAMING_SNAKE_CASE`, ≤64 chars, and never one of
/// `RESERVED_ENV_KEYS`. `child_env` additionally requires the entry to exist
/// in keys/.env, so only names the user themselves put in that file resolve.
pub fn validate_env_key_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err(format!("invalid env key name: {name:?}"));
    }
    let mut chars = name.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_uppercase());
    let rest_ok = chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if !first_ok || !rest_ok {
        return Err(format!(
            "invalid env key name {name:?}: use A-Z, 0-9 and '_' (starting with a letter)"
        ));
    }
    if RESERVED_ENV_KEYS.contains(&name) {
        return Err(format!(
            "{name} is an app credential and is never passed to an MCP server"
        ));
    }
    Ok(())
}

/// Validate a server command line before anything is spawned (H6).
///
/// - the command is a bare program name or an absolute path to an existing,
///   executable regular file (no relative paths, no shell metacharacters);
/// - shells and generic interpreters are refused by basename;
/// - `-c` / `-e` / `--eval` style "run this string" args are refused;
/// - every env key must pass `validate_env_key_name`.
pub fn validate_server_config(
    command: &str,
    args: &[String],
    env_keys: &[String],
) -> Result<(), String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("server command is required".into());
    }
    if command.contains('\0')
        || command.chars().any(|c| c.is_whitespace())
        || command.contains(|c| ";&|<>$`(){}[]*?!~\"'\\\n".contains(c))
    {
        return Err("server command must be a program name or an absolute path".into());
    }

    let path = Path::new(command);
    let basename = if path.is_absolute() {
        let meta = std::fs::metadata(path)
            .map_err(|_| format!("no executable at {command}"))?;
        if !meta.is_file() {
            return Err(format!("no executable at {command}"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            if meta.permissions().mode() & 0o111 == 0 {
                return Err(format!("{command} is not executable"));
            }
        }
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        if command.contains('/') {
            return Err(
                "server command must be a bare program name or an absolute path".into(),
            );
        }
        command.to_string()
    };

    let lower = basename.to_ascii_lowercase();
    if DENIED_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return Err(format!(
            "{basename} is a script file and cannot be used as an MCP server command; \
             use the underlying executable (e.g. `node` with the server's JS entry point)"
        ));
    }
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    if DENIED_COMMANDS.contains(&stem) || stem.starts_with("python") {
        return Err(format!(
            "{basename} is a shell/interpreter and cannot be used as an MCP server command"
        ));
    }

    for arg in args {
        if arg.contains('\0') {
            return Err("server arguments must not contain NUL bytes".into());
        }
        if DENIED_ARGS.iter().any(|d| d.eq_ignore_ascii_case(arg)) {
            return Err(format!(
                "argument {arg} runs inline code and is not allowed for MCP servers"
            ));
        }
    }

    for key in env_keys {
        validate_env_key_name(key)?;
    }
    Ok(())
}

/// Minimal, sanitized child environment: a FIXED PATH, the user's HOME (node
/// and python toolchains resolve caches/config through it), TMPDIR and LANG,
/// plus exactly the requested keys/.env entries. Nothing is inherited from
/// the app process — no ambient secrets leak into server processes.
fn child_env(env_keys: &[String]) -> Result<Vec<(String, String)>, String> {
    let temp = std::env::temp_dir().to_string_lossy().into_owned();
    let mut env: Vec<(String, String)> = vec![
        ("PATH".to_string(), child_path()),
        ("LANG".to_string(), "en_US.UTF-8".to_string()),
    ];
    #[cfg(not(windows))]
    {
        env.push(("TMPDIR".to_string(), temp));
        if let Ok(home) = std::env::var("HOME") {
            env.push(("HOME".to_string(), home));
        }
    }
    #[cfg(windows)]
    {
        env.push(("TEMP".to_string(), temp.clone()));
        env.push(("TMP".to_string(), temp));
        if let Ok(system_root) = std::env::var("SystemRoot") {
            env.push(("SystemRoot".to_string(), system_root));
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            env.push(("USERPROFILE".to_string(), profile.clone()));
            // Node/python toolchains resolve caches/config through either.
            env.push(("HOME".to_string(), profile));
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            env.push(("APPDATA".to_string(), appdata));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            env.push(("LOCALAPPDATA".to_string(), local));
        }
    }
    for key in env_keys {
        validate_env_key_name(key)?;
        match crate::read_keys_env_entry(key) {
            Some(value) => env.push((key.clone(), value)),
            None => return Err(format!("keys/.env has no entry named {key}")),
        }
    }
    Ok(env)
}

/// Read one newline-terminated line into `buf` (cleared first), refusing to
/// buffer more than `MAX_LINE_BYTES` (L3). Returns the number of bytes read;
/// 0 means EOF. Unlike `read_line`, memory use is bounded by the cap plus one
/// buffer refill, so a server emitting an endless line cannot exhaust the
/// host's memory.
async fn read_line_capped(
    reader: &mut BufReader<ChildStdout>,
    buf: &mut Vec<u8>,
) -> Result<usize, String> {
    buf.clear();
    loop {
        let (done, consumed) = {
            let available = reader
                .fill_buf()
                .await
                .map_err(|e| format!("server read failed: {e}"))?;
            if available.is_empty() {
                return Ok(buf.len()); // EOF (0 when nothing was buffered)
            }
            match available.iter().position(|b| *b == b'\n') {
                Some(i) => {
                    if buf.len() + i + 1 > MAX_LINE_BYTES {
                        return Err(format!(
                            "server sent a line longer than {MAX_LINE_BYTES} bytes"
                        ));
                    }
                    buf.extend_from_slice(&available[..=i]);
                    (true, i + 1)
                }
                None => {
                    if buf.len() + available.len() > MAX_LINE_BYTES {
                        return Err(format!(
                            "server sent a line longer than {MAX_LINE_BYTES} bytes"
                        ));
                    }
                    buf.extend_from_slice(available);
                    (false, available.len())
                }
            }
        };
        reader.consume(consumed);
        if done {
            return Ok(buf.len());
        }
    }
}

/// Resolve a bare server command against the fixed child PATH. Needed on
/// Windows because CreateProcess searches the PARENT's PATH, not the
/// sanitized PATH we hand the child — resolving explicitly keeps the fixed
/// PATH in charge of which binary a bare name means.
#[cfg(windows)]
fn resolve_command(command: &str) -> Result<String, String> {
    if Path::new(command).is_absolute() {
        return Ok(command.to_string());
    }
    let path = child_path();
    for dir in path.split(';') {
        let exe = Path::new(dir).join(format!("{command}.exe"));
        if exe.is_file() {
            return Ok(exe.to_string_lossy().into_owned());
        }
    }
    // A .cmd shim (npx, npm-installed launchers) is what usually exists
    // instead — refuse it with a pointer at the safe alternative.
    for dir in path.split(';') {
        if Path::new(dir).join(format!("{command}.cmd")).is_file() {
            return Err(format!(
                "{command} is a batch-script shim on Windows and cannot be run directly; \
                 use `node` with the server's JS entry point instead"
            ));
        }
    }
    Err(format!("{command} was not found on the MCP server PATH"))
}

#[cfg(not(windows))]
fn resolve_command(command: &str) -> Result<String, String> {
    Ok(command.to_string())
}

impl ServerProc {
    async fn spawn(config: &ServerConfig) -> Result<Self, String> {
        let env = child_env(&config.env_keys)?;
        let program = resolve_command(&config.command)?;
        let mut command = Command::new(&program);
        command
            .args(&config.args)
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // Own process group, so `kill` takes the server's grandchildren down
        // with it (same discipline as session.rs).
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(crate::session::CREATE_NO_WINDOW);
        let mut child = command
            .spawn()
            .map_err(|e| format!("failed to spawn {}: {e}", config.command))?;
        let stdin = child.stdin.take().ok_or("no stdin pipe")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout pipe")?);
        Ok(Self { child, stdin, stdout, next_id: 0 })
    }

    async fn send(&mut self, message: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(message).map_err(|e| e.to_string())?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("server write failed: {e}"))?;
        self.stdin.flush().await.map_err(|e| format!("server write failed: {e}"))
    }

    /// Send a request and read newline-delimited messages until the reply
    /// with our id arrives (skipping notifications/other traffic).
    async fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await?;

        let read = async {
            let mut line: Vec<u8> = Vec::new();
            loop {
                let n = read_line_capped(&mut self.stdout, &mut line).await?;
                if n == 0 {
                    return Err("server closed its stdout (crashed?)".to_string());
                }
                let Ok(msg) = serde_json::from_slice::<Value>(&line) else {
                    continue; // tolerate stray non-JSON output lines
                };
                if msg.get("id").and_then(Value::as_u64) == Some(id) {
                    if let Some(err) = msg.get("error") {
                        let text = err.get("message").and_then(Value::as_str).unwrap_or("unknown");
                        return Err(format!("{method} failed: {text}"));
                    }
                    return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
                }
            }
        };
        tokio::time::timeout(timeout, read)
            .await
            .map_err(|_| format!("{method} timed out after {}s", timeout.as_secs()))?
    }

    async fn initialize(&mut self) -> Result<(), String> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "bots", "version": env!("CARGO_PKG_VERSION") },
            }),
            HANDSHAKE_TIMEOUT,
        )
        .await?;
        self.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await
    }

    async fn list_tools(&mut self) -> Result<Vec<McpToolInfo>, String> {
        let result = self.request("tools/list", json!({}), HANDSHAKE_TIMEOUT).await?;
        let tools = result.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(tools
            .into_iter()
            .filter_map(|t| serde_json::from_value::<McpToolInfo>(t).ok())
            .collect())
    }

    async fn call_tool(&mut self, tool: &str, args: Value) -> Result<String, String> {
        let result = self
            .request("tools/call", json!({ "name": tool, "arguments": args }), CALL_TIMEOUT)
            .await?;
        Ok(render_call_result(&result))
    }

    /// Kill the server's whole process GROUP (grandchildren included — an
    /// `npx` wrapper's real server process would otherwise survive), then
    /// reap the direct child.
    async fn kill(&mut self) {
        crate::session::kill_process_group(self.child.id());
        let _ = self.child.kill().await;
    }
}

/// Flatten a tools/call result into model-readable text. `isError: true`
/// results become "Error: …" strings — error results, never exceptions
/// (tool-extensibility "Tool failure is survivable").
pub(crate) fn render_call_result(result: &Value) -> String {
    let content = result
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| match item.get("type").and_then(Value::as_str) {
                    Some("text") => item.get("text").and_then(Value::as_str).map(str::to_string),
                    Some(other) => Some(format!("[unsupported {other} content omitted]")),
                    None => None,
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let text = if content.is_empty() { "(empty result)".to_string() } else { content };
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        format!("Error: {text}")
    } else {
        text
    }
}

async fn connect_managed(config: ServerConfig) -> Result<ManagedServer, String> {
    let mut proc = ServerProc::spawn(&config).await?;
    if let Err(e) = proc.initialize().await {
        proc.kill().await;
        return Err(e);
    }
    match proc.list_tools().await {
        Ok(tools) => Ok(ManagedServer { config, proc, tools }),
        Err(e) => {
            proc.kill().await;
            Err(e)
        }
    }
}

/// Register + connect an MCP server (user-initiated from settings only).
/// Replaces any existing server of the same name. Returns its tool list.
#[tauri::command]
pub async fn mcp_connect(
    name: String,
    command: String,
    args: Vec<String>,
    env_keys: Vec<String>,
) -> Result<Vec<McpToolInfo>, String> {
    if name.trim().is_empty() {
        return Err("server name and command are required".to_string());
    }
    validate_server_config(&command, &args, &env_keys)?;
    let config = ServerConfig {
        command: command.trim().to_string(),
        args,
        env_keys,
    };
    // Connect BEFORE taking the registry lock: a slow handshake must not
    // block calls to servers that are already connected.
    let managed = connect_managed(config).await?;
    let tools = managed.tools.clone();
    let previous = {
        let mut map = servers().lock().await;
        map.insert(name, ServerEntry::new(managed))
    };
    if let Some(previous) = previous {
        previous.inner.lock().await.proc.kill().await;
    }
    Ok(tools)
}

/// Call one tool on a connected server. A transport failure retries once on
/// a fresh process (lazy restart); a second failure disconnects the server
/// (its tools go unavailable) and returns the error.
#[tauri::command]
pub async fn mcp_call(server: String, tool: String, args: Value) -> Result<String, String> {
    // Take the registry lock only to look the entry up, then release it: the
    // call below can take minutes and must not stall other servers (L3).
    let entry = {
        let map = servers().lock().await;
        map.get(&server).cloned()
    }
    .ok_or_else(|| format!("MCP server \"{server}\" is not connected"))?;

    let mut managed = entry.inner.lock().await;
    match managed.proc.call_tool(&tool, args.clone()).await {
        Ok(text) => Ok(text),
        Err(first_err) => {
            // Contained restart: one fresh spawn, one retry.
            managed.proc.kill().await;
            match connect_managed(managed.config.clone()).await {
                Ok(fresh) => {
                    *managed = fresh;
                    entry.set_tools(managed.tools.clone());
                    managed.proc.call_tool(&tool, args).await
                }
                Err(_) => {
                    drop(managed);
                    let removed = {
                        let mut map = servers().lock().await;
                        map.remove(&server)
                    };
                    if let Some(removed) = removed {
                        removed.inner.lock().await.proc.kill().await;
                    }
                    Err(format!(
                        "MCP server \"{server}\" failed and could not restart: {first_err}"
                    ))
                }
            }
        }
    }
}

/// Disconnect (and forget) a server.
#[tauri::command]
pub async fn mcp_disconnect(name: String) -> Result<(), String> {
    let removed = {
        let mut map = servers().lock().await;
        map.remove(&name)
    };
    if let Some(removed) = removed {
        removed.inner.lock().await.proc.kill().await;
    }
    Ok(())
}

/// Connected servers and their tools (settings UI + registry adapter).
#[tauri::command]
pub async fn mcp_servers() -> Vec<McpServerStatus> {
    let entries: Vec<(String, ServerEntry)> = {
        let map = servers().lock().await;
        map.iter().map(|(n, e)| (n.clone(), e.clone())).collect()
    };
    let mut rows: Vec<McpServerStatus> = entries
        .into_iter()
        .map(|(name, entry)| McpServerStatus {
            name,
            tools: entry.tools_snapshot(),
        })
        .collect();
    rows.sort_by(|a, b| a.name.cmp(&b.name));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::io::Write as _;

    /// Minimal MCP server fixture (python3): answers initialize, tools/list
    /// with one echo tool, and tools/call by echoing the "text" argument.
    /// `broken_after_calls` makes it exit after N tools/call replies, to
    /// exercise crash containment.
    #[cfg(unix)]
    fn fixture_server(broken_after_calls: i64) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().expect("tmp file");
        let script = r#"
import json, sys

calls_left = BROKEN_AFTER
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    mid = msg.get("id")
    method = msg.get("method", "")
    if method == "initialize":
        out = {"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "fixture", "version": "0"}}}
    elif method == "tools/list":
        out = {"jsonrpc": "2.0", "id": mid, "result": {"tools": [{"name": "echo", "description": "Echo text back", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}}]}}
    elif method == "tools/call":
        text = msg.get("params", {}).get("arguments", {}).get("text", "")
        out = {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": "echo: " + text}]}}
        if calls_left > 0:
            calls_left -= 1
            if calls_left == 0:
                print(json.dumps(out), flush=True)
                sys.exit(1)
    elif mid is None:
        continue
    else:
        out = {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "no such method"}}
    print(json.dumps(out), flush=True)
"#
        .replace("BROKEN_AFTER", &broken_after_calls.to_string());
        file.write_all(script.as_bytes()).expect("write fixture");
        file
    }

    #[cfg(unix)]
    fn fixture_config(file: &tempfile::NamedTempFile) -> ServerConfig {
        ServerConfig {
            command: "python3".to_string(),
            args: vec![file.path().to_string_lossy().to_string()],
            env_keys: vec![],
        }
    }

    // The live-server tests use a python3 fixture, so they run on Unix only;
    // the validation/rendering logic they sit on is platform-independent.
    #[cfg(unix)]
    #[tokio::test]
    async fn handshake_lists_tools_and_calls_echo() {
        let fixture = fixture_server(0);
        let mut managed = connect_managed(fixture_config(&fixture)).await.expect("connect");
        assert_eq!(managed.tools.len(), 1);
        assert_eq!(managed.tools[0].name, "echo");
        assert!(managed.tools[0].input_schema["properties"]["text"].is_object());

        let reply = managed
            .proc
            .call_tool("echo", json!({ "text": "hi" }))
            .await
            .expect("call");
        assert_eq!(reply, "echo: hi");
        managed.proc.kill().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unknown_method_is_an_error_result_not_a_hang() {
        let fixture = fixture_server(0);
        let mut managed = connect_managed(fixture_config(&fixture)).await.expect("connect");
        let err = managed
            .proc
            .request("nope/nothing", json!({}), Duration::from_secs(5))
            .await
            .expect_err("should error");
        assert!(err.contains("no such method"), "got: {err}");
        managed.proc.kill().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn crashed_server_read_reports_closed_stdout() {
        let fixture = fixture_server(1);
        let mut managed = connect_managed(fixture_config(&fixture)).await.expect("connect");
        // First call succeeds, then the fixture exits.
        let ok = managed.proc.call_tool("echo", json!({ "text": "a" })).await.expect("first");
        assert_eq!(ok, "echo: a");
        let err = managed
            .proc
            .call_tool("echo", json!({ "text": "b" }))
            .await
            .expect_err("server is gone");
        assert!(err.contains("closed") || err.contains("failed"), "got: {err}");
        managed.proc.kill().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_failure_is_an_error_string() {
        let config = ServerConfig {
            command: "/nonexistent/definitely-not-a-binary".to_string(),
            args: vec![],
            env_keys: vec![],
        };
        let err = match connect_managed(config).await {
            Ok(_) => panic!("expected spawn failure"),
            Err(e) => e,
        };
        assert!(err.contains("failed to spawn"), "got: {err}");
    }

    /// Windows: bare names resolve against the fixed child PATH only, and an
    /// unresolvable name fails before anything is spawned.
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_bare_names_resolve_against_the_fixed_path_only() {
        let err = match connect_managed(ServerConfig {
            command: "definitely-not-a-real-mcp-binary".to_string(),
            args: vec![],
            env_keys: vec![],
        })
        .await
        {
            Ok(_) => panic!("expected resolution failure"),
            Err(e) => e,
        };
        assert!(err.contains("not found"), "got: {err}");
        // A System32 binary resolves through the fixed PATH.
        assert!(resolve_command("find").unwrap().to_lowercase().ends_with("find.exe"));
    }

    #[test]
    fn render_call_result_flattens_text_and_marks_errors() {
        let ok = json!({ "content": [ {"type": "text", "text": "a"}, {"type": "text", "text": "b"} ] });
        assert_eq!(render_call_result(&ok), "a\nb");
        let err = json!({ "isError": true, "content": [ {"type": "text", "text": "boom"} ] });
        assert_eq!(render_call_result(&err), "Error: boom");
        let image = json!({ "content": [ {"type": "image", "data": "…"} ] });
        assert_eq!(render_call_result(&image), "[unsupported image content omitted]");
        assert_eq!(render_call_result(&json!({})), "(empty result)");
    }

    #[test]
    fn child_env_rejects_missing_key_names() {
        let err = child_env(&["DEFINITELY_MISSING_KEY_NAME".to_string()]).expect_err("missing");
        assert!(err.contains("DEFINITELY_MISSING_KEY_NAME"));
    }

    /// H6: the app's own credentials are never injectable into a server.
    #[test]
    fn env_keys_reject_app_credentials_and_odd_names() {
        for reserved in RESERVED_ENV_KEYS {
            let err = validate_env_key_name(reserved).unwrap_err();
            assert!(err.contains("app credential"), "got: {err}");
            // …and the same through the env builder, before any file read.
            assert!(child_env(&[reserved.to_string()]).is_err());
        }
        for bad in [
            "",
            "lowercase",
            "MiXeD",
            "WITH-DASH",
            "WITH SPACE",
            "WITH.DOT",
            "9LEADING_DIGIT",
            "PATH=x",
            "A\0B",
        ] {
            assert!(
                validate_env_key_name(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
        assert!(validate_env_key_name("HELPDESK_API_KEY").is_ok());
        assert!(validate_env_key_name("SLACK_BOT_TOKEN2").is_ok());
        assert!(validate_env_key_name(&"A".repeat(65)).is_err());
    }

    /// H6: `mcp_connect` may not be used to run arbitrary code.
    #[test]
    fn server_command_rejects_shells_and_inline_code() {
        let no_args: Vec<String> = vec![];
        // Bare, plausible MCP launchers still work.
        assert!(validate_server_config("npx", &["-y".into(), "srv".into()], &no_args).is_ok());
        assert!(validate_server_config("node", &["server.js".into()], &no_args).is_ok());
        assert!(validate_server_config("  npx  ", &[], &no_args).is_ok());

        // Shells / interpreters by name (both platforms' sets, everywhere).
        for cmd in [
            "sh", "bash", "zsh", "dash", "ksh", "fish", "env", "sudo", "osascript", "perl",
            "ruby", "python", "python3", "python3.12", "BASH", "cmd", "cmd.exe", "powershell",
            "powershell.exe", "pwsh", "wscript", "cscript", "mshta", "rundll32", "wsl",
        ] {
            let err = validate_server_config(cmd, &["-c".into()], &no_args)
                .unwrap_err();
            assert!(
                err.contains("shell/interpreter") || err.contains("inline code"),
                "{cmd} should be refused, got: {err}"
            );
        }

        // Inline-code arguments on any command.
        for arg in ["-c", "-e", "--eval", "--exec", "-Command"] {
            assert!(
                validate_server_config("node", &[arg.to_string(), "evil()".into()], &no_args)
                    .is_err(),
                "node {arg} should be refused"
            );
        }

        // Command shapes: no relative paths, no metacharacters, no empties.
        for cmd in [
            "",
            "   ",
            "./evil",
            "../evil",
            "bin/evil",
            "npx; curl evil.example",
            "npx && curl",
            "np x",
            "$(evil)",
            "`evil`",
            "npx|tee",
            "cmd\0",
        ] {
            assert!(
                validate_server_config(cmd, &[], &no_args).is_err(),
                "{cmd:?} should be refused"
            );
        }

        // Script files are refused by extension, wherever they live.
        for cmd in ["server.bat", "server.cmd", "server.ps1", "launcher.vbs"] {
            let err = validate_server_config(cmd, &[], &no_args).unwrap_err();
            assert!(err.contains("script file"), "{cmd} should be refused, got: {err}");
        }

        // Absolute paths must point at a real executable.
        assert!(validate_server_config("/nonexistent/nope", &[], &no_args).is_err());
        #[cfg(unix)]
        {
            assert!(validate_server_config("/bin/sh", &[], &no_args).is_err());
            assert!(validate_server_config("/usr/bin/true", &[], &no_args).is_ok());
            // …and not at a plain, non-executable file.
            let plain = tempfile::NamedTempFile::new().unwrap();
            assert!(
                validate_server_config(&plain.path().to_string_lossy(), &[], &no_args).is_err()
            );
        }
        #[cfg(windows)]
        {
            let system_root =
                std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
            // Forward-slash absolute paths are the accepted Windows form
            // (backslashes fall in the rejected-metacharacter set).
            let find = format!("{}/System32/find.exe", system_root.replace('\\', "/"));
            assert!(validate_server_config(&find, &[], &no_args).is_ok());
            let cmd = format!("{}/System32/cmd.exe", system_root.replace('\\', "/"));
            assert!(validate_server_config(&cmd, &[], &no_args).is_err());
        }

        // Env keys are validated here too.
        assert!(
            validate_server_config("npx", &[], &["OPENROUTER_API_KEY".to_string()]).is_err()
        );
    }

    #[tokio::test]
    async fn mcp_connect_refuses_a_shell_command_without_spawning() {
        let err = mcp_connect(
            "evil".into(),
            "bash".into(),
            vec!["-c".into(), "curl evil.example".into()],
            vec!["OPENROUTER_API_KEY".into()],
        )
        .await
        .unwrap_err();
        assert!(err.contains("shell/interpreter"), "got: {err}");
        assert!(mcp_servers().await.iter().all(|s| s.name != "evil"));
    }

    /// L3: an endless line from a server errors out instead of eating RAM.
    #[cfg(unix)]
    #[tokio::test]
    async fn overlong_lines_are_rejected() {
        let mut file = tempfile::NamedTempFile::new().expect("tmp file");
        // Answers initialize normally, then floods stdout with one huge line.
        let script = r#"
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    mid = msg.get("id")
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": mid, "result": {}}), flush=True)
    else:
        chunk = "x" * (1024 * 1024)
        while True:
            sys.stdout.write(chunk)
            sys.stdout.flush()
"#;
        file.write_all(script.as_bytes()).expect("write fixture");
        let mut managed = ServerProc::spawn(&fixture_config(&file)).await.expect("spawn");
        managed.initialize().await.expect("handshake");
        let err = managed
            .request("tools/list", json!({}), Duration::from_secs(30))
            .await
            .expect_err("flood must be refused");
        assert!(err.contains("longer than"), "got: {err}");
        managed.kill().await;
    }
}
