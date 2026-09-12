import packageFile from "./package.json" with { type: "json" };

export default {
  // ========== CORE ==========
  sessionDir: "session",
  maxBackups: 5,
  pairingWithQr: true,
  ignore_self: false,
  markOnlineOnConnect: true,
  syncFullHistory: false,
  syncProfilePictures: true,
  checkForUpdates: true,

  // ========== PAIRING ==========
  pairing: {
    timeout: 1200000,
    autoRenew: false,
  },

  // ========== RECONNECT ==========
  reconnect: {
    baseDelay: 2000,
    maxDelay: 60000,
  },

  // ========== DASHBOARD ==========
  dashboard: {
    // Set to true to enable maintenance mode (owner only)
    maintenance: false,

    // Empty = auto-detect (Pterodactyl / local)
    // Full URL = use as-is (Heroku / Render / custom domain)
    // Example: "https://interbot.herokuapp.com"
    // Example: "http://1.2.3.4:3056"
    hostlink: "https://irohasoft.web.id",

    // Setup key — user enters this on first dashboard visit to create password.
    // After setup is complete, this becomes inert (only password matters).
    key: "interbot2026",
  },

  // ========== BOT ==========
  bot: {
    name: "interbot",
    slog: "Automation at your command.",
    ver: packageFile.version,
    thumb:
      "https://i.ibb.co.com/0yJCNd0C/b1140d19-b147-4db9-8189-a0df99852a50.jpg",
    vid_thumb:
      "https://cdn.ornzora.eu.cc/7e92c9af-9e11-42f1-803c-8c23ecdb0ffe-upload-1786022115577.mp4",
    prefix: ["!", "$", "."],

    owner: {
      number: ["6283892508772", "6285657296405"],
    },
    premium: {
      number: [],
    },
    banned: {
      number: [],
    },
  },

  // ========== MESSAGES ==========
  mess: {
    owner: "Access denied. You are not the owner.",
    admin: "Access denied. You are not an admin of this group.",
    bot_not_admin:
      "This number needs to be an admin of this group to use this feature.",
    group: "Wrong place. This feature is only available in groups.",
    private: "Wrong place. Please do not use this feature here.",
    premium:
      "Access denied. You are not a premium user. Contact the owner to get premium access.",
    wait: "Please wait...",
    plugin_not_available:
      "Error: This plugin is not available right now. Please try again later.",
    maintenance: "Bot is under maintenance. Please try again later.",
  },
};

/*
|--------------------------------------------------------------------------
| Credits
|--------------------------------------------------------------------------
|
| interbot
| Built on Nozomi Base
|
| Original base developed by Ryushino
| https://github.com/dev-ryusei-hoshino/Nozomi-Base
|
|--------------------------------------------------------------------------
| Links
|--------------------------------------------------------------------------
|
| Repository  :
| https://github.com/dev-ryusei-hoshino/InterBot
|
|--------------------------------------------------------------------------
*/
