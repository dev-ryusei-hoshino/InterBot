import yts from "yt-search";
import axios from "axios";
import chalk from "chalk";
import sharp from "sharp";
import fs from "fs";
import os from "os";
import { exec } from "child_process";
import { join } from "path";

const TMP_DIR = join(os.tmpdir(), "bot-wa");
const YTDLP_PATH =
  "C:\\Users\\rayyt\\AppData\\Local\\Python\\pythoncore-3.14-64\\Scripts\\yt-dlp.exe";

function getYtDlpPath() {
  if (fs.existsSync(YTDLP_PATH)) return YTDLP_PATH;
  return "yt-dlp";
}

async function downloadYtAudio(videoUrl) {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const outputPath = join(TMP_DIR, `ytplay_${Date.now()}.mp3`);

  console.log("[YT PLAY] downloading:", videoUrl);

  await new Promise((resolve, reject) => {
    exec(
      `"${getYtDlpPath()}" --extract-audio --audio-format mp3 --no-warnings --output "${outputPath}" "${videoUrl}"`,
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });

  if (!fs.existsSync(outputPath)) {
    throw new Error("File MP3 tidak ditemukan setelah convert");
  }

  const buffer = fs.readFileSync(outputPath);

  try {
    fs.unlinkSync(outputPath);
  } catch (e) {}

  return buffer;
}

export default {
  name: "YouTube Player",
  command: ["ytplay", "ytp", "play"],
  category: "downloader",

  async run(conn, m, { jid, args, usedPrefix, command }) {
    const text = args.join(" ");

    if (!text) {
      return m.reply(`Insert a query.\n> Example ${usedPrefix + command} her`);
    }

    try {
      await conn.sendMessage(jid, {
        react: { text: "🔍", key: m.key },
      });

      const search = await yts(text);
      const videos = search.videos;

      if (!videos.length) {
        return m.reply("Not found.");
      }

      const v = videos[0];
      console.log(
        "[YT PLAY] selected video:",
        JSON.stringify({
          title: v.title,
          videoId: v.videoId,
          url: v.url,
          seconds: v.seconds,
        }),
      );

      if (v.seconds > 600) {
        return m.reply("Max duration: 10 min.");
      }

      await conn.sendMessage(jid, {
        react: { text: "⏬", key: m.key },
      });

      const url = v.url || `https://youtube.com/watch?v=${v.videoId}`;
      const buffer = await downloadYtAudio(url);

      const thumbBuffer = Buffer.from(
        (await axios.get(v.thumbnail, { responseType: "arraybuffer" })).data,
      );
      const sharped_thumbBuffer = await sharp(thumbBuffer)
        .resize(300, 300, {
          fit: "cover",
        })
        .jpeg({
          quality: 70,
          mozjpeg: true,
        })
        .toBuffer();

      await conn.sendMessage(
        jid,
        {
          audio: buffer,
          mimetype: "audio/mpeg",
          fileName: `${v.title}.mp3`,
          ptt: false,
          linkPreview: {
            "canonical-url": `https://youtu.be/${v.videoId}`,
            "matched-text": `https://youtu.be/${v.videoId}`,
            title: v.title,
            description: "",
            jpegThumbnail: thumbBuffer,
          },
        },
        {
          quoted: {
            key: {
              fromMe: false,
              participant: "0@s.whatsapp.net",
              id: "PRODUCT123",
            },

            message: {
              productMessage: {
                product: {
                  productImage: {
                    jpegThumbnail: sharped_thumbBuffer,
                  },

                  title: `${v.title}`,
                  description: `By ${v.author.name}`,

                  currencyCode: "HYDROXENE",
                  priceAmount: 9999999999,
                  retailerId: "YT_PLAY",
                  productImageCount: 1,
                },

                businessOwnerJid: "0@s.whatsapp.net",
              },
            },
          },
        },
      );

      await conn.sendMessage(jid, {
        react: { text: "✅", key: m.key },
      });
    } catch (err) {
      console.log(chalk.red("[-] [YT PLAY]"), err);

      await conn.sendMessage(jid, {
        react: { text: "❌", key: m.key },
      });

      m.reply("Gagal memutar: " + err.message);
    }
  },
};
