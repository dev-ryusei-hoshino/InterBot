import config from "../config.js";
import { plugins } from "../plugins/index.js";
import { getRuntimeValue } from "../utils/runtime.js";
import { resolveLid, resolveLidSync } from "../utils/lidResolver.js";
import { Button } from "../utils/MessageBuilderV4.7.js";
import chalk from "chalk";

function getDistance(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, () => []);
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

function findClosest(input, list) {
  let closest = null;
  let minDistance = Infinity;
  for (const item of list) {
    const dist = getDistance(input, item);
    if (dist < minDistance) {
      minDistance = dist;
      closest = item;
    }
  }
  return minDistance <= 2 ? closest : null;
}

function stripAt(id) {
  if (!id) return "";
  return String(id).split("@")[0].split(":")[0];
}

export async function handleMessage(conn, msg) {
  try {
    const isMe = msg.key.fromMe;

    if (!msg.message) return;

    const mess =
      msg.message.conversation || msg.message.extendedTextMessage?.text || "";

    const remoteJid = msg.key.remoteJid || "";
    const isGroup = remoteJid.endsWith("@g.us");
    const isChannel = remoteJid.endsWith("@newsletter");
    const isBroadcast =
      remoteJid === "status@broadcast" || msg.broadcast === true;
    const isPrivate = !isGroup && !isChannel && !isBroadcast;

    const ids = [
      msg.key.participant,
      msg.key.participantAlt,
      msg.key.remoteJid,
      msg.key.remoteJidAlt,
    ];

    let senderLid = ids.find((id) => id && id.includes("@lid"));
    let senderJid = ids.find((id) => id && id.includes("@s.whatsapp.net"));

    const rawBotJid = conn.user.id;
    const botLid = conn.user.lid;
    const botJid = rawBotJid
      ? rawBotJid.split(":")[0] + "@s.whatsapp.net"
      : "";

    if (isMe) {
      senderLid = botLid || senderLid;
      senderJid = botJid || senderJid;
    }

    // ========== LID -> PHONE RESOLUTION ==========
    // If we only have a LID (no JID), try to resolve it
    if (!senderJid && senderLid) {
      // Try sync (cached) first
      const cachedPhone = resolveLidSync(senderLid);
      if (cachedPhone) {
        senderJid = cachedPhone + "@s.whatsapp.net";
      } else if (isGroup) {
        // In groups, metadata lookup is fastest
        try {
          const groupMetadata = await conn.groupMetadata(remoteJid);
          const pData = groupMetadata.participants.find((p) => p.id === senderLid);
          if (pData && pData.phoneNumber) {
            senderJid = pData.phoneNumber + "@s.whatsapp.net";
          }
        } catch (e) {}
      }

      // Fallback: full resolver (may call onWhatsApp)
      if (!senderJid) {
        const resolved = await resolveLid(conn, senderLid);
        if (resolved) {
          senderJid = resolved + "@s.whatsapp.net";
        }
      }
    }

    let senderNumber = senderJid
      ? senderJid.replace("@s.whatsapp.net", "")
      : "";

    const botNumber = rawBotJid ? rawBotJid.split(":")[0] : "";

    // ========== BAN CHECK (silent) ==========
    const bannedList = config.bot.banned?.number || [];
    if (
      bannedList.includes(senderNumber) ||
      (senderLid && bannedList.includes(stripAt(senderLid)))
    ) {
      return;
    }

    // ========== IGNORE SELF ==========
    const ignoreSelf = await getRuntimeValue("ignore_self");
    if (ignoreSelf === true && senderNumber === botNumber) return;
    if (config.ignore_self && isMe) return;

    if (!mess) return;

    let isAdmin = false;
    let isBotAdmin = false;
    let isOwner = false;
    let isPremium = false;
    let isCmd = false;
    let usedPrefix = "";
    let command = "";
    let args = [];

    const m = {
      key: msg.key,
      message: msg.message,
      react: async (emoji) => {
        await conn.sendMessage(remoteJid, {
          react: { text: emoji, key: msg.key },
        });
      },
      reply: async (teks) => {
        await conn.sendMessage(remoteJid, { text: teks }, { quoted: msg });
      },
    };

    let jid =
      isGroup || isChannel || isBroadcast ? remoteJid : senderJid || remoteJid;

    let formattedLid = senderLid;

    if (isGroup) {
      try {
        const groupMetadata = await conn.groupMetadata(remoteJid);
        const participants = groupMetadata.participants;

        if (!senderJid && senderLid) {
          const pData = participants.find((p) => p.id === senderLid);
          if (pData && pData.phoneNumber) {
            senderJid = pData.phoneNumber + "@s.whatsapp.net";
            senderNumber = senderJid.replace("@s.whatsapp.net", "");
          }
        }

        const checkAdmin =
          participants.find((p) => p.id === senderLid) ||
          participants.find((n) => n.phoneNumber === senderJid);

        isAdmin =
          checkAdmin?.admin === "admin" || checkAdmin?.admin === "superadmin";

        const checkBotAdmin =
          participants.find((p) => p.id === botLid) ||
          participants.find((n) => n.phoneNumber === botJid);

        isBotAdmin =
          checkBotAdmin?.admin === "admin" ||
          checkBotAdmin?.admin === "superadmin";
      } catch (e) {}
    }

    const senderName = msg.verifiedBizName || msg.pushName || "Unknown";

    // ========== OWNER / PREMIUM CHECK ==========
    const ownerList = config.bot.owner?.number || [];
    const premiumList = config.bot.premium?.number || [];
    const senderLidBare = stripAt(senderLid);

    if (
      (senderNumber && ownerList.includes(senderNumber)) ||
      (senderLidBare && ownerList.includes(senderLidBare)) ||
      senderLid === botLid
    ) {
      isOwner = true;
    }

    if (
      (senderNumber && premiumList.includes(senderNumber)) ||
      (senderLidBare && premiumList.includes(senderLidBare))
    ) {
      isPremium = true;
    }

    if (isOwner) isPremium = true;

    const prefixes = config.bot.prefix;

    let type;
    if (isGroup) type = chalk.green("[GROUP]");
    else if (isPrivate) type = chalk.cyan("[PRIVATE]");
    else if (isBroadcast) type = chalk.blue("[BROADCAST]");
    else type = chalk.magenta("[UNKNOWN]");

    const autoRead = await getRuntimeValue("auto_read");
    if (autoRead === true) await conn.readMessages([m.key]);

    if (!isChannel) {
      const lidInfo = senderLid ? chalk.gray(` lid:${senderLidBare}`) : "";
      console.log(
        "[NEW MESSAGE]",
        type,
        `${chalk.yellow(senderName)} ${chalk.gray(`(${senderNumber || "unknown"})`)}${lidInfo}\n${chalk.yellow(">")} ${mess}\n`,
      );
    }

    for (const p of prefixes) {
      if (mess.startsWith(p)) {
        isCmd = true;
        usedPrefix = p;
        break;
      }
    }

    if (isCmd) {
      const isSelf = await getRuntimeValue("self");
      const maintenance = config.dashboard?.maintenance === true;

      if (maintenance && !isOwner) {
        return await m.reply(config.mess.maintenance);
      }

      if (isSelf === true && !isOwner && !isPremium) return;

      const splitMsg = mess.slice(usedPrefix.length).trim().split(/ +/);
      command = splitMsg.shift().toLowerCase();
      args = splitMsg;
    }

    if (isCmd && plugins.has(command)) {
      const plugin = plugins.get(command);

      if (plugin.owner_only && !isOwner) {
        return await m.reply(config.mess.owner);
      }
      if (plugin.premium_only && !isPremium) {
        return await m.reply(config.mess.premium);
      }
      if (plugin.admin_only && !(isAdmin || isOwner)) {
        return await m.reply(config.mess.admin);
      }
      if (plugin.group_only && !isGroup) {
        return await m.reply(config.mess.group);
      }
      if (plugin.private_only && !isPrivate) {
        return await m.reply(config.mess.private);
      }

      const context = {
        jid,
        senderJid,
        senderLid,
        senderName,
        command,
        formattedLid,
        senderNumber,
        args,
        usedPrefix,
        isOwner,
        isPremium,
        isAdmin,
        isBotAdmin,
        isGroup,
        isPrivate,
        isBroadcast,
        isChannel,
      };

      try {
        await conn.sendPresenceUpdate("recording", jid);
        await plugin.run(conn, m, context);
        await conn.sendPresenceUpdate("available", jid);
      } catch (err) {
        console.error(`[EXEC ERROR] Command ${command}:`, err);
        await m.reply("An error occurred while running that command.");
      }
    } else if (isCmd && !plugins.has(command)) {
      await conn.sendPresenceUpdate("recording", jid);
      const allCommands = Array.from(plugins.keys());
      const suggestion = findClosest(command, allCommands);

      const text = suggestion
        ? `\`\`\`Command not found\`\`\`\n> Did you mean: ${usedPrefix}${suggestion}`
        : `\`\`\`Command not found\`\`\`\n> Type: ${usedPrefix}menu`;

      try {
        await new Button(conn)
          .setTitle("Error 404")
          .setBody(text)
          .addButton("inapp_signup", {})
          .send(jid, {
            quoted: {
              key: {
                fromMe: false,
                participant: "0@s.whatsapp.net",
                id: "PRODUCT123",
              },
              message: {
                locationMessage: {
                  degreesLatitude: -6.2,
                  degreesLongitude: 106.816666,
                  name: config.bot.name,
                  address: "Jakarta, Indonesia",
                },
              },
            },
          });

        await conn.sendPresenceUpdate("available", jid);
      } catch (err) {
        console.error("Failed to send command-not-found:", err);
        await m.reply(text);
      }
    }
  } catch (error) {
    console.error("Message handler error:", error);
  }
}