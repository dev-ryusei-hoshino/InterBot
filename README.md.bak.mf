Here's the README with all emojis removed.

```markdown
<img src="https://files.catbox.moe/whibns.gif" alt="interbot" width="600">

# interbot

> A WhatsApp bot automation system with a built-in web dashboard.

> [!NOTE]
> This is an app automation system. Runs on Node.js, built on Baileys.

> [!TIP]
> You can copy anything — the code is under regular development.

> [!IMPORTANT]
> Keep the credit and contact us if you use this code as a template or base.

> [!WARNING]
> This system is under active development. Please disconnect auto-deploy on your hosting service/platforms during updates. You can take the code for the package on this if it is available.

> [!CAUTION]
> The system may not run sometimes due to updating the code without updating the `package.json` — if you are a developer, update it; if not, please wait.

> we
>> are
>>> Open
>>>> you can be a part
>>>>> of this
>>>>>> project
>>>>>>> thanks for your patience
>>>>>>>> © 2026 interbot

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Dashboard](#dashboard)
- [Permissions](#permissions)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [First Run](#first-run)
- [Project Structure](#project-structure)
- [Session Management](#session-management)
- [Stability and Recovery](#stability-and-recovery)
- [API Reference](#api-reference)
- [Credits](#credits)

---

## Overview

**interbot** is a WhatsApp bot system built on top of [Baileys](https://github.com/WhiskeySockets/Baileys). It pairs your WhatsApp account as a linked device, then responds to commands, runs plugins, and exposes a full web dashboard for management.

Key highlights:

- **Web dashboard** — pair, control, and monitor the bot without touching the terminal
- **Plugin system** — drop `.plugin.js` files and they load automatically
- **Live config editing** — bot name, slogan, prefix, users — all editable from the dashboard
- **Ban / premium / owner** — full permission tiers
- **LID auto-resolution** — works with WhatsApp's newer LID-based IDs
- **Session backups** — automatic rotation, restore, corruption recovery
- **Connection watchdog** — detects dead sockets and reconnects automatically

---

## Features

### Bot Core

- WhatsApp pairing via **pairing code** (default) or **QR code**
- Multi-prefix support — `!`, `$`, `.` (fully configurable)
- Command suggestions — "Did you mean ...?" using Levenshtein distance
- Auto-read messages (toggleable)
- Ignore own messages (toggleable)
- Group metadata handling — detects admins, bot-admin status
- LID to phone number resolution (auto, cached)
- Heartbeat every 20 seconds
- Watchdog timer — forces reconnect on dead sockets (90s threshold)

### Permissions

- **Owner** — full access, implicitly premium
- **Premium** — access when self mode is on
- **Banned** — silently ignored (no reply, no log)
- **Admin** (per group) — WhatsApp-level admin detection
- **Self mode** — restricts use to owner + premium
- **Maintenance mode** — restricts use to owner only
- **Per-plugin flags** — `owner_only`, `premium_only`, `admin_only`, `group_only`, `private_only`

### Plugins

- Auto-load from `plugins/*.plugin.js`
- Hot-reload on file change (watcher)
- Enable / disable from dashboard (instant, no restart)
- Delete from dashboard
- Reload all from dashboard
- Skipped when disabled (persisted in `database/plugin_state.json`)

### Session

- Multi-folder session structure: `current`, `backups`, `temp`, `corrupted`
- Automatic backup on every successful connect + on creds update
- Backup rotation (keep last 5 by default)
- Manual backup / restore / clean / reset from dashboard
- Corruption detection with automatic restore
- Logged-out detection (401) — purges backups and requests fresh pairing
- Corrupted folder capped at 5 (older auto-deleted)

### Dashboard

- 5-tab mobile-first UI
- Live console log stream (SSE)
- Pairing modal with countdown + copy
- Runtime toggles
- System metrics (RAM, CPU, platform, Node)
- Bot activity metrics (groups, commands, reconnects)
- Plugin management
- User management (owner / premium / banned)
- Bot identity editor (name, slogan, prefix)
- Change password
- Maintenance mode toggle

### Security

- Password-protected dashboard
- Setup key from `config.dashboard.key`
- Password hashed with SHA-256 + salt
- Signed session cookies (7-day TTL)
- HttpOnly + SameSite=Strict
- Setup rate limit — 5 attempts per 10 min per IP
- Timing-safe key comparison (`crypto.timingSafeEqual`)
- Config backup before every write

---

## Dashboard

The dashboard runs on the same process as the bot and is accessible at a URL shown in the console on startup.

**Tabs:**

| Tab | Contents |
|-----|----------|
| **Console** | Status, phone number, uptime, port, Link Phone, Disconnect, Reconnect, Session actions, Runtime toggles, Maintenance toggle, Live log stream |
| **Metrics** | RAM, CPU, platform, Node version, groups, commands, reconnects, last activity |
| **Plugins** | Full plugin list, toggle enable/disable, delete, reload |
| **Users** | Owner numbers, premium numbers, banned numbers — full CRUD |
| **Settings** | Bot name / slogan / prefix editor, change password, instance info, logout |

**Access:**
- On **Pterodactyl / local**: `http://<ip>:<port>`
- On **Heroku / Render / Railway**: uses the platform's public URL
- Manual override: set `config.dashboard.hostlink` to force a specific URL

**First visit:**
1. Dashboard detects no password, shows **setup screen**
2. Enter `config.dashboard.key` + create password
3. Logged in, cookie set (valid 7 days)

**Subsequent visits:**
- Cookie valid — straight to dashboard
- Cookie expired — login screen

**Forgot password:**
- Delete `database/dashboard.json`, restart, setup screen returns

---

## Permissions

### Permission tiers

```

Self OFF + Maintenance OFF:
Owner
Premium
Everyone else (subject to per-plugin rules)
Banned (silent)

Self ON:
Owner
Premium
Everyone else (silent)
Banned (silent)

Maintenance ON:
Owner only (gets maintenance message otherwise)
Everyone else (blocked)

```

### Adding users

From the dashboard **Users tab**:

- **Owner** — full access, always premium
- **Premium** — passes self mode
- **Banned** — silently ignored

Changes are written directly to `config.js` (with a `.bak` backup) and applied immediately.

### Per-plugin flags

Each plugin can set:

```js
export default {
  name: "My Plugin",
  command: ["mycmd"],
  owner_only: false,      // only owner
  premium_only: false,    // owner + premium
  admin_only: false,      // group admin or owner
  group_only: false,      // only in groups
  private_only: false,    // only in DMs
  async run(conn, m, context) { ... }
};
```

All set flags must pass for the plugin to run.

---

Configuration

All configuration is in config.js. This is the single source of truth.

```js
export default {
  // Core
  sessionDir: "session",
  maxBackups: 5,
  pairingWithQr: false,
  ignore_self: false,
  markOnlineOnConnect: true,
  syncFullHistory: false,
  syncProfilePictures: true,
  checkForUpdates: true,

  // Pairing
  pairing: {
    timeout: 1200000,       // 20 minutes
    autoRenew: true,
  },

  // Reconnect
  reconnect: {
    baseDelay: 2000,
    maxDelay: 60000,
  },

  // Dashboard
  dashboard: {
    maintenance: false,
    hostlink: "",           // empty = auto-detect
    key: "interbot2026",    // setup key
  },

  // Bot
  bot: {
    name: "interbot",
    slog: "Automation at your command.",
    prefix: ["!", "$", "."],
    owner: { number: [] },
    premium: { number: [] },
    banned: { number: [] },
  },

  // Messages
  mess: { ... },
};
```

Editable from dashboard

Field Path Method
Bot name bot.name Settings tab
Slogan bot.slog Settings tab
Prefix bot.prefix Settings tab
Owner numbers bot.owner.number Users tab
Premium numbers bot.premium.number Users tab
Banned numbers bot.banned.number Users tab
Maintenance dashboard.maintenance Console tab

Everything else requires manual editing of config.js.

Config write safety

When the dashboard writes to config.js:

1. Current file is backed up to config.js.bak
2. File is serialized with 2-space indentation
3. The header (comments before import) is preserved
4. The credits block (bottom of file) is preserved
5. In-memory config object is mutated (live reload)
6. If write fails, auto-restore from backup

---

Deployment

Pterodactyl

1. Upload files to the server
2. Set config.dashboard.hostlink (optional — auto-detect works too)
3. Start the server
4. Console shows the dashboard URL + setup key
5. Open the dashboard URL, enter setup key, create password

Heroku / Render / Railway / Fly

The bot auto-detects the platform's public URL via environment variables:

· RENDER_EXTERNAL_URL
· RAILWAY_PUBLIC_DOMAIN
· HEROKU_APP_NAME
· FLY_APP_NAME
· PUBLIC_URL

If any of those exist, the hostlink uses it. Otherwise, falls back to public IP + port.

Local

Runs on http://localhost:<port> by default. Public IP detection still works if you want external access.

Requirements

· Node.js 18+
· express (installed via npm install)
· Internet access for initial IP detection (optional — falls back gracefully)

---

First Run

1. Clone the repository
2. npm install
3. Set config.dashboard.key to your secret (default: interbot2026)
4. npm start
5. Console output:

```
Starting interbot v1.6.0
[CONFIG] Pairing timeout: 20 min
[CONFIG] Max backups: 5
[CONFIG] Watchdog: 90s

Dashboard:
  http://<host>:<port>
  Port: <port>
  Local: http://localhost:<port>

  Setup Key: interbot2026

  Open the dashboard and enter this key to create your password.
```

6. Open the dashboard URL
7. Enter the setup key + create a password
8. Click Link Phone in the Console tab
9. Enter your WhatsApp number
10. Copy the pairing code, enter it in WhatsApp under Linked Devices, Link with Phone Number
11. Bot connects

---

Project Structure

```
interbot/
├── index.js                    Entry point — bot lifecycle + dashboard bootstrap
├── config.js                   Single source of truth
├── config.js.bak               Auto-backup (created on first dashboard write)
├── dashboard.js                Dashboard backend (Express + auth + routes + SSE)
├── dash.html                   Dashboard UI
├── package.json
│
├── handlers/
│   └── message.js              Message handler (permissions + command dispatch)
│
├── plugins/
│   ├── index.js                Plugin loader (with disabled list + live unload)
│   └── *.plugin.js             Individual plugins
│
├── utils/
│   ├── runtime.js              Runtime state (self, auto_read, ignore_self)
│   ├── lidResolver.js          LID to phone number resolution + cache
│   ├── MessageBuilderV4.6.js
│   └── MessageBuilderV4.7.js
│
├── scrape/
│   └── uploader.js             File host integrations
│
├── database/                   Auto-created
│   ├── runtime.json            Runtime toggles
│   ├── dashboard.json          Auth (password hash + sessions)
│   ├── plugin_state.json       Disabled plugin list
│   └── lid_cache.json          LID to phone cache (30-day TTL)
│
├── session/                    Auto-created
│   ├── current/                Live WhatsApp session
│   ├── backups/                Rotated backups (max 5)
│   ├── temp/                   Temp files (auto-cleaned)
│   └── corrupted/              Failed sessions (last 5 kept)
│
└── node_modules/
```

---

Session Management

Folder layout

```
session/
├── current/                    live session (used by Baileys)
│   ├── creds.json
│   ├── app-state-sync-key-*.json
│   ├── pre-key-*.json
│   ├── sender-key-*.json
│   └── session-*.json
├── backups/                    rotating backups
│   └── session_<timestamp>/
├── temp/                       temp files, cleaned every hour
└── corrupted/                  failed sessions, last 5 kept
```

Automatic behaviors

Event Action
Successful connect Backup current/ to backups/session_<timestamp>
Creds update Same backup
401 logged out Move current/ to corrupted/loggedout_<ts>, purge all backups, request fresh pairing
Corrupted session Move to corrupted/corrupted_<ts>, restore newest backup
Backups > 5 Oldest deleted
Corrupted > 5 Oldest deleted
Temp files > 1h Deleted

Manual actions (from dashboard)

Action Effect
Backup Create a new backup now
Restore Restore newest backup into current/
Clean Clear temp folder, trim backups/corrupted
Reset Delete current/, keep backups

Important

· session/ must be persistent on hosting. If your host wipes it on restart, you will re-pair constantly.
· session/ must never be committed to Git — it contains your WhatsApp credentials.
· session/current/creds.json is equivalent to your WhatsApp password.

---

Stability and Recovery

Reconnect strategy

· Exponential backoff — 2s base, 1.5x multiplier, capped at 60s
· Max attempts — unlimited, but with stall detection

Watchdog

· Runs every 30 seconds
· If no successful heartbeat in 90 seconds, force reconnect
· Ends the socket, clears state, restarts connection

Heartbeat

· Every 20 seconds sends available presence
· If it fails, treat as disconnected, reconnect

Loop prevention

· 401 (logged out) — move to corrupted, purge all backups, request fresh pairing
· Never restores from backups on 401 (credentials are dead)
· consecutiveLoggedOut counter tracks repeated failures
· After purge, freshPairingMode set, clean session

Connection options (Baileys)

```js
connectTimeoutMs: 60000,
keepAliveIntervalMs: 30000,
retryRequestDelayMs: 2000,
```

---

API Reference

All routes require authentication (session cookie) unless noted.

Auth

Method Route Purpose
GET /api/auth/status Check setup + session state
POST /api/auth/setup First-time setup (key + password)
POST /api/auth/login Login with password
POST /api/auth/logout Destroy session
POST /api/auth/change-password Change dashboard password

Status

Method Route Purpose
GET /api/status Full bot status
GET /api/system System metrics (RAM, CPU, etc.)

Pairing and Connection

Method Route Purpose
POST /api/pair Generate pairing code
POST /api/disconnect Logout from WhatsApp
POST /api/reconnect Restart connection
POST /api/clean Clean session files

Session

Method Route Purpose
POST /api/session/backup Create backup
POST /api/session/restore Restore newest backup
POST /api/session/delete Delete current session

Runtime

Method Route Purpose
GET /api/runtime Read runtime toggles
POST /api/runtime Set a runtime toggle

Users

Method Route Purpose
GET /api/users List owner / premium / banned
POST /api/users/add Add a number
POST /api/users/remove Remove a number

Bot Identity

Method Route Purpose
GET /api/bot-identity Read name / slogan / prefix
POST /api/bot-identity Update name / slogan / prefix

Maintenance

Method Route Purpose
POST /api/maintenance Toggle maintenance mode

Plugins

Method Route Purpose
GET /api/plugins List all plugins
POST /api/plugins/toggle Enable / disable
POST /api/plugins/delete Delete plugin file
POST /api/plugins/reload Reload all plugins

Logs

Method Route Purpose
GET /api/logs/stream Server-Sent Events log stream

---

Credits

interbot is built on Nozomi Base.

· Original base: github.com/dev-ryusei-hoshino/Nozomi-Base
· Current repo: github.com/dev-ryusei-hoshino/InterBot

Uses:

· Baileys — WhatsApp Web API
· Express — Dashboard server
· Sharp — Image processing
· FFmpeg — Video processing

© 2026 interbot
