import config from "../config.js";
import chalk from "chalk";

export default {
  name: "hidetag",
  command: ["hidetag", "ht"],
  group_only: true,
  category: "group",
  description: "Tag semua member secara tersembunyi",

  async run(conn, m, { jid, args, isCreator, isAdmin, isGroup }) {
    try {
      if (m.key.fromMe === true) return;
      if (!isGroup) {
        return await conn.sendMessage(
          jid,
          {
            text: config.mess.group,
          },
          { quoted: m },
        );
      }

      if (!isCreator && !isAdmin) {
        return await conn.sendMessage(
          jid,
          {
            text: config.mess.admin,
          },
          { quoted: m },
        );
      }

      const metadata = await conn.groupMetadata(jid);
      const participants = metadata.participants.map((p) => p.id);

      const context = m.message?.extendedTextMessage?.contextInfo;

      const quotedText =
        context?.quotedMessage?.conversation ||
        context?.quotedMessage?.extendedTextMessage?.text;

      const directText =
        m.message?.conversation || m.message?.extendedTextMessage?.text;

      let text = args.join(" ") || quotedText || args[0] || " ";
      if (!args) {
        let text = " ";
      }

      await conn.sendMessage(jid, {
        text,
        mentions: participants,
      });
    } catch (e) {
      console.log(chalk.red("[-] [HIDETAG]"), e.message);

      await conn.sendMessage(
        jid,
        {
          text: "Error:\n" + e.message,
        },
        { quoted: m },
      );
    }
  },
};