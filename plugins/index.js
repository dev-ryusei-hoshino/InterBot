import chalk from "chalk";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const plugins = new Map();
const pluginTracker = new Map();

const PLUGIN_STATE_PATH = path.join(__dirname, "..", "database", "plugin_state.json");

const log = {
  success: chalk.green("OK"),
  error: chalk.red("ERR"),
  info: chalk.blue("INFO"),
};

let error = false;

// ========== PLUGIN STATE (disabled list) ==========
function readPluginState() {
  try {
    if (!fs.existsSync(PLUGIN_STATE_PATH)) {
      return { disabled: [] };
    }
    const raw = fs.readFileSync(PLUGIN_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.disabled)) parsed.disabled = [];
    return parsed;
  } catch {
    return { disabled: [] };
  }
}

function isDisabled(file) {
  const state = readPluginState();
  return state.disabled.includes(file);
}

// ========== LOAD ONE ==========
async function loadPlugin(file, { silent = false } = {}) {
  const filePath = path.join(__dirname, file);

  if (!fs.existsSync(filePath)) {
    if (!silent) console.error(log.error, `File not found: ${file}`);
    return false;
  }

  const fileUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;

  try {
    const start = performance.now();
    const module = await import(fileUrl);
    const plugin = module.default;

    if (plugin && plugin.command) {
      const commands = Array.isArray(plugin.command)
        ? plugin.command
        : [plugin.command];

      // Remove old commands if this file was already loaded
      if (pluginTracker.has(file)) {
        const oldCommands = pluginTracker.get(file);
        oldCommands.forEach((cmd) => plugins.delete(cmd.toLowerCase()));
      }

      commands.forEach((cmd) => {
        plugins.set(cmd.toLowerCase(), plugin);
      });

      pluginTracker.set(file, commands);

      const ms = (performance.now() - start).toFixed(0);
      if (!silent) {
        console.log(
          log.success,
          `Loaded: ${plugin.name || file} (${ms}ms)`,
        );
      }
      return true;
    }

    if (!silent) {
      console.warn(log.error, `No valid export in ${file}`);
    }
    return false;
  } catch (err) {
    console.error(
      log.error,
      `Failed to load ${file}:`,
      chalk.yellow(err.message),
    );
    error = true;
    return false;
  }
}

// ========== LOAD ALL ==========
export async function loadPlugins() {
  const allFiles = fs
    .readdirSync(__dirname)
    .filter((file) => file.endsWith(".plugin.js"));

  const state = readPluginState();
  const disabled = state.disabled || [];

  const toLoad = allFiles.filter((f) => !disabled.includes(f));
  const skipped = allFiles.filter((f) => disabled.includes(f));

  if (skipped.length > 0) {
    console.log(
      log.info,
      `Skipping ${skipped.length} disabled plugin(s): ${skipped.join(", ")}`,
    );
  }

  await Promise.all(toLoad.map((file) => loadPlugin(file)));

  if (!error) console.clear();

  console.log(
    log.info,
    `Plugins loaded: ${plugins.size} command(s) from ${pluginTracker.size} file(s)`,
  );
}

// ========== LIVE UNLOAD (used by dashboard) ==========
export async function unloadPlugin(file) {
  if (!file) return { success: false, error: "No file specified" };

  if (!pluginTracker.has(file)) {
    return { success: false, error: "Plugin not loaded" };
  }

  const commands = pluginTracker.get(file);
  commands.forEach((cmd) => plugins.delete(cmd.toLowerCase()));
  pluginTracker.delete(file);

  console.log(log.info, `Unloaded: ${file} (${commands.join(", ")})`);
  return { success: true, commands };
}

// ========== LIVE LOAD ONE (used by dashboard) ==========
export async function loadSinglePlugin(file) {
  if (!file) return { success: false, error: "No file specified" };

  if (isDisabled(file)) {
    return { success: false, error: "Plugin is in disabled list" };
  }

  const ok = await loadPlugin(file);
  if (!ok) {
    return { success: false, error: "Failed to load plugin" };
  }

  return {
    success: true,
    commands: pluginTracker.get(file) || [],
  };
}

// ========== AUTO-RELOAD WATCHER ==========
const watchTimers = new Map();

function watchPluginsDir() {
  try {
    fs.watch(__dirname, { persistent: false }, (eventType, filename) => {
      if (filename && filename.endsWith(".plugin.js")) {
        if (watchTimers.has(filename)) clearTimeout(watchTimers.get(filename));

        watchTimers.set(
          filename,
          setTimeout(async () => {
            const filePath = path.join(__dirname, filename);

            if (!fs.existsSync(filePath)) {
              // File deleted
              if (pluginTracker.has(filename)) {
                const cmds = pluginTracker.get(filename);
                cmds.forEach((cmd) => plugins.delete(cmd.toLowerCase()));
                pluginTracker.delete(filename);
                console.log(
                  log.info,
                  `Plugin removed from memory: ${filename}`,
                );
              }
              return;
            }

            // Skip if disabled — dashboard controls it
            if (isDisabled(filename)) {
              console.log(
                log.info,
                `Change detected on disabled plugin ${filename}, skipping.`,
              );
              return;
            }

            console.log(
              log.info,
              `Change detected on ${chalk.yellow(filename)}, reloading...`,
            );
            await loadPlugin(filename);
          }, 100),
        );
      }
    });
  } catch (err) {
    console.warn(chalk.yellow("Failed to start file watcher:"), err.message);
  }
}

watchPluginsDir();

export { plugins, pluginTracker };