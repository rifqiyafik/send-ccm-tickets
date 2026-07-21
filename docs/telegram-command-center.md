# Telegram Command Center

Dokumen ini menjelaskan struktur bot Telegram yang mengontrol session WhatsApp.

## Struktur File

```text
src/
  bots/
    telegramBot.js                 # long polling Telegram Bot API tanpa dependency tambahan
  config/
    telegramConfig.js              # membaca TELEGRAM_BOT_TOKEN dan TELEGRAM_ADMIN_CHAT_IDS
  handlers/
    telegramCommandHandler.js      # routing command /start, /help, /status, /login, /logout
    whatsappMessageHandler.js      # handler WhatsApp untuk file Excel dan pengiriman tiket
  services/
    whatsappSessionService.js      # kontrol start/logout session WhatsApp dari Telegram
```

## Environment

```env
TELEGRAM_BOT_TOKEN=isi_token_dari_botfather
TELEGRAM_ADMIN_CHAT_IDS=123456789
TELEGRAM_POLL_TIMEOUT_SECONDS=30
WA_AUTH_DIR=sessions/baileys
WA_AUTO_START=false
```

Jika `TELEGRAM_ADMIN_CHAT_IDS` belum diisi, kirim `/start` ke bot Telegram.
Bot akan membalas `Chat ID kamu`, lalu masukkan ID tersebut ke `.env`.

## Command Telegram

- `/start` atau `/help`: menampilkan bantuan.
- `/status`: melihat status session WhatsApp.
- `/login`: menyalakan WhatsApp bot dan mengirim QR login ke Telegram.
- `/logout`: logout WhatsApp dan menghapus folder session lokal.
- `/groups [keyword]`: mencari JID grup WhatsApp dari session aktif.
- `/private [keyword]`: mencari JID private chat/kontak yang sudah ter-index.

## Flow Login

1. Jalankan `npm start`.
2. Kirim `/login` ke bot Telegram dari chat admin.
3. Jika session WhatsApp belum aktif, QR akan dikirim ke Telegram.
4. Scan QR dari WhatsApp > Linked devices > Link a device.
5. Setelah connected, file Excel tetap dikirim ke grup/private WhatsApp yang sudah whitelist.

## Flow Logout

1. Kirim `/logout` ke bot Telegram.
2. Bot memanggil logout Baileys.
3. Folder `sessions/baileys` dihapus.
4. Login berikutnya wajib scan QR baru lewat `/login`.
