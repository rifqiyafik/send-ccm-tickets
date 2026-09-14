// menormalkan JID user agar device id seperti 628xx:12@s.whatsapp.net tetap cocok dan memperbaiki duplikasi suffix domain (seperti @g.us@g.us).
export function normalizeJid(jid) {
  let cleaned = String(jid || "")
    .trim()
    .replace(/:\d+@/, "@");

  if (cleaned.includes("@g.us")) {
    cleaned = cleaned.replace(/(@g\.us)+/gi, "@g.us");
  } else if (cleaned.includes("@s.whatsapp.net")) {
    cleaned = cleaned.replace(/(@s\.whatsapp\.net)+/gi, "@s.whatsapp.net");
  } else if (cleaned.includes("@lid")) {
    cleaned = cleaned.replace(/(@lid)+/gi, "@lid");
  }

  return cleaned;
}

// mengambil JID pengirim asli, baik dari private chat maupun pesan grup.
export function getMessageSenderJid(message) {
  return normalizeJid(message?.key?.participant || message?.participant || message?.key?.remoteJid);
}

// mengambil JID akun bot dari object socket Baileys.
export function getSocketUserJid(sock) {
  return normalizeJid(sock?.user?.id || sock?.user?.jid);
}

// mendeteksi JID grup WhatsApp.
export function isGroupJid(jid) {
  return normalizeJid(jid).endsWith("@g.us");
}

// mendeteksi chat pribadi agar command registrasi bisa memberi konteks yang benar.
export function isPrivateJid(jid) {
  return normalizeJid(jid).endsWith("@s.whatsapp.net") || normalizeJid(jid).endsWith("@lid");
}
