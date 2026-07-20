# WhatsApp CCM Ticket Bot

Bot ini menerima file Excel tiket customer complaint dari WhatsApp, membaca kolom `Kabupaten/Kota(Create Ticket)` dan `Assign to L2(L2 Assign)`, lalu menentukan PIC dari `data/ccm_handling_sqa_region_sumbagut.json`.

## Flow Tahap Ini

1. User mengirim file `.xlsx` ke bot WhatsApp.
2. Bot download dokumen via Baileys.
3. Bot parse sheet pertama Excel.
4. Bot validasi header wajib.
5. Bot ambil city dari kolom `Kabupaten/Kota(Create Ticket)`.
6. Bot normalize assignment group dari kolom `Assign to L2(L2 Assign)`.
7. Bot search city ke `ccm_handling_sqa_region_sumbagut.json`.
8. Jika assignment group SQA, `pic = pic_sqa`.
9. Jika assignment group NOP, `pic = pic_nop`.
10. Bot kirim summary dan pesan tiket.

Bot hanya memproses file dari `authorized_groups` atau private chat dari `authorized_users`.
Hasil tiket dikirim ke `target_groups`; jika target belum diisi, fallback terakhir adalah chat pengirim file.

## Install Manual

Jalankan sendiri dari root project:

```powershell
npm install
```

## Konfigurasi

Salin `.env.example` menjadi `.env`, lalu isi `config/whatsapp.json` untuk whitelist akses dan grup tujuan.

```powershell
Copy-Item .env.example .env
```

Contoh struktur utama `config/whatsapp.json`:

```json
{
  "authorized_groups": {},
  "authorized_users": {},
  "target_groups": {},
  "mentions": {}
}
```

Penamaan:

1. `authorized_groups`: grup yang boleh menjalankan bot / kirim file Excel.
2. `target_groups`: grup tujuan pengiriman tiket hasil filter.
3. `authorized_users`: akun pribadi yang boleh chat bot langsung.

## Menjalankan Bot

```powershell
npm start
```

Saat pertama kali jalan, terminal akan menampilkan QR. Scan dari WhatsApp.

## Test Manual

```powershell
npm test
```

## Dokumentasi Flow

Detail filterisasi dari awal sampai output ada di:

- `docs/FLOW_FILTERISASI_TIKET.md`

## Struktur Folder

- `index.js`: entry point bot.
- `src/handlers/whatsappMessageHandler.js`: koneksi Baileys, QR login, event pesan masuk, dan download dokumen.
- `src/services/ticketImportService.js`: parse Excel, validasi header, filter tiket, SLA, format pesan, dan output Excel.
- `src/services/picSearchService.js`: search PIC berdasarkan city dan assignment group.
- `src/services/siteSearchService.js`: fallback city/site dari `Problem Analysis NSH`.
- `src/config/whatsappRouting.js`: routing tiket ke JID grup WhatsApp.
- `src/utils/`: helper umum seperti logger, parser JSON, tanggal, dan text formatter.
- `sessions/`: session login WhatsApp/Baileys.
- `downloads/`: tempat file/media runtime jika nanti perlu disimpan.
- `logs/`: tempat log file jika nanti logger diarahkan ke file.
