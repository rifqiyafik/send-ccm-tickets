# Deploy Docker ke VM

Panduan ini memakai Docker image agar bot bisa dipindahkan ke VM tanpa install dependency Node.js manual.

CI/CD project ini disiapkan dari branch `master`. Push atau merge ke `master` akan menjalankan test, build Docker image, push image ke GHCR, lalu deploy ke VM jika secret VM sudah diisi.

## 1. Siapkan File Lokal

Pastikan file runtime lokal sudah siap:

- `.env`
- `config/whatsapp.json`
- `config/telegram.json`
- `data/` berisi file reference PIC/site

Folder berikut akan dibuat dan dipakai sebagai data persistent:

- `sessions/` untuk credential WhatsApp Baileys
- `config/` untuk whitelist, target group, mention, dan registry session
- `data/` untuk reference dan `sent_tickets.json`
- `downloads/` untuk file/media runtime
- `logs/` untuk log runtime

## 2. Build Image Lokal

Jalankan dari root project:

```bash
docker build -t send-ccm-ticket:latest .
```

Tes image tanpa menjalankan bot:

```bash
docker run --rm send-ccm-ticket:latest node --check index.js
```

## 3. Jalankan Lokal dengan Compose

```bash
docker compose up -d
docker compose logs -f ccm-ticket-bot
```

Stop container:

```bash
docker compose down
```

## 4. Push Image ke Registry

Contoh memakai GitHub Container Registry.

Login:

```bash
echo YOUR_GITHUB_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

Tag image:

```bash
docker tag send-ccm-ticket:latest ghcr.io/YOUR_GITHUB_USERNAME/send-ccm-ticket:latest
```

Push:

```bash
docker push ghcr.io/YOUR_GITHUB_USERNAME/send-ccm-ticket:latest
```

## 4A. CI/CD dari Branch Master

Workflow GitHub Actions ada di `.github/workflows/ci-cd.yml`.

Trigger:

- `push` ke branch `master`
- `pull_request` ke branch `master`
- manual `workflow_dispatch`

Flow:

1. Install dependency dengan `npm ci`.
2. Syntax check `node --check index.js`.
3. Run test `npm test`.
4. Build Docker image.
5. Push image ke GitHub Container Registry:
   - `ghcr.io/<owner>/send-ccm-ticket:<commit_sha>`
   - `ghcr.io/<owner>/send-ccm-ticket:latest`
6. Deploy ke VM jika secret VM tersedia.

Repository secrets yang dibutuhkan untuk auto deploy:

- `VM_HOST`: IP/domain VM.
- `VM_USER`: user SSH di VM.
- `VM_SSH_KEY`: private key SSH.
- `VM_PORT`: port SSH, optional. Default `22`.
- `VM_APP_DIR`: folder app di VM, optional. Default `/opt/send-ccm-ticket`.

Jika secret VM belum diisi, workflow tetap build dan push image, tetapi deploy akan dilewati.

Sebelum merge dari branch development ke `master`:

```bash
git checkout master
git pull origin master
git merge dev
git push origin master
```

Jika remote default branch masih `main`, ubah trigger workflow atau rename branch remote ke `master`.

## 5. Setup VM

Install Docker dan Compose plugin di VM, lalu buat folder aplikasi:

```bash
sudo mkdir -p /opt/send-ccm-ticket
sudo chown -R $USER:$USER /opt/send-ccm-ticket
cd /opt/send-ccm-ticket
```

Buat struktur folder persistent:

```bash
mkdir -p config sessions data downloads logs
```

Copy file berikut dari lokal ke VM:

```bash
scp .env user@SERVER_IP:/opt/send-ccm-ticket/.env
scp docker-compose.yml user@SERVER_IP:/opt/send-ccm-ticket/docker-compose.yml
scp -r config/whatsapp.json config/telegram.json user@SERVER_IP:/opt/send-ccm-ticket/config/
scp -r data/* user@SERVER_IP:/opt/send-ccm-ticket/data/
```

Jika sudah punya session WhatsApp lokal dan ingin dipindahkan:

```bash
scp -r sessions/* user@SERVER_IP:/opt/send-ccm-ticket/sessions/
scp config/whatsapp_sessions.json user@SERVER_IP:/opt/send-ccm-ticket/config/whatsapp_sessions.json
```

Jika ingin login ulang dari Telegram, session tidak perlu dicopy. Jalankan `/login nomor_hp` dari Telegram setelah container hidup.

## 6. Pull dan Run di VM

Login registry dari VM:

```bash
echo YOUR_GITHUB_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

Set image yang akan dipakai:

```bash
export APP_IMAGE=ghcr.io/YOUR_GITHUB_USERNAME/send-ccm-ticket:latest
```

Pull dan jalankan:

```bash
docker compose pull
docker compose up -d
docker compose logs -f ccm-ticket-bot
```

Supaya `APP_IMAGE` permanen, tambahkan ke file `.env` di VM:

```env
APP_IMAGE=ghcr.io/YOUR_GITHUB_USERNAME/send-ccm-ticket:latest
```

## 7. Update Versi di VM

Setelah push image baru:

```bash
cd /opt/send-ccm-ticket
docker compose pull
docker compose up -d
docker compose logs -f ccm-ticket-bot
```

Container baru akan tetap memakai folder persistent yang sama.

## 8. Catatan Path

Semua path aplikasi berjalan relatif dari `/app` di container:

- `config/whatsapp.json`
- `config/telegram.json`
- `config/whatsapp_sessions.json`
- `sessions/whatsapp`
- `data/sent_tickets.json`
- `downloads`
- `logs`

Karena path tersebut di-mount dari host VM, data tidak hilang saat image/container diganti.

## 9. Troubleshooting

Jika Telegram tidak merespons:

```bash
docker compose logs -f ccm-ticket-bot
```

Periksa `.env`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_CHAT_IDS`
- `TELEGRAM_ACCESS_CONFIG_PATH=config/telegram.json`

Jika WhatsApp perlu login ulang:

1. Jalankan `/sessions` di Telegram.
2. Jalankan `/login nomor_hp`.
3. Isi nama session.
4. Scan QR dari WhatsApp Linked Devices.

Jika permission folder bermasalah di Linux VM:

```bash
sudo chown -R 1000:1000 /opt/send-ccm-ticket/config /opt/send-ccm-ticket/sessions /opt/send-ccm-ticket/data /opt/send-ccm-ticket/downloads /opt/send-ccm-ticket/logs
```
