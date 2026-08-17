// Bots personal-host browse runner: client-or-daemon.
//
// Spec: openspec/specs/agent-computer/spec.md (DOM-driven browsing tools,
// persistent browser profile). The app never talks to this directly — it
// runs `node ~/.bots-host/browse.mjs <base64-json>` over SSH; the client
// POSTs the request to the localhost daemon, auto-spawning it on first use.
// The daemon holds ONE Playwright persistent context (profile survives, so
// logins stick) and ONE page, binds 127.0.0.1 only, and exits after 30
// minutes idle.
//
// The daemon drives a browser that is logged into the user's real accounts,
// so its HTTP surface is treated as a privileged one even though it is
// loopback-only: every request must be a POST to "/", carry the per-install
// secret from ~/.bots-host/daemon-token in the x-bots-token header, address
// the daemon by its loopback Host, and carry no Origin header (which no
// legitimate local client sends, but every browser does). That combination
// is what keeps other local processes — and web pages reaching loopback via
// CORS or DNS rebinding — from driving the user's session.
//
// Request:  { action: "goto"|"read"|"click"|"fill"|"status"|"clear",
//             url?, role?, name?, nth?, label?, value?, site? }
// Response: { ok: boolean, ...payload } as JSON on stdout (always exit 0 so
//            SSH exec reports transport success; failures are in-band).

import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import os from "node:os";

const PORT = 8377;
const HOST = "127.0.0.1";
const IDLE_EXIT_MS = 30 * 60 * 1000;
const ROOT = process.env.BOTS_HOST_ROOT ?? path.join(os.homedir(), ".bots-host");
const PROFILE_DIR = path.join(ROOT, "profile");
/** Per-install shared secret between the client and the daemon (mode 0600). */
const TOKEN_FILE = path.join(ROOT, "daemon-token");
/** Where the detached daemon's stdout/stderr lands, so adoption is auditable. */
const LOG_FILE = path.join(ROOT, "daemon.log");
const TOKEN_HEADER = "x-bots-token";
/** Max characters of page text returned by "read". */
const READ_TEXT_CAP = 12_000;
/** Max interactive elements listed by "read" / candidate errors. */
const ELEMENTS_CAP = 60;
/** Requests are small JSON blobs; anything larger is abuse, not a client. */
const MAX_BODY_BYTES = 1024 * 1024;

// ----------------------------------------------------------------- token --

/**
 * The client and the daemon are the same file on the same machine, so the
 * shared secret is simply a 0600 file in the host root. Whichever side runs
 * first creates it; the daemon always calls this BEFORE it starts listening,
 * so a token file exists by the time the port answers.
 */
function ensureToken() {
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  try {
    chmodSync(ROOT, 0o700);
  } catch {
    // Not ours to tighten (unusual BOTS_HOST_ROOT): carry on.
  }
  const existing = readToken();
  if (existing) return existing;
  // Write 0600 out of the way, then hard-link it into place: link() is
  // atomic and fails with EEXIST rather than clobbering, so two clients
  // racing on first use converge on one token instead of invalidating each
  // other's, and no reader ever sees a half-written file.
  const tmp = `${TOKEN_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    try {
      linkSync(tmp, TOKEN_FILE);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error; // Someone beat us to it: fine.
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort.
    }
  }
  const settled = readToken();
  if (!settled) throw new Error(`could not create ${TOKEN_FILE}`);
  return settled;
}

/** The stored token, or null when absent/unusable. */
function readToken() {
  let raw;
  try {
    raw = readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{64,}$/.test(raw)) return null;
  try {
    // A token any other user can read is no token at all — re-tighten it.
    if (statSync(TOKEN_FILE).mode & 0o077) chmodSync(TOKEN_FILE, 0o600);
  } catch {
    // Best effort.
  }
  return raw;
}

/** Constant-time token comparison (length is fixed and public, so may leak). */
function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- daemon --

/**
 * Directories a genuine session-manager binary lives in on a Linux desktop.
 * All are root-owned: a user-writable path here would defeat the point.
 * Distros scatter these (Xwayland in /usr/bin, some compositors under
 * /usr/lib or /usr/libexec), so the list is broad but never leaves /usr,
 * /bin or /sbin.
 */
const SYSTEM_BIN_DIRS = [
  "/usr/bin/",
  "/usr/sbin/",
  "/usr/lib/",
  "/usr/libexec/",
  "/usr/local/bin/",
  "/usr/local/libexec/",
  "/bin/",
  "/sbin/",
];

/**
 * Pids owned by `uid` whose kernel process name is exactly one of `names`,
 * in the order `names` gives (so the preferred session manager wins).
 *
 * Deliberately not `pgrep -f`: matching the whole command line lets any
 * same-user process qualify just by mentioning "mutter" somewhere in its
 * argv. Even plain `pgrep` is the wrong instrument — some implementations
 * match argv[0], which the process itself chooses. /proc/<pid>/comm is the
 * name the kernel recorded from the executable, and /proc/<pid>'s owner is
 * the process's real uid; neither is under the process's control.
 */
function sessionPids(names, uid, procRoot = "/proc") {
  const rank = new Map(names.map((name, i) => [name, i]));
  let entries;
  try {
    entries = readdirSync(procRoot);
  } catch {
    return []; // No /proc: not a Linux desktop, so there is nothing to adopt.
  }
  const found = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let comm;
    try {
      if (statSync(`${procRoot}/${entry}`).uid !== uid) continue;
      // comm is truncated to 15 chars by the kernel; every name we look for
      // is shorter than that, so an exact compare is safe.
      comm = readFileSync(`${procRoot}/${entry}/comm`, "utf8").trim();
    } catch {
      continue; // Process exited mid-scan, or is not ours to inspect.
    }
    if (rank.has(comm)) found.push({ pid: entry, comm });
  }
  return found.sort((a, b) => rank.get(a.comm) - rank.get(b.comm));
}

/** Resolved executable path of `pid` if it is a system binary, else null. */
function systemExecutable(pid, procRoot = "/proc") {
  let exe;
  try {
    exe = realpathSync(`${procRoot}/${pid}/exe`);
  } catch {
    return null; // Gone, unreadable, or the binary was deleted.
  }
  return SYSTEM_BIN_DIRS.some((dir) => exe.startsWith(dir)) ? exe : null;
}

/** Absolute, symlink-resolved form of `p` (best effort if it does not exist). */
function resolvePath(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `value` is the user's home or /run/user/<uid>, or sits inside one. */
function underOwnDirs(value, uid) {
  const resolved = resolvePath(value);
  return [resolvePath(os.homedir()), `/run/user/${uid}`].some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
}

/**
 * Prefer a visible browser window (so the user can perform logins on the
 * host's own screen), but survive headless machines. Started over SSH the
 * environment has neither DISPLAY nor the X auth cookie even when the
 * machine's console runs a desktop session — so borrow the display
 * environment from one of OUR OWN session processes, and fall back to
 * headless when no usable display exists.
 *
 * "Our own" is not enough on its own: the browser we point at that display
 * carries the user's login cookies, so an attacker who can start a process
 * as this user could otherwise hand us a display they control and watch the
 * session. Candidates therefore have to be a real system binary running
 * under a matching name, and their X cookie has to live somewhere only this
 * user writes. The adopted pid is logged so the choice is auditable.
 */
function adoptSessionDisplayEnv(procRoot = "/proc") {
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return false;
  const shells = ["gnome-shell", "plasmashell", "xfce4-session", "Xwayland", "labwc", "mutter"];
  for (const { pid, comm } of sessionPids(shells, uid, procRoot)) {
    const exe = systemExecutable(pid, procRoot);
    if (!exe) continue; // Something calling itself gnome-shell from /tmp.
    let vars;
    try {
      const environ = readFileSync(`${procRoot}/${pid}/environ`, "utf8");
      vars = Object.fromEntries(
        environ.split("\0").filter((kv) => kv.includes("=")).map((kv) => {
          const eq = kv.indexOf("=");
          return [kv.slice(0, eq), kv.slice(eq + 1)];
        }),
      );
    } catch {
      continue; // Process gone or unreadable: try the next one.
    }
    if (!vars.DISPLAY && !vars.WAYLAND_DISPLAY) continue;
    // An X cookie outside our own storage points at somebody else's server.
    if (vars.XAUTHORITY && !underOwnDirs(vars.XAUTHORITY, uid)) continue;
    if (vars.XDG_RUNTIME_DIR && !underOwnDirs(vars.XDG_RUNTIME_DIR, uid)) continue;
    for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR"]) {
      if (vars[key]) process.env[key] = vars[key];
    }
    console.log(
      `bots-browse adopted display from pid ${pid} (${comm}, ${exe}) — ` +
        `DISPLAY=${vars.DISPLAY ?? "-"} WAYLAND_DISPLAY=${vars.WAYLAND_DISPLAY ?? "-"} ` +
        `XAUTHORITY=${vars.XAUTHORITY ?? "-"}`,
    );
    return true;
  }
  console.log("bots-browse found no trusted desktop session — running headless");
  return false;
}

async function runDaemon() {
  // Before anything else, and crucially before we listen: no window in which
  // the port answers but the shared secret does not exist yet.
  const token = ensureToken();

  const { chromium } = await import("playwright");
  const launchOptions = { viewport: { width: 1280, height: 900 } };
  let context;
  if (adoptSessionDisplayEnv()) {
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        ...launchOptions,
        headless: false,
      });
    } catch {
      // Display advertised but unusable (stale cookie, dead session).
      context = undefined;
    }
  }
  if (!context) {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      ...launchOptions,
      headless: true,
    });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  let idleTimer = setTimeout(shutdown, IDLE_EXIT_MS);

  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_EXIT_MS);
  }

  async function shutdown() {
    try {
      await context.close();
    } finally {
      process.exit(0);
    }
  }

  /** Interactive elements as [{role, name}], deduped, capped. */
  async function interactiveElements() {
    const roles = ["link", "button", "textbox", "combobox", "checkbox", "radio", "tab"];
    const out = [];
    for (const role of roles) {
      const locators = await page.getByRole(role).all();
      for (const loc of locators.slice(0, ELEMENTS_CAP)) {
        try {
          const name = (await loc.innerText().catch(() => "")) ||
            (await loc.getAttribute("aria-label")) ||
            (await loc.getAttribute("placeholder")) || "";
          const trimmed = name.trim().replace(/\s+/g, " ").slice(0, 80);
          if (trimmed) out.push({ role, name: trimmed });
        } catch {
          // Element detached mid-walk: skip it.
        }
        if (out.length >= ELEMENTS_CAP) return out;
      }
    }
    return out;
  }

  async function pageState() {
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
    };
  }

  async function handle(req) {
    touch();
    if (!req || typeof req !== "object" || Array.isArray(req)) {
      return { ok: false, error: "request must be a JSON object" };
    }
    switch (req.action) {
      case "status":
        return { ok: true, ...(await pageState()) };
      case "goto": {
        if (typeof req.url !== "string" || !/^https?:\/\//.test(req.url)) {
          return { ok: false, error: "goto requires an http(s) url" };
        }
        await page.goto(req.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        return { ok: true, ...(await pageState()) };
      }
      case "read": {
        const text = (await page.locator("body").innerText().catch(() => ""))
          .replace(/\n{3,}/g, "\n\n")
          .slice(0, READ_TEXT_CAP);
        return { ok: true, ...(await pageState()), text, elements: await interactiveElements() };
      }
      case "click": {
        const { role, name } = req;
        if (typeof role !== "string" || typeof name !== "string") {
          return { ok: false, error: "click requires role and name" };
        }
        const locator = page.getByRole(role, { name, exact: false });
        const count = await locator.count();
        if (count === 0) {
          return {
            ok: false,
            error: `no ${role} named "${name}" found`,
            candidates: await interactiveElements(),
          };
        }
        const nth = Number.isInteger(req.nth) ? req.nth : 0;
        if (count > 1 && req.nth === undefined) {
          return {
            ok: false,
            error: `${count} ${role}s match "${name}" — pass nth to disambiguate`,
            candidates: await interactiveElements(),
          };
        }
        await locator.nth(nth).click({ timeout: 10_000 });
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        return { ok: true, ...(await pageState()) };
      }
      case "fill": {
        const { label, value } = req;
        if (typeof label !== "string" || typeof value !== "string") {
          return { ok: false, error: "fill requires label and value" };
        }
        let locator = page.getByLabel(label, { exact: false });
        if ((await locator.count()) === 0) {
          locator = page.getByPlaceholder(label, { exact: false });
        }
        if ((await locator.count()) === 0) {
          return {
            ok: false,
            error: `no field labeled "${label}" found`,
            candidates: await interactiveElements(),
          };
        }
        await locator.first().fill(value, { timeout: 10_000 });
        return { ok: true, ...(await pageState()) };
      }
      case "clear": {
        // Clear cookies for one site (by substring) or everything.
        // Reachable for humans as: node browse.mjs --clear [site]
        const cookies = await context.cookies();
        const site = typeof req.site === "string" ? req.site : null;
        const doomed = site
          ? cookies.filter((c) => c.domain.includes(site))
          : cookies;
        await context.clearCookies(
          site ? { domain: new RegExp(site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) } : undefined,
        );
        return { ok: true, cleared: doomed.length, site: site ?? "all" };
      }
      default:
        return { ok: false, error: `unknown action: ${String(req.action)}` };
    }
  }

  /**
   * Gate every request before a byte of it reaches `handle`. Returns the
   * status to reject with, or 0 to accept. Rejections carry no body: a
   * caller that cannot authenticate learns nothing about what exists here.
   */
  function rejectStatus(incoming) {
    if (incoming.method !== "POST") return 405;
    if ((incoming.url ?? "") !== "/") return 404;
    // No legitimate local client sends Origin; every browser-issued request
    // does. Refusing it kills the "CORS simple request" path outright.
    if (incoming.headers.origin !== undefined) return 403;
    // ...and pinning Host to the loopback name we bound is what defeats DNS
    // rebinding, where the browser resolves an attacker domain to 127.0.0.1.
    const host = incoming.headers.host;
    if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return 403;
    if (!tokenMatches(incoming.headers[TOKEN_HEADER], token)) return 401;
    return 0;
  }

  const server = createServer((incoming, response) => {
    const status = rejectStatus(incoming);
    if (status !== 0) {
      const headers = { "content-type": "application/json", connection: "close" };
      if (status === 405) headers.allow = "POST";
      response.writeHead(status, headers);
      response.end();
      // Drain without buffering so a rejected caller cannot hold the socket
      // (the request timeout below caps how long it may keep trying).
      incoming.resume();
      return;
    }
    let body = "";
    let bytes = 0;
    let overflowed = false;
    incoming.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        overflowed = true;
        body = "";
        response.writeHead(413, { connection: "close" });
        // Hang up once the 413 is out: a sender this far over the cap is not
        // going to stop on its own, and buffering more of it is the attack.
        response.end(() => incoming.socket?.destroy());
        return;
      }
      body += chunk;
    });
    incoming.on("end", async () => {
      if (overflowed) return;
      let result;
      try {
        result = await handle(JSON.parse(body));
      } catch (error) {
        result = { ok: false, error: String(error?.message ?? error) };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    });
    incoming.on("error", () => {
      overflowed = true;
    });
  });
  // Bound how long an unfinished request may occupy the daemon.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.on("error", (error) => {
    // Almost always EADDRINUSE: another daemon already owns the port, so
    // this one must not linger holding a second browser open.
    console.log(`bots-browse daemon cannot listen: ${String(error?.message ?? error)}`);
    context.close().catch(() => {}).finally(() => process.exit(1));
  });
  server.listen(PORT, HOST, () => {
    console.log(`bots-browse daemon listening on ${HOST}:${PORT}`);
  });
}

// ---------------------------------------------------------------- client --

/** Last transport-level failure, surfaced when the daemon stays unreachable. */
let lastTransportError = null;

function post(payload, token) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload), "utf8");
    const req = httpRequest(
      {
        host: HOST,
        port: PORT,
        method: "POST",
        path: "/",
        timeout: 45_000,
        headers: {
          "content-type": "application/json",
          "content-length": data.length,
          [TOKEN_HEADER]: token,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("daemon request timed out")));
    req.end(data);
  });
}

/** post() that answers null on a transport failure instead of throwing. */
async function tryPost(payload, token) {
  try {
    return await post(payload, token);
  } catch (error) {
    lastTransportError = String(error?.message ?? error);
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startDaemon() {
  const self = fileURLToPath(import.meta.url);
  // Keep the daemon's output: it records which desktop session it adopted.
  let log = "ignore";
  try {
    log = openSync(LOG_FILE, "a", 0o600);
  } catch {
    // Unwritable root: run without a log rather than not at all.
  }
  const child = spawn(process.execPath, [self, "serve"], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
}

/**
 * POST `payload` to the daemon, starting it if it is not up yet. Returns the
 * {status, body} of the daemon's answer, or null if it never came up.
 */
async function dispatch(payload) {
  let token;
  try {
    token = ensureToken();
  } catch (error) {
    lastTransportError = `cannot use ${TOKEN_FILE}: ${String(error?.message ?? error)}`;
    return null;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await tryPost(payload, token);
    if (res) return res;
    // Daemon not running: spawn it detached and wait for the port.
    startDaemon();
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      // Any answer at all — even a rejection — means the port is live.
      if (await tryPost({ action: "status" }, token)) break;
      // Not up yet (Chromium first launch can take a while).
    }
  }
  return await tryPost(payload, token);
}

/** The daemon's JSON, or an in-band error object describing why there is none. */
function responseJson(res) {
  if (!res) {
    return JSON.stringify({
      ok: false,
      error: `browse daemon unreachable: ${lastTransportError ?? "no response"}`,
    });
  }
  if (res.status === 200) return res.body;
  if (res.status === 401 || res.status === 403) {
    return JSON.stringify({
      ok: false,
      error:
        `browse daemon refused the request (HTTP ${res.status}). It is probably ` +
        `running with a token from before ${TOKEN_FILE} was written; restart it ` +
        `with: pkill -f 'browse.mjs serve'`,
    });
  }
  return JSON.stringify({
    ok: false,
    error: `browse daemon returned HTTP ${res.status}`,
  });
}

async function runClient(b64) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    console.log(JSON.stringify({ ok: false, error: "invalid base64 request" }));
    return;
  }
  console.log(responseJson(await dispatch(payload)));
}

/**
 * Human-facing revoke: drop the shared login state without `rm -rf`-ing the
 * profile. `site` is an optional domain substring ("github.com"); omitted,
 * every cookie in the shared profile goes.
 */
async function runClear(site) {
  const res = await dispatch({ action: "clear", ...(site ? { site } : {}) });
  const raw = responseJson(res);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { ok: false, error: raw };
  }
  if (parsed.ok) {
    console.log(
      `Cleared ${parsed.cleared} cookie(s) for ${parsed.site === "all" ? "all sites" : parsed.site}.`,
    );
    return;
  }
  console.error(`Could not clear browsing state: ${parsed.error ?? "unknown error"}`);
  process.exitCode = 1;
}

function printUsage() {
  console.log(
    JSON.stringify({
      ok: false,
      error:
        "usage: browse.mjs <base64-json> | serve | --clear [site] " +
        "(--clear drops the shared profile's cookies, all sites or one domain substring)",
    }),
  );
}

// ------------------------------------------------------------------ main --

const arg = process.argv[2];
if (arg === "serve") {
  runDaemon();
} else if (arg === "--clear") {
  runClear(process.argv[3]);
} else if (arg && arg !== "--help" && arg !== "-h") {
  runClient(arg);
} else {
  printUsage();
}
