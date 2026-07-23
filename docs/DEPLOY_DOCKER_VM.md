# Deploy Docker ke VM

Panduan ini untuk menjalankan bot di VM dengan akses terbatas:

- Tidak memakai `sudo`.
- Tidak memakai `scp`.
- Semua file dibuat hanya di dalam folder `sqa-sumbagut`.
- VM hanya melakukan `docker pull` image dari GHCR, bukan build source code.
- Runtime data tetap persistent lewat folder `config`, `sessions`, `data/runtime`, `downloads`, dan `logs`.
- File reference `data/pic_nop_region_sumbagut.json` dan `data/ccm_handling_sqa_region_sumbagut.json` sudah ikut repository dan image Docker, jadi tidak perlu dibuat manual di VM.

CI/CD project disiapkan dari branch `master`. Push atau merge ke `master` akan menjalankan test, build image Docker, dan push image ke GHCR. Untuk saat ini deploy VM dilakukan manual.

## 1. Pastikan Image Sudah Ada di GHCR

Contoh image:

```text
ghcr.io/USERNAME/send-ccm-ticket:latest
```

Ganti `USERNAME` dengan owner GitHub/GHCR kamu. Nama image harus lowercase.

## 2. Masuk ke Folder yang Diizinkan di VM

Semua file dibuat di dalam `sqa-sumbagut`.

```bash
cd ~/sqa-sumbagut
mkdir -p send-ccm-ticket
cd send-ccm-ticket
mkdir -p config sessions data downloads logs
mkdir -p data/runtime
```

Struktur akhirnya:

```text
~/sqa-sumbagut/send-ccm-ticket/
├── .env
├── docker-compose.yml
├── config/
├── sessions/
├── data/
│   └── runtime/
├── downloads/
└── logs/
```

## 3. Buat File `.env`

Jalankan:

```bash
nano .env
```

Paste template berikut, lalu isi nilai yang diperlukan:

```env
APP_IMAGE=ghcr.io/USERNAME/send-ccm-ticket:latest
APP_UID=1000
APP_GID=1000

LOG_LEVEL=info
LOG_COLOR=false
BAILEYS_LOG_LEVEL=silent
WA_WEB_VERSION=

WA_AUTH_DIR=sessions/baileys
WA_SESSION_ROOT=sessions/whatsapp
WA_SESSION_REGISTRY_PATH=data/runtime/whatsapp_sessions.json
WA_AUTO_START=false
CCM_HANDLING_DATA_PATH=
NOP_SITE_DATA_PATH=

TELEGRAM_BOT_TOKEN=ISI_TOKEN_BOT_TELEGRAM
TELEGRAM_ADMIN_CHAT_IDS=ISI_CHAT_ID_ADMIN_TELEGRAM
TELEGRAM_POLL_TIMEOUT_SECONDS=30
TELEGRAM_ACCESS_CONFIG_PATH=config/telegram.json

OWNER_JIDS=
JID_SEARCH_LIMIT=50

WA_SEND_DELAY_MS=5000
WA_BATCH_SIZE=10
WA_BATCH_EXTRA_DELAY_MS=5000
SENT_TICKET_STORE_PATH=data/runtime/sent_tickets.json
SENT_TICKET_RETENTION_DAYS=7

WHATSAPP_GROUPS=
```

Wajib dicek:

- `APP_IMAGE` harus sesuai image GHCR.
- `APP_UID` dan `APP_GID` harus sesuai user VM kamu.
- `TELEGRAM_BOT_TOKEN` harus diisi.
- `TELEGRAM_ADMIN_CHAT_IDS` harus diisi dengan chat ID admin Telegram.

Ambil nilai UID/GID di VM:

```bash
id -u
id -g
```

Lalu isi ke `.env`, contoh:

```env
APP_UID=1002
APP_GID=1002
```

Ini penting karena bot perlu menulis file seperti:

```text
sessions/whatsapp/*
data/runtime/whatsapp_sessions.json
data/runtime/sent_tickets.json
```

## 4. Buat `docker-compose.yml`

Jalankan:

```bash
nano docker-compose.yml
```

Paste:

```yaml
services:
  ccm-ticket-bot:
    image: ${APP_IMAGE:-send-ccm-ticket:latest}
    container_name: send-ccm-ticket
    restart: unless-stopped
    init: true
    user: "${APP_UID:-1000}:${APP_GID:-1000}"
    env_file:
      - .env
    environment:
      NODE_ENV: production
      TZ: Asia/Jakarta
    volumes:
      - ./config:/app/config
      - ./sessions:/app/sessions
      - ./data/runtime:/app/data/runtime
      - ./downloads:/app/downloads
      - ./logs:/app/logs
```

Compose ini tidak punya `build:` karena VM hanya menjalankan image yang sudah dipush ke GHCR.

## 5. Buat Config WhatsApp

Jalankan:

```bash
nano config/whatsapp.json
```

Paste isi file lokal `config/whatsapp.json`.

Minimal struktur:

```json
{
  "authorized_groups": {},
  "authorized_users": {},
  "target_groups": {},
  "mentions": {}
}
```

Pastikan bagian berikut sudah benar:

- `authorized_groups`: grup WA yang boleh menjalankan bot.
- `authorized_users`: akun private WA yang boleh memakai bot langsung.
- `target_groups`: grup tujuan pengiriman tiket, contoh `SQA`, `MAIN SQA`, `NOP MEDAN`.
- `mentions`: mapping nama PIC ke JID dan label mention.

## 6. Buat Config Telegram

Jalankan:

```bash
nano config/telegram.json
```

Paste isi file lokal `config/telegram.json`.

Minimal struktur:

```json
{
  "authorized_groups": {},
  "authorized_users": {}
}
```

Catatan:

- Telegram group ID biasanya diawali `-100`.
- Telegram private chat ID biasanya angka positif.
- Admin utama tetap dari `.env` bagian `TELEGRAM_ADMIN_CHAT_IDS`.

## 7. Data Reference

Tidak perlu membuat file reference manual di VM.

File berikut sudah masuk repository dan ikut image Docker:

```text
data/pic_nop_region_sumbagut.json
data/ccm_handling_sqa_region_sumbagut.json
```

Saat build image, dua file itu juga disalin ke:

```text
/app/reference-data/pic_nop_region_sumbagut.json
/app/reference-data/ccm_handling_sqa_region_sumbagut.json
```

Ini membuat aplikasi tetap aman walaupun ada mount lama yang menimpa `/app/data`.

Tetap jangan mount seluruh folder `data` ke container. Compose hanya mount:

```text
./data/runtime:/app/data/runtime
```

Folder `data/runtime` hanya dipakai untuk file runtime seperti:

```text
data/runtime/sent_tickets.json
```

## 8. Login GHCR dari VM

Jalankan:

```bash
docker login ghcr.io -u USERNAME
```

Saat diminta password, paste GitHub token yang punya permission:

```text
read:packages
```

Jika image public, login bisa saja tidak diperlukan. Jika pull gagal unauthorized, login wajib.

## 9. Pull dan Jalankan Bot

Pastikan masih di folder:

```bash
cd ~/sqa-sumbagut/send-ccm-ticket
```

Validasi compose:

```bash
docker compose config
```

Pull image:

```bash
docker compose pull
```

Pastikan semua folder mount bisa ditulis oleh user VM:

```bash
mkdir -p config sessions data/runtime downloads logs
chmod -R u+rwX config sessions data downloads logs
touch config/.write-test sessions/.write-test data/runtime/.write-test downloads/.write-test logs/.write-test
rm -f config/.write-test sessions/.write-test data/runtime/.write-test downloads/.write-test logs/.write-test
```

Pastikan container juga berjalan memakai UID/GID user VM dan bisa menulis ke mount:

```bash
docker compose run --rm ccm-ticket-bot sh -lc "id && touch /app/config/.write-test /app/sessions/.write-test /app/data/runtime/.write-test /app/downloads/.write-test /app/logs/.write-test && rm -f /app/config/.write-test /app/sessions/.write-test /app/data/runtime/.write-test /app/downloads/.write-test /app/logs/.write-test && echo MOUNT_WRITE_OK"
```

Jika command ini gagal `permission denied`, cek ulang `APP_UID`, `APP_GID`, dan ownership folder di dalam `~/sqa-sumbagut/send-ccm-ticket`.

Jalankan container:

```bash
docker compose up -d
```

Lihat log:

```bash
docker compose logs -f ccm-ticket-bot
```

Jika log menunjukkan Telegram bot polling/start tanpa error, aplikasi sudah berjalan.

## 10. Login WhatsApp dari Telegram

Dari akun Telegram admin, kirim:

```text
/sessions
```

Jika belum ada session:

```text
/login 628xxxxxxxxxx
```

Bot akan bertanya nama session. Balas contoh:

```text
Rifqi
```

Setelah itu bot mengirim QR. Scan dari WhatsApp:

```text
WhatsApp > Linked Devices > Link a Device
```

Jika berhasil, session tersimpan di:

```text
~/sqa-sumbagut/send-ccm-ticket/sessions
~/sqa-sumbagut/send-ccm-ticket/data/runtime/whatsapp_sessions.json
```

## 11. Test Flow Program

Tes dari Telegram admin:

```text
/status
/sessions
```

Tes dari grup/user yang sudah whitelist:

1. Kirim file Excel dengan caption `.summary` untuk cek summary saja.
2. Jika hasilnya benar, kirim file Excel dengan caption `.import` atau `.send`.
3. Untuk kirim tiket tanpa salam dan summary, pakai caption `.update`.

Jika file dikirim tanpa caption command, bot memang tidak memproses apa pun.

## 12. Update Manual Setelah Image Baru Dipush

Jalankan di VM:

```bash
cd ~/sqa-sumbagut/send-ccm-ticket
docker compose pull
docker compose up -d
docker compose logs -f ccm-ticket-bot
```

Folder runtime tidak hilang karena semuanya di-mount:

```text
config/
sessions/
data/runtime/
downloads/
logs/
```

## 13. Stop dan Restart

Stop:

```bash
docker compose down
```

Start ulang:

```bash
docker compose up -d
docker compose logs -f ccm-ticket-bot
```

Restart cepat:

```bash
docker compose restart ccm-ticket-bot
```

## 14. Troubleshooting

Jika `docker` tidak bisa dijalankan:

```text
permission denied
```

Berarti user VM belum punya akses Docker. Ini perlu admin VM yang memperbaiki permission Docker. Dari user terbatas, tidak bisa diselesaikan tanpa bantuan admin.

Jika muncul error permission seperti:

```text
EACCES: permission denied, open 'config/whatsapp_sessions.json'
```

Ini berarti registry session masih diarahkan ke folder `config` atau folder mount tidak writable. Registry session adalah data runtime, jadi arahkan ke `data/runtime`.

Pastikan `.env` berisi:

```env
WA_SESSION_REGISTRY_PATH=data/runtime/whatsapp_sessions.json
```

Pastikan juga `.env` berisi UID/GID user VM:

```bash
id -u
id -g
nano .env
```

Set:

```env
APP_UID=hasil_id_u
APP_GID=hasil_id_g
```

Pastikan folder runtime writable oleh user kamu:

```bash
chmod -R u+rwX config sessions data downloads logs
```

Lalu restart:

```bash
docker compose down
docker compose up -d
docker compose logs -f ccm-ticket-bot
```

Jika `docker compose pull` gagal unauthorized:

```bash
docker login ghcr.io -u USERNAME
```

Gunakan token dengan permission `read:packages`.

Jika container langsung restart:

```bash
docker compose logs --tail=200 ccm-ticket-bot
```

Cek biasanya salah satu dari ini:

- `.env` belum berisi `TELEGRAM_BOT_TOKEN`.
- `config/whatsapp.json` bukan JSON valid.
- `config/telegram.json` bukan JSON valid.
- File reference di `data/` belum lengkap.

Jika ingin cek file JSON valid dari VM:

```bash
docker run --rm -v "$PWD:/app" node:22-bookworm-slim node -e "JSON.parse(require('fs').readFileSync('/app/config/whatsapp.json','utf8')); JSON.parse(require('fs').readFileSync('/app/config/telegram.json','utf8')); console.log('JSON OK')"
```

Jika WhatsApp tidak connected:

1. Cek `/sessions`.
2. Jalankan `/login nomor_hp`.
3. Scan QR ulang.

Jika ingin hapus session lokal dari Telegram admin:

```text
/delete_session 1
```

Lalu login ulang dengan:

```text
/login nomor_hp
```
