import { bratVid } from "brat-canvas/video";
import fs from "fs";
import { exec } from "child_process";
import chalk from "chalk";
import config from "../config.js";
import webpmux from "node-webpmux";

export default {
  name: "Brat Vid",
  command: ["bratvid"],
  is_creator: false,
  description: "Generate brat-style video with emoji support",
  category: "maker",

  async run(conn, m, { args, usedPrefix, command }) {
    const cleanText = args.join(" ");
    m.react("⌛");
    if (!cleanText) {
      await conn.sendMessage(
        m.key.remoteJid,
        {
          text: `❌ *Wrong Format!*\n\n*Usage:*\n${usedPrefix + command} <text> \n\n> *Example:*\n${usedPrefix + command} Hello World`,
        },
        { quoted: m },
      );
      m.react("🚫");
      return;
    }
    try {
      fs.mkdirSync("tmp", { recursive: true });
      const videoBuffer = await bratVid(cleanText, {
        outputFormat: "mp4",
      });

      const input = `./tmp/bratvid_${Date.now()}.mp4`;
      const output = `./tmp/bratvid_${Date.now()}_sticker.webp`;

      fs.writeFileSync(input, videoBuffer);

      await new Promise((resolve, reject) => {
        exec(
          `ffmpeg -y -i "${input}" -vf "fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000" -loop 0 -an -vcodec libwebp -lossless 0 -compression_level 6 -q:v 80 -preset default "${output}"`,
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
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

      fs.unlinkSync(input);
      fs.unlinkSync(output);

      await conn.sendMessage(
        m.key.remoteJid,
        { sticker: stickerBuffer },
        { quoted: m },
      );

      m.react("✅");
    } catch (error) {
      console.error(chalk.red("[-] [BRATVID]"), error);
      await conn.sendMessage(
        m.key.remoteJid,
        {
          text: `❌ *Failed to load brat image!*\n\nError: ${error.message}`,
        },
        { quoted: m },
      );
      m.react("🚫");
    }
  },
};
