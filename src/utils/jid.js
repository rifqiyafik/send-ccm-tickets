// menormalkan JID user agar device id seperti 628xx:12@s.whatsapp.net tetap cocok saat dicek.
export function normalizeJid(jid) {
  return String(jid || "")
    .trim()
    .replace(/:\d+@/, "@");
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
