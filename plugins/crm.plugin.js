import { inspect } from "node:util";

function serializePayload(obj) {
  const seen = new WeakSet();

  const replacer = (key, value) => {
    if (typeof value === "bigint") return { __bigint: value.toString() };

    if (typeof value !== "object" || value === null) return value;

    const bufLegacy =
      typeof value.type === "string" &&
      value.type === "Buffer" &&
      Array.isArray(value.data);
    if (bufLegacy) {
      return { __buffer: Buffer.from(value.data).toString("base64") };
    }
    if (Buffer.isBuffer(value)) {
      return { __buffer: value.toString("base64") };
    }
    if (value instanceof Uint8Array) {
      return { __uint8array: Array.from(value) };
    }
    if (seen.has(value)) return { __circular: true };
    seen.add(value);
    return value;
  };

  return JSON.stringify(obj, replacer, 2);
}

function buildRunSnippet(payload) {
  const messageContent = payload.message || payload;
  const json = serializePayload(messageContent);
  const reviver = `(k, v) => {
    if (v && typeof v === "object") {
      if (v.__bigint) return BigInt(v.__bigint);
      if (v.__buffer) return Buffer.from(v.__buffer, "base64");
      if (v.__uint8array) return Uint8Array.from(v.__uint8array);
    }
    return v;
  }`;

  const jsonLiteral = JSON.stringify(json);

  return (
    "conn.relayMessage(jid, JSON.parse(" +
    jsonLiteral +
    ", " +
    reviver +
    "), {}).catch(err => console.log('Relay error: ' + err.message));\n" +
    "console.log('Relay executed');"
  );
}

function normalizeMessage(msg) {
  const content = msg?.message;
  if (!content) return null;

  let layer = 1;
  let current = content;
  const path = [];

  while (layer < 6) {
    const wrapper =
      current.ephemeralMessage ||
      current.viewOnceMessageV2 ||
      current.viewOnceMessage ||
      current.viewOnceMessageV2Extension ||
      current.documentWithCaptionMessage ||
      current.editedMessage ||
      current.editedMessage?.prevMessage ||
      current.editedMessage?.newMessage ||
      current.documentWithCaptionMessage;

    if (!wrapper) break;

    path.push({ layer, wrapper: getWrapperName(current) });
    current = wrapper;
    layer++;
  }

  return { content: current, wrappers: path };
}

function getWrapperName(current) {
  if (current.ephemeralMessage) return "ephemeralMessage";
  if (current.viewOnceMessageV2) return "viewOnceMessageV2";
  if (current.viewOnceMessage) return "viewOnceMessage";
  if (current.viewOnceMessageV2Extension) return "viewOnceMessageV2Extension";
  if (current.documentWithCaptionMessage) return "documentWithCaptionMessage";
  if (current.editedMessage) return "editedMessage";
  return "unknown";
}

function getMessageType(msg) {
  const message = msg?.message || {};
  const c = message;
  if (c.conversation) return "text";
  if (c.extendedTextMessage) return "text";
  if (c.imageMessage) return "photo";
  if (c.videoMessage) return "video";
  if (c.audioMessage) return c.audioMessage.ptt ? "voice" : "audio";
  if (c.stickerMessage) return "sticker";
  if (c.documentMessage) return "document";
  if (c.documentWithCaptionMessage) return "document";
  if (c.locationMessage) return "location";
  if (c.liveLocationMessage) return "liveLocation";
  if (c.contactMessage) return "contact";
  if (c.contactsArrayMessage) return "contactArray";
  if (c.buttonsMessage) return "buttons";
  if (c.templateMessage) return "template";
  if (c.listMessage) return "list";
  if (c.interactiveMessage) return "interactive";
  if (c.productMessage) return "product";
  if (c.orderMessage) return "order";
  if (c.buttonsResponseMessage) return "buttonsResponse";
  if (c.templateButtonReplyMessage) return "templateButtonReply";
  if (c.listResponseMessage) return "listResponse";
  if (c.interactiveResponseMessage) return "interactiveResponse";
  if (c.pollCreationMessage) return "poll";
  if (c.pollCreationMessageV2) return "pollV2";
  if (c.eventMessage) return "event";
  if (c.groupInviteMessage) return "groupInvite";
  if (c.albumMessage) return "album";
  if (c.ptvMessage) return "ptv";
  if (c.senderKeyDistributionMessage) return "senderKeyDistribution";
  if (c.historySyncNotification) return "historySyncNotification";
  if (c.protocolMessage) return "protocol";
  if (c.chat) return "chat";
  if (c.senderKeyDistributionMessage) return "senderKey";
  return "unknown";
}

function getMediaInfo(msg) {
  const message = msg?.message || {};
  const info = [];

  const check = (field, label) => {
    if (message[field]) {
      const data = message[field];
      const details = { type: field, label };
      if (data.mimetype) details.mimetype = data.mimetype;
      if (data.fileLength) details.size = data.fileLength;
      if (data.seconds) details.duration = `${data.seconds}s`;
      if (data.width && data.height)
        details.dimensions = `${data.width}x${data.height}`;
      if (data.caption) details.caption = data.caption;
      if (data.mediaKey) details.hasKey = true;
      if (data.jpegThumbnail) details.hasThumb = true;
      if (data.fileName) details.fileName = data.fileName;
      if (data.title) details.title = data.title;
      if (data.pageCount) details.pageCount = data.pageCount;
      info.push(details);
    }
  };

  check("imageMessage", "Photo");
  check("videoMessage", "Video");
  check("audioMessage", "Audio");
  check("stickerMessage", "Sticker");
  check("documentMessage", "Document");
  check("ptvMessage", "PTV Video");
  check("thumbnailLinkMessage", "Thumbnail Link");
  check("locationMessage", "Location");
  check("liveLocationMessage", "Live Location");

  return info;
}

function getInteractiveInfo(msg) {
  const message = msg?.message || {};
  const info = {
    buttons: [],
    list: null,
    nativeFlow: null,
    header: null,
    body: null,
    footer: null,
    contextInfo: null,
  };

  if (message.buttonsMessage) {
    const bm = message.buttonsMessage;
    if (bm.headerText || bm.headerType)
      info.header = { headerText: bm.headerText, headerType: bm.headerType };
    info.body = bm.bodyText || bm.text;
    info.footer = bm.footerText;
    if (bm.buttons) {
      bm.buttons.forEach((btn, i) => {
        const button = {};
        const type = btn.callButton
          ? "call"
          : btn.urlButton
            ? "url"
            : btn.quickReplyButton
              ? "reply"
              : btn.surveyButton
                ? "survey"
                : "unknown";
        button.type = type;
        button.index = i;
        if (btn.callButton) {
          button.displayText = btn.callButton.displayText;
          button.phoneNumber = btn.callButton.phoneNumber;
        }
        if (btn.urlButton) {
          button.displayText = btn.urlButton.displayText;
          button.url = btn.urlButton.url;
        }
        if (btn.quickReplyButton) {
          button.displayText = btn.quickReplyButton.displayText;
          button.id = btn.quickReplyButton.id;
        }
        if (btn.surveyButton) {
          button.displayText =
            btn.surveyButton.surveyButtonMessage?.displayText;
          button.surveyJson = JSON.stringify(
            btn.surveyButton.surveyButtonMessage,
          );
        }
        info.buttons.push(button);
      });
    }
  }

  if (message.templateMessage) {
    const tm = message.templateMessage;
    info.header = { template: true };
    if (tm.hydratedTemplate) {
      info.header.hydrated = true;
      info.body =
        tm.hydratedTemplate.hydratedContentText ||
        tm.hydratedTemplate.contentText;
      info.footer =
        tm.hydratedTemplate.hydratedFooterText ||
        tm.hydratedTemplate.footerText;
      if (tm.hydratedTemplate.buttons) {
        tm.hydratedTemplate.buttons.forEach((btn, i) => {
          const button = { type: "template", index: i };
          if (btn.url) {
            button.url = btn.url;
            button.displayText = btn.displayText;
          } else if (btn.call) {
            button.phoneNumber = btn.call;
            button.displayText = btn.displayText;
          } else if (btn.quickReplyButton) {
            button.id = btn.quickReplyButton.id;
            button.displayText = btn.displayText;
          }
          info.buttons.push(button);
        });
      }
    }
    if (tm.hydratedFourRowTemplate) {
      info.header.hydratedFourRow = true;
      info.body =
        tm.hydratedFourRowTemplate.hydratedContentText ||
        tm.hydratedFourRowTemplate.contentText;
      info.footer =
        tm.hydratedFourRowTemplate.hydratedFooterText ||
        tm.hydratedFourRowTemplate.footerText;
      if (tm.hydratedFourRowTemplate.buttons) {
        tm.hydratedFourRowTemplate.buttons.forEach((btn, i) => {
          const button = { type: "template", index: i };
          if (btn.url) {
            button.url = btn.url;
            button.displayText = btn.displayText;
          } else if (btn.call) {
            button.phoneNumber = btn.call;
            button.displayText = btn.displayText;
          } else if (btn.quickReplyButton) {
            button.id = btn.quickReplyButton.id;
            button.displayText = btn.displayText;
          }
          info.buttons.push(button);
        });
      }
    }
  }

  if (message.listMessage) {
    const lm = message.listMessage;
    info.list = {
      title: lm.title,
      footerText: lm.footerText,
      buttonText: lm.buttonText,
      listType: lm.listType,
      sections: (lm.sections || []).map((s, i) => ({
        title: s.title,
        rows: (s.rows || []).map((r) => ({
          title: r.title,
          description: r.description,
          rowId: r.rowId,
        })),
      })),
    };
  }

  if (message.interactiveMessage) {
    const im = message.interactiveMessage;
    if (im.header) {
      const h = im.header;
      info.header = {
        title: h.title,
        subtitle: h.subtitle,
        hasMedia: !!(
          h.imageMessage ||
          h.videoMessage ||
          h.documentMessage ||
          h.jpegThumbnail
        ),
        mediaType: h.imageMessage
          ? "image"
          : h.videoMessage
            ? "video"
            : h.documentMessage
              ? "document"
              : "thumbnail",
      };
    }
    if (im.body) info.body = im.body.text;
    if (im.footer) info.footer = im.footer.text;
    if (im.contextInfo) {
      const ci = im.contextInfo;
      info.contextInfo = {
        stanzaId: ci.stanzaId,
        participant: ci.participant,
        quotedMessage: ci.quotedMessage
          ? getMessageType({ message: ci.quotedMessage })
          : null,
        mentions: ci.mentionedJid?.length || 0,
      };
    }

    if (im.nativeFlowMessage) {
      const nf = im.nativeFlowMessage;
      info.nativeFlow = {
        name: nf.name,
        version: nf.version,
        paramsJson: nf.paramsJson,
        timeout: nf.timeout,
        buttons: (nf.buttons || []).map((b) => ({
          type: b.name || "unknown",
          displayText: b.buttonText?.displayText || b.displayText,
        })),
      };
    }

    if (im.bannerMessage) {
      info.banner = {
        hasMedia: !!im.bannerMessage.media,
        mediaType: im.bannerMessage.media?.imageMessage
          ? "image"
          : im.bannerMessage.media?.videoMessage
            ? "video"
            : im.bannerMessage.media?.documentMessage
              ? "document"
              : "none",
        title: im.bannerMessage.title,
        attachmentType: im.bannerMessage.attachmentType,
      };
    }

    if (im.productMessage) {
      const pm = im.productMessage;
      info.product = {
        businessOwnerJid: pm.businessOwnerJid,
        productId: pm.productId,
        retailerId: pm.retailerId,
        title: pm.productImageInfo?.title,
        description: pm.productImageInfo?.description,
      };
    }

    if (im.carouselMessage) {
      info.carousel = {
        cards:
          im.carouselMessage.cards?.map((card) => ({
            header: !!card.header,
            body: !!card.body,
            footer: !!card.footer,
            nativeFlow: !!card.nativeFlowMessage,
          })) || [],
      };
    }

    if (im.listMessage) {
      info.list = {
        title: im.listMessage.title,
        footerText: im.listMessage.footerText,
        buttonText: im.listMessage.buttonText,
        sections: (im.listMessage.sections || []).map((s, i) => ({
          title: s.title,
          rows: (s.rows || []).map((r) => ({
            title: r.title,
            description: r.description,
            rowId: r.rowId,
          })),
        })),
      };
    }
  }

  return info;
}

function getResponseInfo(msg) {
  const message = msg?.message || {};
  const info = {};

  if (message.templateButtonReplyMessage) {
    info.templateButtonReply = message.templateButtonReplyMessage;
  }
  if (message.buttonsResponseMessage) {
    info.buttonsResponse = message.buttonsResponseMessage;
  }
  if (message.listResponseMessage) {
    info.listResponse = message.listResponseMessage;
  }
  if (message.interactiveResponseMessage) {
    info.interactiveResponse = message.interactiveResponseMessage;
  }
  if (message.pollUpdateMessage) {
    info.pollUpdate = message.pollUpdateMessage;
  }
  if (message.pollResponseMessage) {
    info.pollResponse = message.pollResponseMessage;
  }
  if (message.reactionMessage) {
    info.reaction = message.reactionMessage;
  }
  if (message.keepInChatMessage) {
    info.keepInChat = message.keepInChatMessage;
  }
  if (message.pinInChatMessage) {
    info.pinInChat = message.pinInChatMessage;
  }

  return info;
}

function getContextInfo(msg) {
  const message = msg?.message || {};
  const ci = message.messageContextInfo || {};
  const contextInfo = {};

  if (ci.stanzaId) contextInfo.stanzaId = ci.stanzaId;
  if (ci.participant) contextInfo.participant = ci.participant;
  if (ci.quotedMessage) {
    contextInfo.quotedMessageType = getMessageType({
      message: ci.quotedMessage,
    });
  }
  if (ci.mentionedJid?.length)
    contextInfo.mentionedCount = ci.mentionedJid.length;
  if (ci.expiration) contextInfo.expiration = ci.expiration;
  if (ci.ephemeralSettingTimestamp) contextInfo.ephemeralSetting = true;
  if (ci.conversationParent) contextInfo.conversationParent = true;
  if (ci.forwardingScore) contextInfo.forwardingScore = ci.forwardingScore;
  if (ci.isForwarded) contextInfo.isForwarded = ci.isForwarded;
  if (ci.transcriptionText)
    contextInfo.transcriptionText = ci.transcriptionText;
  if (ci.ttl) contextInfo.ttl = ci.ttl;
  if (ci.traceId) contextInfo.traceId = ci.traceId;

  return contextInfo;
}

function getMetaInfo(msg) {
  const meta = {
    messageTimestamp: msg?.messageTimestamp,
    pushName: msg?.pushName,
    fromMe: msg?.key?.fromMe,
    participant: msg?.key?.participant,
    remoteJid: msg?.key?.remoteJid,
    id: msg?.key?.id,
    status: msg?.status,
  };

  const message = msg?.message || {};
  if (message.albumMessage) {
    meta.album = {
      initialPlaceholderMessageId:
        message.albumMessage.initialPlaceholderMessageId,
      imageCount: message.albumMessage.imageCount,
    };
  }

  if (message.pollCreationMessage) {
    meta.poll = {
      name: message.pollCreationMessage.name,
      selectableOptionsCount:
        message.pollCreationMessage.selectableOptionsCount,
      values: (message.pollCreationMessage.values || []).map(
        (v) => v.optionName,
      ),
    };
  }

  if (message.pollCreationMessageV2) {
    meta.pollV2 = {
      name: message.pollCreationMessageV2.name,
      selectableOptionsCount:
        message.pollCreationMessageV2.selectableOptionsCount,
      toAnnouncementGroup: message.pollCreationMessageV2.toAnnouncementGroup,
      values: (message.pollCreationMessageV2.values || []).map(
        (v) => v.optionName,
      ),
    };
  }

  if (message.groupInviteMessage) {
    meta.groupInvite = {
      inviteCode: message.groupInviteMessage.inviteCode,
      groupJid: message.groupInviteMessage.groupJid,
      groupName: message.groupInviteMessage.groupName,
      jpegThumbnail: !!message.groupInviteMessage.jpegThumbnail,
    };
  }

  if (message.eventMessage) {
    meta.event = {
      name: message.eventMessage.name,
      description: message.eventMessage.description,
      startTime: message.eventMessage.startTime,
      endTime: message.eventMessage.endTime,
      isCanceled: message.eventMessage.isCanceled,
      isScheduleCall: message.eventMessage.isScheduleCall,
      joinLink: message.eventMessage.joinLink,
      location: message.eventMessage.location,
    };
  }

  if (message.orderMessage) {
    meta.order = {
      orderId: message.orderMessage.orderId,
      thumbnail: !!message.orderMessage.thumbnail,
      title: message.orderMessage.title,
      itemCount: message.orderMessage.itemCount,
      status: message.orderMessage.status,
    };
  }

  return meta;
}

function sniffMessage(msg) {
  const normalized = normalizeMessage(msg);
  if (!normalized || !normalized.content) {
    return { found: false };
  }

  const message = normalized.content;
  const type = getMessageType({ message });

  const sniff = {
    found: true,
    type,
    wrappers: normalized.wrappers,
    primaryContent: null,
    media: getMediaInfo({ message }),
    interactive: getInteractiveInfo({ message }),
    response: getResponseInfo({ message }),
    context: getContextInfo({ message }),
    meta: getMetaInfo(msg),
  };

  if (message.conversation) {
    sniff.primaryContent = { text: message.conversation };
  } else if (message.extendedTextMessage) {
    sniff.primaryContent = {
      text: message.extendedTextMessage.text,
      matchedText: message.extendedTextMessage.matchedText,
      description: message.extendedTextMessage.description,
      title: message.extendedTextMessage.title,
      jpegThumbnail: !!message.extendedTextMessage.jpegThumbnail,
      canonicalUrl: message.extendedTextMessage.canonicalUrl,
      mentionsJidList: message.extendedTextMessage.mentionsJidList,
    };
  }

  return sniff;
}

function buildSniffReport(sniff) {
  const lines = [];

  lines.push("# *MESSAGE SNIFF REPORT*");
  lines.push("> **Type:** " + sniff.type);
  if (sniff.wrappers?.length) {
    const wrapStr = sniff.wrappers
      .map((w) => w.layer + "x " + w.wrapper)
      .join(" → ");
    lines.push("> **Wrappers:** " + wrapStr + " →");
  }
  lines.push("");

  if (sniff.context.stanzaId) {
    lines.push("**🔗 Context Info**");
    lines.push("- Stanza: " + sniff.context.stanzaId);
    if (sniff.context.participant)
      lines.push("- Participant: " + sniff.context.participant);
    if (sniff.context.quotedMessageType)
      lines.push("- Quoted Type: " + sniff.context.quotedMessageType);
    if (sniff.context.mentionedCount)
      lines.push("- Mentions: " + sniff.context.mentionedCount);
    lines.push("");
  }

  if (sniff.primaryContent) {
    lines.push("**📝 Primary Content**");
    if (sniff.primaryContent.text) {
      lines.push("```text\n" + sniff.primaryContent.text + "\n```");
    }
    if (sniff.primaryContent.jpegThumbnail)
      lines.push("- Has link preview thumbnail: Yes");
    if (sniff.primaryContent.canonicalUrl)
      lines.push("- URL: " + sniff.primaryContent.canonicalUrl);
    lines.push("");
  }

  if (sniff.meta.poll) {
    lines.push("**📊 Poll**");
    lines.push("- Name: " + sniff.meta.poll.name);
    lines.push("- Selectable: " + sniff.meta.poll.selectableOptionsCount);
    const pollOptions = sniff.meta.poll.values.map((v) => "• " + v).join("\n");
    lines.push("- Options:\n```\n" + pollOptions + "\n```");
    lines.push("");
  }

  if (sniff.meta.pollV2) {
    lines.push("**📊 Poll V2**");
    lines.push("- Name: " + sniff.meta.pollV2.name);
    lines.push("- Selectable: " + sniff.meta.pollV2.selectableOptionsCount);
    lines.push(
      "- Announcement: " +
        (sniff.meta.pollV2.toAnnouncementGroup ? "Yes" : "No"),
    );
    const pollOptions = sniff.meta.pollV2.values
      .map((v) => "• " + v)
      .join("\n");
    lines.push("- Options:\n```\n" + pollOptions + "\n```");
    lines.push("");
  }

  if (sniff.meta.groupInvite) {
    lines.push("**👥 Group Invite**");
    lines.push("- Name: " + sniff.meta.groupInvite.groupName);
    lines.push("- Code: " + sniff.meta.groupInvite.inviteCode);
    lines.push("- JID: " + sniff.meta.groupInvite.groupJid);
    lines.push("");
  }

  if (sniff.meta.event) {
    lines.push("**📅 Event**");
    lines.push("- Name: " + sniff.meta.event.name);
    lines.push("- Description: " + sniff.meta.event.description);
    if (sniff.meta.event.startTime)
      lines.push(
        "- Start: " + new Date(sniff.meta.event.startTime * 1000).toISOString(),
      );
    if (sniff.meta.event.endTime)
      lines.push(
        "- End: " + new Date(sniff.meta.event.endTime * 1000).toISOString(),
      );
    if (sniff.meta.event.joinLink)
      lines.push("- Join: " + sniff.meta.event.joinLink);
    if (sniff.meta.event.isCanceled) lines.push("- Canceled: Yes");
    lines.push("");
  }

  if (sniff.meta.order) {
    lines.push("**📦 Order**");
    lines.push("- Order ID: " + sniff.meta.order.orderId);
    lines.push("- Title: " + sniff.meta.order.title);
    lines.push("- Items: " + sniff.meta.order.itemCount);
    if (sniff.meta.order.status)
      lines.push("- Status: " + sniff.meta.order.status);
    lines.push("");
  }

  if (sniff.media?.length) {
    lines.push("**📎 Media (" + sniff.media.length + ")**");
    sniff.media.forEach((m) => {
      lines.push("- " + m.label + " [" + m.type + "]");
      if (m.mimetype) lines.push("  - MIME: " + m.mimetype);
      if (m.size) lines.push("  - Size: " + (m.size / 1024).toFixed(1) + " KB");
      if (m.dimensions) lines.push("  - Size: " + m.dimensions);
      if (m.duration) lines.push("  - Duration: " + m.duration);
      if (m.fileName) lines.push("  - File: " + m.fileName);
      if (m.title) lines.push("  - Title: " + m.title);
      if (m.pageCount) lines.push("  - Pages: " + m.pageCount);
      if (m.caption) lines.push("  - Caption: " + m.caption);
    });
    lines.push("");
  }

  if (
    sniff.interactive?.header ||
    sniff.interactive?.body ||
    sniff.interactive?.footer
  ) {
    lines.push("**📋 Interactive Header/Body/Footer**");
    if (sniff.interactive.header?.title)
      lines.push("- Title: " + sniff.interactive.header.title);
    if (sniff.interactive.header?.subtitle)
      lines.push("- Subtitle: " + sniff.interactive.header.subtitle);
    if (sniff.interactive.header?.hasMedia) lines.push("- Has Media: Yes");
    if (sniff.interactive.header?.mediaType)
      lines.push("- Media Type: " + sniff.interactive.header.mediaType);
    if (sniff.interactive.body)
      lines.push("- Body:\n```text\n" + sniff.interactive.body + "\n```");
    if (sniff.interactive.footer)
      lines.push("- Footer: " + sniff.interactive.footer);
    lines.push("");
  }

  if (sniff.interactive?.buttons?.length) {
    lines.push("**🔘 Buttons (" + sniff.interactive.buttons.length + ")**");
    sniff.interactive.buttons.forEach((btn) => {
      const emoji =
        btn.type === "reply"
          ? "💬"
          : btn.type === "url"
            ? "🔗"
            : btn.type === "call"
              ? "📞"
              : btn.type === "survey"
                ? "📋"
                : "🔘";
      lines.push(
        "- " +
          emoji +
          " [" +
          btn.type +
          "] idx=" +
          btn.index +
          ": **" +
          (btn.displayText || "(no text)") +
          "**",
      );
      if (btn.id) lines.push("  - ID: `" + btn.id + "`");
      if (btn.url) lines.push("  - URL: `" + btn.url + "`");
      if (btn.phoneNumber) lines.push("  - Phone: `" + btn.phoneNumber + "`");
      if (btn.surveyJson)
        lines.push("  - Survey: \n```json\n" + btn.surveyJson + "\n```");
    });
    lines.push("");
  }

  if (sniff.interactive?.list) {
    lines.push("**📜 List Message**");
    lines.push("- Title: " + (sniff.interactive.list.title || "(none)"));
    lines.push("- Footer: " + (sniff.interactive.list.footerText || "(none)"));
    lines.push("- Button: " + (sniff.interactive.list.buttonText || "(none)"));
    lines.push(
      "- Type: " +
        (sniff.interactive.list.listType === 1
          ? "Single Select"
          : "Multi Select"),
    );
    if (sniff.interactive.list.sections?.length) {
      lines.push(
        "- Sections (" + sniff.interactive.list.sections.length + "):",
      );
      sniff.interactive.list.sections.forEach((s, i) => {
        lines.push(
          "  - Section " +
            (i + 1) +
            ": **" +
            (s.title || "(untitled)") +
            "** - " +
            (s.rows?.length || 0) +
            " rows",
        );
        s.rows?.forEach((r) => {
          const desc = r.description ? " (" + r.description + ")" : "";
          lines.push(
            "    - " +
              JSON.stringify(r.title) +
              ": " +
              JSON.stringify(r.rowId) +
              desc,
          );
        });
      });
    }
    lines.push("");
  }

  if (sniff.interactive?.nativeFlow) {
    lines.push("**🌐 Native Flow**");
    lines.push("- Name: " + sniff.interactive.nativeFlow.name);
    lines.push("- Version: " + sniff.interactive.nativeFlow.version);
    if (sniff.interactive.nativeFlow.timeout)
      lines.push("- Timeout: " + sniff.interactive.nativeFlow.timeout);
    if (sniff.interactive.nativeFlow.paramsJson) {
      lines.push(
        "- Params JSON:\n```json\n" +
          sniff.interactive.nativeFlow.paramsJson +
          "\n```",
      );
    }
    if (sniff.interactive.nativeFlow.buttons?.length) {
      lines.push("- Buttons:");
      sniff.interactive.nativeFlow.buttons.forEach((b) => {
        lines.push(
          "  - " + (b.displayText || "(unnamed)") + " [" + b.type + "]",
        );
      });
    }
    lines.push("");
  }

  if (sniff.interactive?.product) {
    lines.push("**🛍️ Product**");
    lines.push("- Product ID: " + sniff.interactive.product.productId);
    if (sniff.interactive.product.title)
      lines.push("- Title: " + sniff.interactive.product.title);
    lines.push("");
  }

  if (sniff.interactive?.banner) {
    lines.push("**🖼️ Banner**");
    if (sniff.interactive.banner.title)
      lines.push("- Title: " + sniff.interactive.banner.title);
    lines.push(
      "- Has Media: " + (sniff.interactive.banner.hasMedia ? "Yes" : "No"),
    );
    lines.push("- Media Type: " + sniff.interactive.banner.mediaType);
    lines.push("- Attachment: " + sniff.interactive.banner.attachmentType);
    lines.push("");
  }

  if (sniff.interactive?.carousel) {
    lines.push("**🎠 Carousel**");
    lines.push("- Cards: " + (sniff.interactive.carousel.cards?.length || 0));
    sniff.interactive.carousel.cards?.forEach((c, i) => {
      lines.push(
        "  - Card " +
          (i + 1) +
          ": header=" +
          c.header +
          " body=" +
          c.body +
          " nativeFlow=" +
          c.nativeFlow,
      );
    });
    lines.push("");
  }

  if (Object.keys(sniff.response).length) {
    lines.push("**✅ Response Data**");
    for (const [key, val] of Object.entries(sniff.response)) {
      lines.push("- **" + key + "**:");
      lines.push("  ```json\n" + JSON.stringify(val, null, 2) + "\n```");
    }
    lines.push("");
  }

  lines.push("**📊 Generated Snippet**");

  return lines.join("\n");
}

function extractQuotedMessage(m) {
  let quotedMessage = null;

  if (m.quoted?.message) {
    quotedMessage = m.quoted;
  } else {
    const ctx = m.message?.extendedTextMessage?.contextInfo;
    if (ctx?.quotedMessage) {
      quotedMessage = { message: ctx.quotedMessage };
    }
  }

  if (quotedMessage?.message) {
    const msgKeys = Object.keys(quotedMessage.message);
    for (const k of msgKeys) {
      if (k === "messageContextInfo") continue;
      const ctx = quotedMessage.message[k]?.contextInfo;
      if (ctx?.quotedMessage) {
        quotedMessage.quoted = {
          key: {
            remoteJid: quotedMessage.key?.remoteJid || m.key.remoteJid,
            participant: ctx.participant || ctx.remoteJid,
            id: ctx.stanzaId,
          },
          message: ctx.quotedMessage,
        };
        break;
      }
    }
  }

  return quotedMessage;
}

export default {
  name: "crm",
  command: ["crm"],
  category: "tools",
  description:
    "Comprehensive message sniffer with full button/interactive support",

  async run(conn, m, context) {
    const { jid, usedPrefix } = context;

    const quotedMessage = extractQuotedMessage(m);

    if (!quotedMessage) {
      return await m.reply("Reply sebuah pesan untuk di-sniff.");
    }

    const sniff = sniffMessage(quotedMessage);

    if (!sniff.found) {
      return await m.reply("Tidak dapat membaca isi pesan yang di-reply.");
    }

    const payloadForRelay = quotedMessage;

    const messageType = getMessageType(quotedMessage);
    const dateStr = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
    });

    const runSnippet = buildRunSnippet(payloadForRelay);

    const jsFileContent = `/* Relay snippet untuk pesan ${messageType} */
/* Generated: ${dateStr} */
/* Usage: reply pesan ini dengan caption: !run */

${runSnippet}`;

    let report = `#𝗠𝗘𝗦𝗦𝗔𝗚𝗘 𝗦𝗡𝗜𝗙𝗙 𝗥𝗘𝗣𝗢𝗥𝗧
𝖬𝖾𝗌𝗌𝖺𝗀𝖾 𝖳𝗒𝗉𝖾: ${messageType}
𝖣𝖺𝗍𝖾: ${dateStr}
𝖭𝗈𝗍𝖾𝗌: 
𝖱𝖾𝗉𝗅𝗒 𝗉𝖾𝗌𝖺𝗇 𝗂𝗇𝗂 𝖽𝖾𝗇𝗀𝖺𝗇 𝖼𝖺𝗉𝗍𝗂𝗈𝗇 .𝗋𝗎𝗇 𝗎𝗇𝗍𝗎𝗄 𝗆𝖾𝗇𝗀𝖾𝗄𝗌𝖾𝗄𝗎𝗌𝗂`;

    const jsonPayload = serializePayload(payloadForRelay);

    await conn.sendMessage(
      jid,
      {
        document: Buffer.from(jsFileContent),
        fileName: "crm_relay_snippet.js",
        mimetype: "application/javascript",
        caption: report,
      },
      { quoted: m },
    );

    console.log(inspect(m.quoted, { depth: null }));
    console.log(inspect(m, { depth: null }));
  },
};
