import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import Pino from "pino";
import readline from "readline";
import fs from "fs/promises";
import { existsSync } from "fs";
import chalk from "chalk";
import QRCode from "qrcode-terminal";
import axios from "axios";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { handleMessage } from "./handlers/message.js";
import { loadPlugins } from "./plugins/index.js";
import { startDashboard } from "./dashboard.js";
import config from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ========== CONSTANTS ==========
const PAIRING_TIMEOUT = config.pairing.timeout || 1200000;
const sessionDir = config.sessionDir || "session";
const MAX_BACKUPS = config.maxBackups || 5;
const MAX_CORRUPTED = 5;
const RECONNECT_BASE_DELAY = config.reconnect.baseDelay || 2000;
const RECONNECT_MAX_DELAY = config.reconnect.maxDelay || 60000;
const WATCHDOG_INTERVAL = 30000;
const WATCHDOG_DEAD_THRESHOLD = 90000;

const currentPath = path.join(sessionDir, "current");
const backupDir = path.join(sessionDir, "backups");
const corruptedDir = path.join(sessionDir, "corrupted");
const tempDir = path.join(sessionDir, "temp");

// ========== STATE ==========
const botStatus = {
  connected: false,
  pairingCode: null,
  pairingCodeExpiry: null,
  phoneNumber: null,
  user: null,
  plugins: 0,
  commands: 0,
  groups: 0,
  messagesReceived: 0,
  startTime: null,
  waitingForPairing: false,
  reconnectAttempts: 0,
  state: "OFFLINE",
  lastActivity: null,
  sessionBackups: 0,
  qrCode: null,
};

let conn = null;
let isConnecting = false;
let pairingTimer = null;
let pairingCodes = {};
let reconnectAttempts = 0;
let heartbeatInterval = null;
let watchdogInterval = null;
let lastHeartbeatSuccess = 0;
let isShuttingDown = false;
let terminalInputActive = false;

// Loop prevention
let consecutiveLoggedOut = 0;
let freshPairingMode = false;

// ========== PUBLIC IP ==========
async function getPublicIP() {
  const services = [
    { url: "https://api.ipify.org?format=json", pick: (d) => d.ip },
    { url: "https://ip-api.com/json/", pick: (d) => d.query },
    { url: "https://api.ip.sb/ip", pick: (d) => d.trim() },
    { url: "https://ifconfig.me/all.json", pick: (d) => d.ip_addr },
    { url: "https://icanhazip.com", pick: (d) => d.trim() },
    { url: "https://checkip.amazonaws.com", pick: (d) => d.trim() },
    { url: "https://api.my-ip.io/ip.json", pick: (d) => d.ip },
    { url: "https://ipinfo.io/json", pick: (d) => d.ip },
  ];

  for (const svc of services) {
    try {
      const res = await axios.get(svc.url, {
        timeout: 5000,
        headers: { "User-Agent": "curl/8.0" },
        responseType: "text",
      });
      let data = res.data;
      if (typeof data === "string" && data.trim().startsWith("{")) {
        try { data = JSON.parse(data); } catch {}
      }
      const ip = typeof data === "string" ? svc.pick(data) : svc.pick(data);
      if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip.trim())) return ip.trim();
    } catch {}
  }

  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (!iface.internal && iface.family === "IPv4") return iface.address;
      }
    }
  } catch {}

  return "localhost";
}

function getInternalIP() {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (!iface.internal && iface.family === "IPv4") return iface.address;
      }
    }
    return "127.0.0.1";
  } catch { return "127.0.0.1"; }
}

// ========== HELPERS ==========
function validatePhoneNumber(input) {
  const cleaned = String(input).replace(/[^0-9]/g, "");
  if (!cleaned) throw new Error("Phone number required.");
  if (cleaned.length < 7 || cleaned.length > 15) {
    throw new Error("Invalid phone number. Must be 7-15 digits.");
  }
  return cleaned;
}

function getReconnectDelay(attempt) {
  const delay = RECONNECT_BASE_DELAY * Math.pow(1.5, attempt);
  return Math.min(delay, RECONNECT_MAX_DELAY);
}

async function ensureDirs() {
  for (const dir of [sessionDir, backupDir, tempDir, corruptedDir, currentPath]) {
    if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
  }
}

// ========== SESSION MANAGEMENT ==========
async function manageSessions() {
  try {
    await ensureDirs();

    // Clean old temp
    const tempFiles = await fs.readdir(tempDir);
    for (const file of tempFiles) {
      const filePath = path.join(tempDir, file);
      const stats = await fs.stat(filePath);
      if (Date.now() - stats.mtimeMs > 3600000) {
        await fs.rm(filePath, { recursive: true, force: true });
      }
    }

    // Trim backups
    const backups = await fs.readdir(backupDir);
    if (backups.length > MAX_BACKUPS) {
      const sorted = await Promise.all(
        backups.map(async (f) => ({
          name: f,
          time: (await fs.stat(path.join(backupDir, f))).mtimeMs,
        })),
      );
      sorted.sort((a, b) => a.time - b.time);
      const toDelete = sorted.slice(0, sorted.length - MAX_BACKUPS);
      for (const item of toDelete) {
        await fs.rm(path.join(backupDir, item.name), { recursive: true, force: true });
      }
    }

    // Trim corrupted
    const corrupted = await fs.readdir(corruptedDir);
    if (corrupted.length > MAX_CORRUPTED) {
      const sorted = await Promise.all(
        corrupted.map(async (f) => ({
          name: f,
          time: (await fs.stat(path.join(corruptedDir, f))).mtimeMs,
        })),
      );
      sorted.sort((a, b) => a.time - b.time);
      const toDelete = sorted.slice(0, sorted.length - MAX_CORRUPTED);
      for (const item of toDelete) {
        await fs.rm(path.join(corruptedDir, item.name), { recursive: true, force: true });
      }
    }

    botStatus.sessionBackups = (await fs.readdir(backupDir)).length;
  } catch (error) {
    console.error(chalk.yellow("[SESSION] Management error:"), error.message);
  }
}

async function backupSession() {
  try {
    if (!existsSync(currentPath)) return;
    const files = await fs.readdir(currentPath);
    if (files.length === 0) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `session_${timestamp}`);
    await fs.cp(currentPath, backupPath, { recursive: true, force: true });

    const backups = await fs.readdir(backupDir);
    if (backups.length > MAX_BACKUPS) {
      const sorted = await Promise.all(
        backups.map(async (f) => ({
          name: f,
          time: (await fs.stat(path.join(backupDir, f))).mtimeMs,
        })),
      );
      sorted.sort((a, b) => a.time - b.time);
      const toDelete = sorted.slice(0, sorted.length - MAX_BACKUPS);
      for (const item of toDelete) {
        await fs.rm(path.join(backupDir, item.name), { recursive: true, force: true });
      }
    }

    botStatus.sessionBackups = (await fs.readdir(backupDir)).length;
    console.log(chalk.gray(`[BACKUP] Saved (${botStatus.sessionBackups}/${MAX_BACKUPS})`));
  } catch (error) {
    console.error(chalk.yellow("[BACKUP] Failed:"), error.message);
  }
}

async function moveToCorrupted(reason = "corrupted") {
  try {
    if (!existsSync(currentPath)) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(corruptedDir, `${reason}_${timestamp}`);
    await fs.rename(currentPath, target);
    console.log(chalk.gray(`[SESSION] -> corrupted/${reason}_${timestamp}`));
  } catch (e) {}
}

async function purgeCurrent() {
  try {
    if (existsSync(currentPath)) {
      await fs.rm(currentPath, { recursive: true, force: true });
    }
    await fs.mkdir(currentPath, { recursive: true });
  } catch (e) {}
}

async function purgeAllBackups() {
  try {
    if (!existsSync(backupDir)) return;
    const backups = await fs.readdir(backupDir);
    for (const b of backups) {
      await fs.rm(path.join(backupDir, b), { recursive: true, force: true });
    }
    botStatus.sessionBackups = 0;
    console.log(chalk.yellow("[SESSION] All backups purged"));
  } catch (e) {}
}

async function restoreSession() {
  try {
    if (!existsSync(backupDir)) return null;
    const backups = await fs.readdir(backupDir);
    if (backups.length === 0) return null;

    const sorted = await Promise.all(
      backups.map(async (f) => ({
        name: f,
        time: (await fs.stat(path.join(backupDir, f))).mtimeMs,
      })),
    );
    sorted.sort((a, b) => b.time - a.time);

    const candidate = sorted[0];
    const backupPath = path.join(backupDir, candidate.name);
    const files = await fs.readdir(backupPath);
    if (files.length === 0) return null;

    if (existsSync(currentPath)) {
      await fs.rm(currentPath, { recursive: true, force: true });
    }

    await fs.cp(backupPath, currentPath, { recursive: true, force: true });
    console.log(chalk.green(`[RESTORE] From ${candidate.name}`));
    return { path: currentPath, name: candidate.name };
  } catch (error) {
    console.error(chalk.yellow("[RESTORE] Failed:"), error.message);
    return null;
  }
}

// ========== PAIRING ==========
async function generatePairingCode(phoneNumber) {
  if (!conn) throw new Error("Bot not connected");
  const cleaned = validatePhoneNumber(phoneNumber);
  const code = await conn.requestPairingCode(cleaned);

  const codeData = {
    code,
    phoneNumber: cleaned,
    generatedAt: Date.now(),
    expiresAt: Date.now() + PAIRING_TIMEOUT,
    used: false,
  };

  pairingCodes[code] = codeData;
  botStatus.pairingCode = code;
  botStatus.pairingCodeExpiry = codeData.expiresAt;
  botStatus.phoneNumber = cleaned;
  botStatus.waitingForPairing = true;
  botStatus.state = "PAIRING";

  clearTimeout(pairingTimer);
  pairingTimer = setTimeout(() => {
    if (!botStatus.connected) {
      botStatus.waitingForPairing = false;
      botStatus.state = "OFFLINE";

      if (config.pairing.autoRenew && !isShuttingDown) {
        console.log(chalk.yellow("[PAIRING] Timeout. Auto-renewing..."));
        generatePairingCode(cleaned).catch(() => {});
      } else {
        console.log(chalk.yellow("[PAIRING] Timeout."));
        if (conn) { conn.end(); conn = null; }
        isConnecting = false;
        botStatus.pairingCode = null;
        startReconnect();
      }
    }
  }, PAIRING_TIMEOUT);

  return codeData;
}

async function askPhoneNumberTerminal() {
  if (terminalInputActive) return null;
  terminalInputActive = true;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const input = await new Promise((resolve) => {
      rl.question(
        `\n[PAIRING] Enter WhatsApp bot number (e.g., 15551234567):\n> `,
        resolve,
      );
    });
    return validatePhoneNumber(input);
  } finally {
    rl.close();
    terminalInputActive = false;
  }
}

// ========== RECONNECT ==========
async function startReconnect() {
  if (isShuttingDown) return;

  reconnectAttempts++;
  const delay = getReconnectDelay(reconnectAttempts);
  botStatus.reconnectAttempts = reconnectAttempts;
  botStatus.state = "RECONNECTING";

  console.log(chalk.yellow(`[RECONNECT] Attempt ${reconnectAttempts} in ${delay / 1000}s`));

  setTimeout(async () => {
    if (!isShuttingDown) await connectToWhatsApp();
  }, delay);
}

// ========== CONNECT ==========
async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    await manageSessions();

    // ========== FRESH PAIRING MODE ==========
    // If we're in fresh pairing mode, skip all session restoration
    if (freshPairingMode) {
      console.log(chalk.cyan("[PAIRING] Fresh pairing mode — starting clean session"));
      await purgeCurrent();
    } else {
      // Only try restore if current is empty
      try {
        if (existsSync(currentPath)) {
          const files = await fs.readdir(currentPath);
          if (files.length === 0) {
            await restoreSession();
          }
        }
      } catch (e) {}
    }

    const { state, saveCreds } = await useMultiFileAuthState(currentPath);
    const { version } = await fetchLatestBaileysVersion();

    conn = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: config.pairingWithQr,
      browser: Browsers.macOS("Safari"),
      logger: Pino({ level: "silent" }),
      markOnlineOnConnect: config.markOnlineOnConnect,
      syncFullHistory: false,
      patchHistory: false,
      generateHighQualityLinkPreview: false,
      syncProfilePictures: config.syncProfilePictures || true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 2000,
    });

    let pairingRequested = false;

    conn.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !conn.authState.creds.registered) {
        botStatus.qrCode = qr;
        if (!config.pairingWithQr && !pairingRequested) {
          pairingRequested = true;
          try {
            const phoneNumber = await askPhoneNumberTerminal();
            if (phoneNumber) {
              const codeData = await generatePairingCode(phoneNumber);
              console.log(chalk.yellow(`\n[PAIRING] Code: ${codeData.code}`));
              console.log(chalk.gray(`[PAIRING] Valid for ${PAIRING_TIMEOUT / 60000} min\n`));
              botStatus.state = "PAIRING";
            }
          } catch (err) {
            console.error(chalk.red("[PAIRING] Failed:"), err.message);
            pairingRequested = false;
            isConnecting = false;
            botStatus.state = "OFFLINE";
            startReconnect();
          }
        } else if (config.pairingWithQr) {
          QRCode.generate(qr, { small: true });
          console.log(chalk.yellow("\n[PAIRING] Scan QR above\n"));
          botStatus.state = "PAIRING";
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMessage = lastDisconnect?.error?.message || "Unknown";

        botStatus.connected = false;
        isConnecting = false;
        botStatus.state = "OFFLINE";
        clearInterval(heartbeatInterval);

        // ========== LOGGED OUT (401) — NO RESTORE, JUST PURGE ==========
        if (statusCode === DisconnectReason.loggedOut) {
          consecutiveLoggedOut++;
          console.log(chalk.red(`[SESSION] Logged out (${consecutiveLoggedOut} in a row)`));

          botStatus.pairingCode = null;
          botStatus.waitingForPairing = false;

          // Move current to corrupted
          await moveToCorrupted("loggedout");

          // ========== LOOP BREAKER ==========
          // If we've been logged out 1+ times, DROP ALL BACKUPS and request fresh pairing.
          // No more restoring — the creds are dead, and no backup will help.
          console.log(chalk.yellow("[SESSION] Purging all backups — credentials are dead"));
          await purgeAllBackups();
          await purgeCurrent();

          freshPairingMode = true;
          consecutiveLoggedOut = 0;

          // ========== ASK FOR FRESH PAIRING ==========
          if (!isShuttingDown) {
            botStatus.state = "REPAIRING";
            console.log(chalk.cyan("[PAIRING] Fresh pairing required"));
            setTimeout(async () => {
              try {
                const phoneNumber = await askPhoneNumberTerminal();
                if (phoneNumber) {
                  // Need a fresh socket for pairing
                  await connectToWhatsApp();
                  await new Promise(r => setTimeout(r, 3000));
                  if (conn) {
                    const codeData = await generatePairingCode(phoneNumber);
                    console.log(chalk.yellow(`\n[PAIRING] New code: ${codeData.code}\n`));
                    botStatus.state = "PAIRING";
                  }
                }
              } catch (err) {
                console.error(chalk.red("[PAIRING] Failed:"), err.message);
                botStatus.state = "OFFLINE";
                startReconnect();
              }
            }, 2000);
          }
          return;
        }

        // ========== BAD SESSION (corrupted, not logged out) ==========
        if (
          statusCode === DisconnectReason.badSession ||
          errorMessage.includes("corrupted") ||
          errorMessage.includes("Bad MAC")
        ) {
          console.log(chalk.red("[SESSION] Corrupted"));
          await moveToCorrupted("corrupted");

          const restored = await restoreSession();
          if (restored) {
            console.log(chalk.green(`[RESTORE] Trying ${restored.name}`));
            botStatus.state = "RECONNECTING";
            setTimeout(() => connectToWhatsApp(), 2000);
          } else {
            console.log(chalk.yellow("[RESTORE] No backups. Fresh pairing."));
            freshPairingMode = true;
            if (!isShuttingDown) {
              botStatus.state = "REPAIRING";
              setTimeout(async () => {
                try {
                  const phoneNumber = await askPhoneNumberTerminal();
                  if (phoneNumber) {
                    await connectToWhatsApp();
                    await new Promise(r => setTimeout(r, 3000));
                    if (conn) {
                      const codeData = await generatePairingCode(phoneNumber);
                      botStatus.state = "PAIRING";
                    }
                  }
                } catch (err) {
                  botStatus.state = "OFFLINE";
                  startReconnect();
                }
              }, 2000);
            }
          }
          return;
        }

        // ========== GENERIC DISCONNECT ==========
        console.log(chalk.yellow(`[CONN] Closed: ${errorMessage}`));
        if (!isShuttingDown) startReconnect();
      }

      if (connection === "open") {
        botStatus.connected = true;
        botStatus.waitingForPairing = false;
        botStatus.startTime = Date.now();
        botStatus.phoneNumber = conn.user?.id?.split(":")[0] || null;
        botStatus.user = conn.user;
        botStatus.state = "ONLINE";
        isConnecting = false;
        reconnectAttempts = 0;
        consecutiveLoggedOut = 0;
        freshPairingMode = false;
        lastHeartbeatSuccess = Date.now();
        botStatus.reconnectAttempts = 0;
        botStatus.lastActivity = Date.now();

        clearTimeout(pairingTimer);
        for (const key in pairingCodes) {
          if (!pairingCodes[key].used) pairingCodes[key].used = true;
        }

        await backupSession();

        console.log(chalk.green(`[CONN] Connected`));
        console.log(chalk.cyan(`[CONN] Phone: ${botStatus.phoneNumber}`));

        try {
          const chats = await conn.groupFetchAllParticipating();
          botStatus.groups = Object.keys(chats).length;
        } catch (e) {}

        startHeartbeat();
        startWatchdog();
      }
    });

    conn.ev.on("creds.update", async () => {
      await saveCreds();
      if (botStatus.connected) await backupSession();
    });

    conn.ev.on("messages.upsert", async ({ messages }) => {
      if (!botStatus.connected) return;
      for (const msg of messages) {
        botStatus.messagesReceived++;
        botStatus.lastActivity = Date.now();
        try {
          await handleMessage(conn, msg);
        } catch (error) {
          console.error("Message handler error:", error.message);
        }
      }
    });

    return conn;
  } catch (error) {
    console.error(chalk.red("[CONN] Error:"), error.message);
    isConnecting = false;
    botStatus.state = "OFFLINE";
    if (!isShuttingDown) startReconnect();
  }
}

// ========== HEARTBEAT ==========

// ========== HEARTBEAT ==========
function startHeartbeat() {
  clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(async () => {
    if (conn && botStatus.connected) {
      try {
        await conn.sendPresenceUpdate("available");
        botStatus.lastActivity = Date.now();
        lastHeartbeatSuccess = Date.now();
      } catch (error) {
        console.log(chalk.yellow(`[HEARTBEAT] Failed: ${error.message}`));
        if (!isShuttingDown) {
          botStatus.connected = false;
          botStatus.state = "OFFLINE";
          startReconnect();
        }
      }
    }
  }, 20000);
}

// ========== WATCHDOG ==========
function startWatchdog() {
  clearInterval(watchdogInterval);
  watchdogInterval = setInterval(() => {
    if (!botStatus.connected) return;
    const sinceLastBeat = Date.now() - lastHeartbeatSuccess;
    if (sinceLastBeat > WATCHDOG_DEAD_THRESHOLD) {
      console.log(chalk.red(`[WATCHDOG] Dead socket (${Math.round(sinceLastBeat / 1000)}s). Reconnecting.`));
      if (conn) {
        try { conn.end(new Error("watchdog")); } catch (e) {}
        conn = null;
      }
      botStatus.connected = false;
      botStatus.state = "OFFLINE";
      startReconnect();
    }
  }, WATCHDOG_INTERVAL);
}

// ========== STATUS UPDATE ==========
async function updateStatus() {
  setInterval(async () => {
    if (conn && botStatus.connected) {
      try {
        const { plugins } = await import("./plugins/index.js");
        botStatus.plugins = plugins?.size || 0;
        let cmdCount = 0;
        for (const [, plugin] of plugins || []) {
          const cmds = Array.isArray(plugin.command) ? plugin.command : [plugin.command];
          cmdCount += cmds.length;
        }
        botStatus.commands = cmdCount;
      } catch (e) {}
    }
  }, 30000);
}

// ========== START ==========
async function start() {
  console.log(chalk.cyan(`\nStarting ${config.bot.name} v${config.bot.ver}\n`));
  console.log(chalk.gray(`[CONFIG] Pairing timeout: ${PAIRING_TIMEOUT / 60000} min`));
  console.log(chalk.gray(`[CONFIG] Max backups: ${MAX_BACKUPS}`));
  console.log(chalk.gray(`[CONFIG] Watchdog: ${WATCHDOG_DEAD_THRESHOLD / 1000}s\n`));

  await ensureDirs();
  await loadPlugins();

  await startDashboard({
    botStatus,
    config,
    sessionDir,
    MAX_BACKUPS,
    PAIRING_TIMEOUT,
    getPublicIP,
    getInternalIP,
    generatePairingCode,
    connectToWhatsApp,
    startReconnect,
    backupSession,
    restoreSession,
    manageSessions,
    getConn: () => conn,
    setConn: (c) => { conn = c; },
    getIsConnecting: () => isConnecting,
    setIsConnecting: (v) => { isConnecting = v; },
    clearHeartbeat: () => clearInterval(heartbeatInterval),
    clearPairingTimer: () => clearTimeout(pairingTimer),
    setReconnectAttempts: (v) => { reconnectAttempts = v; },
    getReconnectAttempts: () => reconnectAttempts,
  });

  await connectToWhatsApp();
  await updateStatus();
}

// ========== SHUTDOWN ==========
process.on("SIGINT", async () => {
  isShuttingDown = true;
  console.log(chalk.yellow("\nShutting down..."));
  clearTimeout(pairingTimer);
  clearInterval(heartbeatInterval);
  clearInterval(watchdogInterval);
  if (conn) {
    try { await conn.logout(); } catch (e) {}
  }
  process.exit(0);
});

process.on("uncaughtException", async (error) => {
  console.error(chalk.red("[FATAL]"), error);
  if (!isShuttingDown) {
    botStatus.state = "OFFLINE";
    startReconnect();
  }
});

process.on("unhandledRejection", async (error) => {
  console.error(chalk.red("[FATAL] Unhandled:"), error);
});

start();