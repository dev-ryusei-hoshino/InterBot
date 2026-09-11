/**
 * lidResolver.js
 * Automatically resolves WhatsApp LIDs (@lid) to phone numbers (@s.whatsapp.net).
 *
 * Resolution strategy:
 *   1. In-memory cache (instant)
 *   2. Persistent disk cache (instant after first resolve)
 *   3. Baileys internal signalRepository.lidMapping (fast, no network)
 *   4. conn.onWhatsApp(lid) (network call, cached forever after)
 *
 * All results persist to database/lid_cache.json with a 30-day TTL.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_PATH = path.join(__dirname, "..", "database", "lid_cache.json");
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

// In-memory cache
const memCache = new Map();          // lid -> { phone, ts }
const unresolved = new Map();        // lid -> { ts } — negative cache

let cacheDirty = false;
let saveTimer = null;

// ========== LOAD / SAVE ==========
function loadCache() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return;
    const raw = fs.readFileSync(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const now = Date.now();

    for (const [lid, entry] of Object.entries(parsed || {})) {
      if (entry && entry.phone && now - entry.ts < CACHE_TTL) {
        memCache.set(lid, entry);
      }
    }

    console.log(`[LID] Loaded ${memCache.size} cached mappings`);
  } catch (e) {
    console.warn("[LID] Cache load failed:", e.message);
  }
}

function saveCache() {
  try {
    const obj = {};
    for (const [lid, entry] of memCache.entries()) {
      obj[lid] = entry;
    }
    fs.writeFileSync(CACHE_PATH, JSON.stringify(obj, null, 2), "utf8");
    cacheDirty = false;
  } catch (e) {
    console.warn("[LID] Cache save failed:", e.message);
  }
}

function scheduleSave() {
  cacheDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (cacheDirty) saveCache();
  }, 2000);
}

// ========== HELPERS ==========
function stripAt(id) {
  if (!id) return "";
  return String(id).split("@")[0].split(":")[0];
}

function normalizeLid(lid) {
  if (!lid) return "";
  const base = stripAt(lid);
  return base + "@lid";
}

// ========== RESOLVE ==========
export async function resolveLid(conn, lid) {
  if (!lid) return null;

  const key = normalizeLid(lid);
  const bare = stripAt(lid);

  // 1. Memory cache
  const cached = memCache.get(bare);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.phone;
  }

  // 2. Negative cache (recently failed) — don't retry for 24h
  const failed = unresolved.get(bare);
  if (failed && Date.now() - failed.ts < 24 * 60 * 60 * 1000) {
    return null;
  }

  // 3. Baileys internal mapping (no network)
  try {
    if (
      conn?.signalRepository?.lidMapping?.getPNForLID
    ) {
      const pn = await conn.signalRepository.lidMapping.getPNForLID(key);
      if (pn) {
        const phone = stripAt(pn);
        if (phone) {
          memCache.set(bare, { phone, ts: Date.now() });
          scheduleSave();
          return phone;
        }
      }
    }
  } catch (e) {
    // ignore, try next
  }

  // 4. Network lookup
  try {
    if (typeof conn?.onWhatsApp === "function") {
      const result = await conn.onWhatsApp(key);
      if (Array.isArray(result) && result[0]?.jid) {
        const phone = stripAt(result[0].jid);
        if (phone) {
          memCache.set(bare, { phone, ts: Date.now() });
          scheduleSave();
          return phone;
        }
      }
    }
  } catch (e) {
    // ignore, fallback
  }

  // 5. Fail — mark negative
  unresolved.set(bare, { ts: Date.now() });
  return null;
}

// ========== SYNC RESOLVE (cache only) ==========
export function resolveLidSync(lid) {
  if (!lid) return null;
  const bare = stripAt(lid);
  const cached = memCache.get(bare);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.phone;
  }
  return null;
}

// ========== STATS ==========
export function getLidStats() {
  return {
    cached: memCache.size,
    unresolved: unresolved.size,
    cachePath: CACHE_PATH,
  };
}

// ========== CLEAR ==========
export function clearLidCache() {
  memCache.clear();
  unresolved.clear();
  saveCache();
  console.log("[LID] Cache cleared");
}

// Auto-load at import time
loadCache();

export default {
  resolveLid,
  resolveLidSync,
  getLidStats,
  clearLidCache,
};