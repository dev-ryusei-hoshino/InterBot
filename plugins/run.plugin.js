import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import vm from "vm";
import os from "os";
import config from "../config.js";

async function extractPdfText(buffer) {
  const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const loadingTask = getDocument(uint8);
  const doc = await loadingTask.promise;
  let fullText = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map((item) => item.str).join("") + "\n";
  }
  return fullText;
}

function buildEnvDetails() {
  const now = new Date();
  return {
    current_time: now.toISOString(),
    current_time_local: now.toLocaleString("id-ID"),
    working_directory: process.cwd(),
    platform: os.platform(),
    arch: os.arch(),
    node_version: process.version,
    hostname: os.hostname(),
    cpu: os.cpus()?.[0]?.model || "unknown",
    ram_total_mb: (os.totalmem() / 1024 / 1024).toFixed(0),
    ram_free_mb: (os.freemem() / 1024 / 1024).toFixed(0),
    uptime_seconds: process.uptime().toFixed(1),
    bot_name: config.bot?.name,
    bot_prefix: Array.isArray(config.bot?.prefix)
      ? config.bot.prefix.join(", ")
      : config.bot?.prefix,
    owner: config.bot?.owner?.number,
  };
}

export default {
  name: "Run Command",
  command: ["run"],
  is_creator: true,
  private_only: false,
  group_only: false,
  description: "Jalankan kode dari quoted message, dokumen, atau inline",
  category: "owner",

  async run(conn, m, { jid, usedPrefix, args }) {
    try {
      let code = args.join(" ");

      let quotedMessage = null;

      if (m.quoted) {
        if (m.quoted.message) {
          quotedMessage = m.quoted;
        } else if (!m.quoted.key) {
          quotedMessage = { key: m.key, message: m.quoted };
        } else {
          quotedMessage = m.quoted;
        }
      } else {
        const ctx = m.message?.extendedTextMessage?.contextInfo;
        if (ctx?.quotedMessage) {
          quotedMessage = { message: ctx.quotedMessage };
        }
      }

      if (quotedMessage && !code) {
        const msg = quotedMessage.message;
        const textContent =
          msg.conversation ||
          msg.extendedTextMessage?.text ||
          msg.imageMessage?.caption ||
          msg.videoMessage?.caption;

        if (textContent) {
          code = textContent.trim();
        } else {
          const docMsg =
            msg.documentWithCaptionMessage?.documentMessage ||
            msg.documentMessage ||
            msg.interactiveMessage?.header?.documentMessage ||
            msg.interactiveMessage?.header?.document;

          if (docMsg) {
            const messageForDownload = msg.interactiveMessage
              ? { documentMessage: docMsg }
              : msg;

            const buffer = await downloadMediaMessage(
              { key: quotedMessage.key || m.key, message: messageForDownload },
              "buffer",
              {},
              { logger: undefined, reuploadRequest: conn.updateMediaMessage },
            );

            if (!buffer?.length) {
              return await m.reply("Gagal mengunduh dokumen.");
            }

            const mime = docMsg.mimetype || "";

            if (mime.includes("text") || mime === "application/javascript") {
              code = buffer.toString("utf-8");
            } else if (mime === "application/pdf") {
              code = await extractPdfText(buffer);
            } else {
              return await m.reply(
                "Format dokumen tidak didukung. Gunakan teks atau PDF.",
              );
            }
          } else {
            return await m.reply(
              "Pesan yang di-reply tidak berisi teks atau dokumen yang didukung.",
            );
          }
        }
      }

      if (!code) {
        return await m.reply(
          `Gunakan:\n> ${usedPrefix}run <code>\nAtau reply pesan/dokumen berisi kode dengan:\n> ${usedPrefix}run`,
        );
      }

      if (!code.trim()) {
        return await m.reply("Tidak ada kode yang ditemukan.");
      }

      const envDetails = buildEnvDetails();

      const sandbox = {
        console: {
          log: (...args) => conn.sendMessage(jid, { text: args.join(" ") }),
        },
        require: async (mod) => {
          try {
            return await import(mod);
          } catch {
            return null;
          }
        },
        setTimeout,
        setInterval,
        clearTimeout,
        clearInterval,
        Buffer,
        JSON,
        Math,
        Date,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURI,
        decodeURI,
        encodeURIComponent,
        decodeURIComponent,
        Promise,
        async: (fn) => setTimeout(() => fn(), 0),
        m,
        conn,
        jid,
        config,
        env: envDetails,
        ENV: envDetails,
        __env__: envDetails,
      };

      const context = vm.createContext(sandbox);

      let result;
      try {
        const maybePromise = vm.runInContext(code, context, { timeout: 10000 });

        if (maybePromise && typeof maybePromise.catch === "function") {
          try {
            result = await maybePromise;
          } catch (promiseErr) {
            return await m.reply(
              `❌ Async Error:\n\`\`\`${promiseErr.message}\`\`\``,
            );
          }
        } else {
          result = maybePromise;
        }
      } catch (err) {
        return await m.reply(`❌ Error:\n\`\`\`${err.message}\`\`\``);
      }

      const output = result !== undefined ? String(result) : "undefined";
      if (output !== "undefined") {
        await m.reply(`✅ Output:\n\`\`\`${output}\`\`\``);
      }
    } catch (e) {
      console.error(e);
      await m.reply("Terjadi kesalahan saat menjalankan kode.");
    }
  },
};
