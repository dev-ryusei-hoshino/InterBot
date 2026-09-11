/**
 * dashboard.js
 * Self-contained dashboard for interbot.
 * Handles: Express server, auth, all API routes, SSE log streaming, config editing.
 */

import express from "express";
import path from "path";
import fs from "fs";
import fsPromises from "fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import crypto from "crypto";
import os from "os";
import net from "net";
import chalk from "chalk";
import { unloadPlugin, loadSinglePlugin, loadPlugins } from "./plugins/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========== CONSTANTS ==========
const DB_DIR = path.join(__dirname, "database");
const DASHBOARD_DB = path.join(DB_DIR, "dashboard.json");
const RUNTIME_DB = path.join(DB_DIR, "runtime.json");
const PLUGIN_STATE_DB = path.join(DB_DIR, "plugin_state.json");
const CONFIG_PATH = path.join(__dirname, "config.js");
const CONFIG_BACKUP = path.join(__dirname, "config.js.bak");

const SESSION_COOKIE = "interbot_session";
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

const SETUP_ATTEMPT_LIMIT = 5;
const SETUP_WINDOW_MS = 10 * 60 * 1000;

const MAX_LOG_BUFFER = 500;

// ========== LOG BUFFER (SSE) ==========
const logBuffer = [];
const sseClients = new Set();

function pushLog(line, level = "info") {
  const entry = { line, level, ts: Date.now() };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
  for (const client of sseClients) {
    try {
      client.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch (e) {}
  }
}

function hijackConsole() {
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.log = (...args) => {
    origLog(...args);
    pushLog(args.map(String).join(" "), "info");
  };
  console.error = (...args) => {
    origErr(...args);
    pushLog(args.map(String).join(" "), "error");
  };
  console.warn = (...args) => {
    origWarn(...args);
    pushLog(args.map(String).join(" "), "warn");
  };
}

// ========== FILE HELPERS ==========
function ensureDb() {
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });

  if (!existsSync(RUNTIME_DB)) {
    writeFileSync(
      RUNTIME_DB,
      JSON.stringify({ self: false, auto_read: true, ignore_self: false }, null, 2),
    );
  }
  if (!existsSync(PLUGIN_STATE_DB)) {
    writeFileSync(PLUGIN_STATE_DB, JSON.stringify({ disabled: [] }, null, 2));
  }
}

function readJson(file, fallback = {}) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

// ========== AUTH ==========
function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(salt + password).digest("hex");
}

function loadAuth() {
  return readJson(DASHBOARD_DB, null);
}

function saveAuth(data) {
  writeJson(DASHBOARD_DB, data);
}

function isSetupComplete() {
  const auth = loadAuth();
  return auth && auth.passwordHash;
}

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  const auth = loadAuth() || {};
  auth.sessions = auth.sessions || {};
  auth.sessions[token] = {
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL,
  };
  saveAuth(auth);
  return token;
}

function validateSession(token) {
  if (!token) return false;
  const auth = loadAuth();
  if (!auth || !auth.sessions || !auth.sessions[token]) return false;
  const session = auth.sessions[token];
  if (Date.now() > session.expiresAt) {
    delete auth.sessions[token];
    saveAuth(auth);
    return false;
  }
  return true;
}

function destroySession(token) {
  const auth = loadAuth();
  if (auth && auth.sessions && auth.sessions[token]) {
    delete auth.sessions[token];
    saveAuth(auth);
  }
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE] || req.headers["x-session-token"];
  if (validateSession(token)) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || "";
  for (const pair of header.split(";")) {
    const [k, ...v] = pair.trim().split("=");
    if (k) cookies[k] = decodeURIComponent(v.join("="));
  }
  return cookies;
}

// ========== RATE LIMIT SETUP ATTEMPTS ==========
let setupAttempts = [];

function recordSetupAttempt(ip) {
  const now = Date.now();
  setupAttempts = setupAttempts.filter((a) => now - a.ts < SETUP_WINDOW_MS);
  setupAttempts.push({ ip, ts: now });
}

function getSetupAttemptsForIp(ip) {
  const now = Date.now();
  return setupAttempts.filter((a) => a.ip === ip && now - a.ts < SETUP_WINDOW_MS);
}

// ========== CONFIG WRITER ==========
function serializeConfig(cfg) {
  return JSON.stringify(cfg, null, 2);
}

function writeConfigFile(newConfig) {
  try {
    if (existsSync(CONFIG_PATH)) {
      const current = readFileSync(CONFIG_PATH, "utf8");
      writeFileSync(CONFIG_BACKUP, current, "utf8");
    }

    // Extract the header comment (before `import`) to preserve context
    let header = "";
    try {
      const current = readFileSync(CONFIG_PATH, "utf8");
      const importIdx = current.indexOf("import packageFile");
      if (importIdx > 0) header = current.slice(0, importIdx);
    } catch {}

    // Extract credits block (after `export default { ... }`)
    let credits = "";
    try {
      const current = readFileSync(CONFIG_PATH, "utf8");
      const creditsIdx = current.lastIndexOf("/*");
      if (creditsIdx > 0) credits = current.slice(creditsIdx);
    } catch {}

    const body = `import packageFile from "./package.json" with { type: "json" };\n\nexport default ${serializeConfig(newConfig)};\n\n`;

    writeFileSync(CONFIG_PATH, header + body + credits, "utf8");
    return true;
  } catch (err) {
    console.error("Config write failed:", err.message);
    // Attempt restore
    try {
      if (existsSync(CONFIG_BACKUP)) {
        const backup = readFileSync(CONFIG_BACKUP, "utf8");
        writeFileSync(CONFIG_PATH, backup, "utf8");
      }
    } catch {}
    return false;
  }
}

async function reloadConfigInMemory(config) {
  try {
    const fresh = await import(`./config.js?t=${Date.now()}`);
    // Deep merge into existing object reference
    deepMerge(config, fresh.default);
    return true;
  } catch (err) {
    console.error("Config reload failed:", err.message);
    return false;
  }
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key])
    ) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

// ========== HOSTLINK ==========
async function resolveHostlink(config, detectedPort, getPublicIP) {
  const configured = config?.dashboard?.hostlink;
  if (configured && configured.trim()) {
    return configured.trim().replace(/\/+$/, "");
  }

  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  if (process.env.RAILWAY_PUBLIC_DOMAIN)
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.HEROKU_APP_NAME)
    return `https://${process.env.HEROKU_APP_NAME}.herokuapp.com`;
  if (process.env.FLY_APP_NAME)
    return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;

  if (
    process.env.PTERODACTYL ||
    process.env.SERVER_MEMORY ||
    process.env.P_SERVER_IP
  ) {
    const ip = process.env.P_SERVER_IP || (await getPublicIP());
    return `http://${ip}:${detectedPort}`;
  }

  try {
    const ip = await getPublicIP();
    if (ip && ip !== "localhost") return `http://${ip}:${detectedPort}`;
  } catch {}

  return `http://localhost:${detectedPort}`;
}

// ========== PORT ==========
async function getAvailablePort(startPort = 3000) {
  const envPort = process.env.PORT || process.env.SERVER_PORT;
  if (envPort) {
    const port = parseInt(envPort);
    if (!isNaN(port) && port > 0 && port < 65536) return port;
  }

  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startPort, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", () => resolve(getAvailablePort(startPort + 1)));
  });
}

// ========== SYSTEM METRICS ==========
function getSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpus = os.cpus();

  let cpuLoad = 0;
  if (cpus.length > 0) {
    const total = cpus.reduce((sum, cpu) => {
      const t = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      return sum + (1 - cpu.times.idle / t);
    }, 0);
    cpuLoad = (total / cpus.length) * 100;
  }

  return {
    ram: {
      total: Math.round(totalMem / 1024 / 1024),
      used: Math.round(usedMem / 1024 / 1024),
      free: Math.round(freeMem / 1024 / 1024),
      percent: ((usedMem / totalMem) * 100).toFixed(1),
    },
    cpu: {
      cores: cpus.length,
      load: cpuLoad.toFixed(1),
      model: cpus[0]?.model || "Unknown",
    },
    platform: os.platform(),
    arch: os.arch(),
    node: process.version,
    uptime: Math.round(process.uptime()),
  };
}

// ========== MAIN ==========
export async function startDashboard(deps) {
  const {
    botStatus,
    config,
    sessionDir,
    MAX_BACKUPS,
    PAIRING_TIMEOUT,
    getPublicIP,
    generatePairingCode,
    connectToWhatsApp,
    backupSession,
    restoreSession,
    manageSessions,
    getConn,
    setConn,
    getIsConnecting,
    setIsConnecting,
    clearHeartbeat,
    clearPairingTimer,
    setReconnectAttempts,
  } = deps;

  ensureDb();
  hijackConsole();

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req, res, next) => {
    req.cookies = parseCookies(req);
    next();
  });

  // ========== AUTH ROUTES ==========
  app.get("/api/auth/status", (req, res) => {
    const setup = isSetupComplete();
    const token = req.cookies[SESSION_COOKIE];
    const authed = validateSession(token);
    res.json({ setup, authed });
  });

  app.post("/api/auth/setup", (req, res) => {
    if (isSetupComplete()) {
      return res.status(400).json({ error: "Setup already complete" });
    }

    const ip = req.ip || "unknown";
    const attempts = getSetupAttemptsForIp(ip);
    if (attempts.length >= SETUP_ATTEMPT_LIMIT) {
      return res.status(429).json({
        error: "Too many attempts. Try again later.",
      });
    }

    const { key, password, confirm } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    if (password !== confirm) {
      return res.status(400).json({ error: "Passwords do not match" });
    }

    const expectedKey = config?.dashboard?.key;
    if (!expectedKey) {
      return res.status(500).json({ error: "Setup key not configured" });
    }

    recordSetupAttempt(ip);

    // Constant-time compare
    const given = Buffer.from(String(key || ""));
    const expected = Buffer.from(String(expectedKey));
    if (
      given.length !== expected.length ||
      !crypto.timingSafeEqual(given, expected)
    ) {
      return res.status(401).json({ error: "Invalid setup key" });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);

    saveAuth({
      passwordHash,
      salt,
      sessions: {},
      createdAt: Date.now(),
    });

    setupAttempts = [];

    const sessionToken = createSession();
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`,
    );
    res.json({ success: true });
  });

  app.post("/api/auth/login", (req, res) => {
    const { password } = req.body;
    const auth = loadAuth();

    if (!auth || !auth.passwordHash) {
      return res.status(400).json({ error: "Setup not complete" });
    }
    if (!password) {
      return res.status(400).json({ error: "Password required" });
    }

    const attemptHash = hashPassword(password, auth.salt);
    if (attemptHash !== auth.passwordHash) {
      auth.failedLogins = auth.failedLogins || [];
      auth.failedLogins.push({ ip: req.ip, ts: Date.now() });
      if (auth.failedLogins.length > 50) auth.failedLogins.shift();
      saveAuth(auth);
      return res.status(401).json({ error: "Invalid password" });
    }

    const sessionToken = createSession();
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}`,
    );
    res.json({ success: true });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = req.cookies[SESSION_COOKIE];
    destroySession(token);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    res.json({ success: true });
  });

  app.post("/api/auth/change-password", authMiddleware, (req, res) => {
    const { current, next, confirm } = req.body;
    const auth = loadAuth();

    if (hashPassword(current, auth.salt) !== auth.passwordHash) {
      return res.status(401).json({ error: "Current password incorrect" });
    }
    if (!next || next.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters" });
    }
    if (next !== confirm) {
      return res.status(400).json({ error: "Passwords do not match" });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    auth.passwordHash = hashPassword(next, salt);
    auth.salt = salt;
    auth.sessions = {};
    saveAuth(auth);

    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    res.json({ success: true });
  });

  // ========== STATUS ==========
  let cachedHostlink = "http://localhost";
  let cachedPort = 0;

  app.get("/api/status", authMiddleware, (req, res) => {
    const uptime = botStatus.startTime
      ? Math.floor((Date.now() - botStatus.startTime) / 1000)
      : 0;
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;

    res.json({
      connected: botStatus.connected,
      phoneNumber: botStatus.phoneNumber,
      uptime,
      uptimeFormatted: `${h}h ${m}m ${s}s`,
      groups: botStatus.groups || 0,
      plugins: botStatus.plugins || 0,
      commands: botStatus.commands || 0,
      messagesReceived: botStatus.messagesReceived || 0,
      state: botStatus.state,
      reconnectAttempts: botStatus.reconnectAttempts || 0,
      sessionBackups: botStatus.sessionBackups || 0,
      lastActivity: botStatus.lastActivity,
      pairingCode: botStatus.pairingCode,
      waitingForPairing: botStatus.waitingForPairing,
      isConnecting: getIsConnecting(),
      botName: config.bot.name,
      botVersion: config.bot.ver,
      hostlink: cachedHostlink,
      port: cachedPort,
      maxBackups: MAX_BACKUPS,
      pairingTimeout: PAIRING_TIMEOUT / 60000,
      maintenance: config.dashboard?.maintenance === true,
    });
  });

  // ========== PAIRING ==========
  app.post("/api/pair", authMiddleware, async (req, res) => {
    try {
      const { phoneNumber } = req.body;
      if (!phoneNumber) {
        return res.status(400).json({ success: false, error: "Phone number required" });
      }

      if (botStatus.connected) {
        return res
          .status(400)
          .json({ success: false, error: "Bot already connected. Disconnect first." });
      }

      if (botStatus.waitingForPairing) {
        const remaining = Math.floor((botStatus.pairingCodeExpiry - Date.now()) / 1000);
        if (remaining > 0) {
          return res.status(400).json({
            success: false,
            error: `Already waiting. Code valid for ${Math.floor(remaining / 60)} more minutes.`,
          });
        }
      }

      let conn = getConn();
      if (!conn) {
        if (!getIsConnecting()) {
          setIsConnecting(true);
          connectToWhatsApp();
          let attempts = 0;
          while (!getConn() && attempts < 15) {
            await new Promise((r) => setTimeout(r, 1000));
            attempts++;
          }
          conn = getConn();
          if (!conn) {
            setIsConnecting(false);
            return res.status(400).json({ success: false, error: "Failed to open connection." });
          }
        } else {
          let attempts = 0;
          while (getIsConnecting() && attempts < 20) {
            await new Promise((r) => setTimeout(r, 1000));
            attempts++;
          }
          conn = getConn();
        }
      }

      const codeData = await generatePairingCode(phoneNumber);
      console.log(`Dashboard pairing for ${phoneNumber} -> ${codeData.code}`);

      res.json({
        success: true,
        pairingCode: codeData.code,
        phoneNumber,
        expiresIn: PAIRING_TIMEOUT / 1000,
        expiresAt: codeData.expiresAt,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ========== CONNECTION CONTROL ==========
  app.post("/api/disconnect", authMiddleware, async (req, res) => {
    try {
      const conn = getConn();
      if (conn) {
        try {
          await conn.logout();
        } catch (e) {}
        setConn(null);
      }
      botStatus.connected = false;
      botStatus.pairingCode = null;
      botStatus.waitingForPairing = false;
      botStatus.state = "OFFLINE";
      setIsConnecting(false);
      clearPairingTimer();
      clearHeartbeat();
      console.log("Bot disconnected via dashboard");
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/reconnect", authMiddleware, async (req, res) => {
    try {
      const conn = getConn();
      if (conn) {
        try {
          await conn.logout();
        } catch (e) {}
        setConn(null);
      }
      botStatus.connected = false;
      botStatus.waitingForPairing = false;
      botStatus.pairingCode = null;
      botStatus.state = "RECONNECTING";
      setIsConnecting(false);
      clearPairingTimer();
      clearHeartbeat();
      setReconnectAttempts(0);
      setTimeout(() => connectToWhatsApp(), 1000);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/clean", authMiddleware, async (req, res) => {
    try {
      await manageSessions();
      const tempDir = path.join(sessionDir, "temp");
      if (existsSync(tempDir)) {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
        await fsPromises.mkdir(tempDir, { recursive: true });
      }
      res.json({ success: true, backups: botStatus.sessionBackups });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ========== SESSION ==========
  app.post("/api/session/backup", authMiddleware, async (req, res) => {
    try {
      await backupSession();
      res.json({ success: true, backups: botStatus.sessionBackups });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/session/restore", authMiddleware, async (req, res) => {
    try {
      const restored = await restoreSession();
      if (!restored) return res.status(400).json({ success: false, error: "No backup found" });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/session/delete", authMiddleware, async (req, res) => {
    try {
      const conn = getConn();
      if (conn) {
        try {
          await conn.logout();
        } catch (e) {}
        setConn(null);
      }
      const currentPath = path.join(sessionDir, "current");
      if (existsSync(currentPath)) {
        await fsPromises.rm(currentPath, { recursive: true, force: true });
      }
      botStatus.connected = false;
      botStatus.pairingCode = null;
      botStatus.waitingForPairing = false;
      botStatus.state = "OFFLINE";
      botStatus.phoneNumber = null;
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ========== RUNTIME ==========
  app.get("/api/runtime", authMiddleware, (req, res) => {
    res.json(readJson(RUNTIME_DB, {}));
  });

  app.post("/api/runtime", authMiddleware, (req, res) => {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: "Key required" });
    const runtime = readJson(RUNTIME_DB, {});
    runtime[key] = value;
    writeJson(RUNTIME_DB, runtime);
    console.log(`Runtime: ${key} = ${value}`);
    res.json({ success: true, runtime });
  });

  // ========== USERS (config.js backed) ==========
  app.get("/api/users", authMiddleware, (req, res) => {
    res.json({
      owner: config.bot.owner?.number || [],
      premium: config.bot.premium?.number || [],
      banned: config.bot.banned?.number || [],
    });
  });

  app.post("/api/users/add", authMiddleware, async (req, res) => {
    const { type, value } = req.body;
    if (!["owner", "premium", "banned"].includes(type)) {
      return res.status(400).json({ error: "Invalid type" });
    }
    if (!value) return res.status(400).json({ error: "Value required" });

    const list = config.bot[type]?.number || [];
    if (list.includes(value)) {
      return res.status(400).json({ error: "Already in list" });
    }
    list.push(value);
    config.bot[type].number = list;

    const ok = writeConfigFile(config);
    if (!ok) return res.status(500).json({ error: "Failed to write config" });

    await reloadConfigInMemory(config);

    console.log(`Added ${type}: ${value}`);
    res.json({
      success: true,
      owner: config.bot.owner.number,
      premium: config.bot.premium.number,
      banned: config.bot.banned.number,
    });
  });

  app.post("/api/users/remove", authMiddleware, async (req, res) => {
    const { type, value } = req.body;
    if (!["owner", "premium", "banned"].includes(type)) {
      return res.status(400).json({ error: "Invalid type" });
    }

    const list = config.bot[type]?.number || [];
    const filtered = list.filter((v) => v !== value);
    config.bot[type].number = filtered;

    const ok = writeConfigFile(config);
    if (!ok) return res.status(500).json({ error: "Failed to write config" });

    await reloadConfigInMemory(config);

    console.log(`Removed ${type}: ${value}`);
    res.json({
      success: true,
      owner: config.bot.owner.number,
      premium: config.bot.premium.number,
      banned: config.bot.banned.number,
    });
  });

  // ========== BOT IDENTITY ==========
  app.get("/api/bot-identity", authMiddleware, (req, res) => {
    res.json({
      name: config.bot.name,
      slog: config.bot.slog,
      prefix: config.bot.prefix,
    });
  });

  app.post("/api/bot-identity", authMiddleware, async (req, res) => {
    const { name, slog, prefix } = req.body;

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "Invalid name" });
      }
      config.bot.name = name.trim();
    }

    if (slog !== undefined) {
      if (typeof slog !== "string") {
        return res.status(400).json({ error: "Invalid slogan" });
      }
      config.bot.slog = slog;
    }

    if (prefix !== undefined) {
      const arr = Array.isArray(prefix)
        ? prefix
        : String(prefix).split(/\s+/).filter(Boolean);
      if (arr.length === 0) {
        return res.status(400).json({ error: "At least one prefix required" });
      }
      config.bot.prefix = arr;
    }

    const ok = writeConfigFile(config);
    if (!ok) return res.status(500).json({ error: "Failed to write config" });

    await reloadConfigInMemory(config);

    console.log(`Bot identity updated: ${config.bot.name}`);
    res.json({
      success: true,
      name: config.bot.name,
      slog: config.bot.slog,
      prefix: config.bot.prefix,
    });
  });

  // ========== MAINTENANCE ==========
  app.post("/api/maintenance", authMiddleware, async (req, res) => {
    const { enabled } = req.body;
    config.dashboard.maintenance = !!enabled;

    const ok = writeConfigFile(config);
    if (!ok) return res.status(500).json({ error: "Failed to write config" });

    await reloadConfigInMemory(config);

    console.log(`Maintenance: ${config.dashboard.maintenance}`);
    res.json({ success: true, maintenance: config.dashboard.maintenance });
  });

  // ========== PLUGINS ==========
  app.get("/api/plugins", authMiddleware, async (req, res) => {
    try {
      const pluginDir = path.join(__dirname, "plugins");
      const files = (await fsPromises.readdir(pluginDir)).filter((f) =>
        f.endsWith(".plugin.js"),
      );
      const state = readJson(PLUGIN_STATE_DB, { disabled: [] });

      const { plugins, pluginTracker } = await import("./plugins/index.js");

      const list = files.map((file) => {
        const disabled = state.disabled.includes(file);
        const commands = pluginTracker.has(file) ? pluginTracker.get(file) : [];
        const loaded = pluginTracker.has(file);
        return { file, disabled, loaded, commands };
      });

      res.json({ plugins: list, disabled: state.disabled });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/plugins/toggle", authMiddleware, async (req, res) => {
    const { file, disabled } = req.body;
    if (!file) return res.status(400).json({ error: "File required" });

    const state = readJson(PLUGIN_STATE_DB, { disabled: [] });

    // Persist first
    if (disabled) {
      if (!state.disabled.includes(file)) state.disabled.push(file);
    } else {
      state.disabled = state.disabled.filter((f) => f !== file);
    }
    writeJson(PLUGIN_STATE_DB, state);

    // Live action
    let result;
    if (disabled) {
      result = await unloadPlugin(file);
      if (!result.success) {
        console.warn(`Unload warning for ${file}: ${result.error}`);
      }
      console.log(`Plugin disabled: ${file}`);
      return res.json({ success: true, disabled: state.disabled });
    } else {
      result = await loadSinglePlugin(file);
      if (!result.success) {
        console.error(`Load failed for ${file}: ${result.error}`);
        return res.status(500).json({ error: result.error });
      }
      console.log(`Plugin enabled: ${file}`);
      return res.json({ success: true, disabled: state.disabled, commands: result.commands });
    }
  });

  app.post("/api/plugins/delete", authMiddleware, async (req, res) => {
    const { file } = req.body;
    if (!file || !file.endsWith(".plugin.js")) {
      return res.status(400).json({ error: "Invalid file" });
    }
    const filePath = path.join(__dirname, "plugins", file);
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: "Plugin not found" });
    }
    await unloadPlugin(file);
    await fsPromises.rm(filePath);
    console.log(`Plugin deleted: ${file}`);
    res.json({ success: true });
  });

  app.post("/api/plugins/reload", authMiddleware, async (req, res) => {
    try {
      await loadPlugins();
      console.log("Plugins reloaded");
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ========== LOGS (SSE) ==========
  app.get("/api/logs/stream", authMiddleware, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    for (const entry of logBuffer.slice(-50)) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  });

  // ========== SYSTEM ==========
  app.get("/api/system", authMiddleware, (req, res) => {
    res.json(getSystemMetrics());
  });

  // ========== SERVE DASHBOARD ==========
  app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "dash.html"));
  });

  app.get("/dashboard", (req, res) => {
    res.sendFile(path.join(__dirname, "dash.html"));
  });

  // ========== START ==========
  const port = await getAvailablePort();
  const hostlink = await resolveHostlink(config, port, getPublicIP);
  cachedPort = port;
  cachedHostlink = hostlink;

  app.listen(port, "0.0.0.0", () => {
    console.log(chalk.cyan(`\nDashboard:`));
    console.log(chalk.green(`  ${hostlink}`));
    console.log(chalk.gray(`  Port: ${port}`));
    console.log(chalk.gray(`  Local: http://localhost:${port}\n`));

    if (!isSetupComplete()) {
      console.log(chalk.yellow.bold(`  Setup Key: ${config.dashboard.key}\n`));
      console.log(chalk.gray(`  Open the dashboard and enter this key to create your password.\n`));
    }
  });

  return { port, hostlink };
}

export default { startDashboard };