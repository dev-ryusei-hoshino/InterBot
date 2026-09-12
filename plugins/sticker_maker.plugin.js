import { downloadMediaMessage } from "@whiskeysockets/baileys";
import fs from "fs";
import { exec } from "child_process";
import os from "os";
import chalk from "chalk";
import { join } from "path";
import webpmux from "node-webpmux";
import config from "../config.js";

export default {
  name: "Sticker Maker",
  command: ["s", "sticker", "stickermaker"],
  category: "maker",

  async run(conn, m, { jid, usedPrefix, command }) {
    try {
      let quoted = m?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      let mediaMessage = null;
      let isVideo = false;

      if (quoted && (quoted.imageMessage || quoted.videoMessage)) {
        mediaMessage = { key: m.key, message: quoted };
        isVideo = !!quoted.videoMessage;
      } else if (
        m.message?.imageMessage ||
        m.message?.videoMessage ||
        m.imageMessage ||
        m.videoMessage
      ) {
        mediaMessage = { key: m.key, message: m.message || m };
        isVideo = !!(m.message?.videoMessage || m.videoMessage);
      } else {
        return conn.sendMessage(
          jid,
          {
            text: `Send a media with caption or reply with ${usedPrefix + command}`,
          },
          { quoted: m },
        );
      }

      m.react("⌛");

      const buffer = await downloadMediaMessage(
        mediaMessage,
        "buffer",
        {},
        { logger: undefined, reuploadRequest: conn.updateMediaMessage },
      );

      const tmpDir = join(os.tmpdir(), "bot-wa");
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }

      const input = join(tmpDir, `${Date.now()}${isVideo ? ".mp4" : ".jpg"}`);
      const output = join(tmpDir, `${Date.now()}.webp`);

      fs.writeFileSync(input, buffer);

      const ffmpegArgs = isVideo
        ? `-y -i "${input}" -vf "fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000" -loop 0 -an -vcodec libwebp -lossless 0 -compression_level 6 -q:v 80 -preset default "${output}"`
        : `-y -i "${input}" -vf "scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000" -c:v libwebp -q:v 80 -preset default -an "${output}"`;

      await new Promise((resolve, reject) => {
        exec(`ffmpeg ${ffmpegArgs}`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      const packname = `\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n${config.bot.name}`;
      const author = `V${config.bot.ver}`;

      const img = new webpmux.Image();
      await img.load(output);
      const json = {
        "sticker-pack-id":
          "com.snowcorp.stickerly.android.stickercontentprovider b5e7275f-f1de-4137-961f-57becfad34f2",
        "sticker-pack-name": packname,
        "sticker-pack-publisher": author,
        emojis: ["✨"],
      };
      const exifAttr = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
        0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
      ]);
      const jsonBuff = Buffer.from(JSON.stringify(json), "utf-8");
      const exif = Buffer.concat([exifAttr, jsonBuff]);
      exif.writeUInt32LE(jsonBuff.length, 14);

      img.exif = exif;
      await img.save(output);

      const stickerBuffer = fs.readFileSync(output);

      await conn.sendMessage(jid, { sticker: stickerBuffer }, { quoted: m });

      m.react("✅");

      fs.unlinkSync(input);
      fs.unlinkSync(output);
    } catch (e) {
      console.log(chalk.red("[-] [STICKER MAKER]"), e);
      m.react("🚫");
      await conn.sendMessage(jid, {
        text: "Error:\n" + e.message,
      });
    }
  },
};
