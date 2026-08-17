# Bots personal host

Turns a machine you own (a mini-PC on your desk) into a persistent session
host for Bots: bots run shell commands in per-bot workspaces there, and get
DOM-driven browsing through a real Chromium whose profile persists — log
into a site once and every bot's browsing stays signed in.

The app reaches this machine **only through your existing SSH server**. This
package opens no ports (the browse daemon binds 127.0.0.1 only).

## Load it onto the mini-PC

1. Copy this `host/` directory to the machine (any location only you can
   write to — your home directory is the obvious one):

   ```sh
   scp -r host/ you@minipc.local:~/bots-host-setup
   ```

2. On the mini-PC, make sure you have:
   - an SSH server running (`sudo systemctl enable --now ssh` on Debian/Ubuntu)
   - Node.js 20+ (`node --version`)

3. Provision (idempotent — re-run any time):

   ```sh
   cd ~/bots-host-setup && ./provision.sh
   ```

   This installs Playwright + Chromium, creates `~/.bots-host/{workspace,profile}`
   (owner-only, `0700`), and installs the browse entrypoint at
   `~/.bots-host/browse.mjs` together with its own copy of the dependencies.
   Re-running refreshes both and re-tightens the permissions on an older
   install; it also stops a browse daemon left running from the previous copy.

   Keep the setup directory somewhere only you can write — provisioning
   refuses to run from a world-writable location, since it executes what it
   finds there as you.

## Connect from your Mac

1. Key-based SSH must work without a password prompt:

   ```sh
   ssh-copy-id you@minipc.local          # once, if needed
   ssh you@minipc.local 'echo ok'        # must print "ok" with no prompt
   ```

2. In **Bots → Settings → Sessions**, choose **Personal host** and enter
   `you@minipc.local`.

## What lives where

| Path on the mini-PC              | What it is                                        |
| -------------------------------- | ------------------------------------------------- |
| `~/.bots-host/workspace/<botId>` | that bot's session workspace (synced back to Mac) |
| `~/.bots-host/profile`           | the persistent Chromium profile (logins live here)|
| `~/.bots-host/browse.mjs`        | browse entrypoint the app invokes over SSH        |
| `~/.bots-host/daemon-token`      | secret that authorises browse calls (`0600`)      |
| `~/.bots-host/daemon.log`        | browse daemon output (which display it adopted)   |

`~/.bots-host` is `0700` and the files in it are `0600`: on a machine with
other user accounts, nobody else can even traverse into the profile holding
your login cookies.

The browse daemon listens on `127.0.0.1:8377`, and a request only reaches
the browser if it is a `POST /` addressed to loopback, carries no `Origin`
header, and presents the secret from `~/.bots-host/daemon-token` in an
`x-bots-token` header. That file is created on the first browse call — you
never have to touch it. Delete it and the running daemon stops accepting
calls until you restart it (`pkill -f 'browse.mjs serve'`); the next call
then mints a fresh one.

## Signing sites out

Logins are always performed by **you** in the Chromium window on the host
(bots pause and ask — they never see credentials). Because the profile is
shared by every bot, clearing it is how you revoke that access:

```sh
node ~/.bots-host/browse.mjs --clear github.com   # cookies for one domain
node ~/.bots-host/browse.mjs --clear              # every cookie in the profile
```

The domain argument is a substring match, so `github.com` also covers
`gist.github.com`. The command starts the daemon if it is not already
running and prints how many cookies it dropped. For a full reset — history,
local storage, extensions, everything — delete `~/.bots-host/profile`.

A "Clear browsing state" button in the app's session settings is still to
come; until then the command above is the supported way.

## Uninstall

```sh
rm -rf ~/.bots-host ~/bots-host-setup
```
