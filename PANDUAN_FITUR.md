# 📘 Panduan Lengkap Fitur Sistem Send-CCM-Ticket
**Dokumentasi Resmi Fitur, Perintah Pemicu (Keywords), dan Alur Otomasi Sistem**

---

## 📑 DAFTAR ISI
1. [Fitur Pemrosesan & Pengiriman File Excel/CSV](#1-fitur-pemrosesan--pengiriman-file-excelcsv)
2. [Fitur Manajemen & Kontrol Bot via Telegram](#2-fitur-manajemen--kontrol-bot-via-telegram)
3. [Fitur Monitoring & Perintah Bantuan di WhatsApp](#3-fitur-monitoring--perintah-bantuan-di-whatsapp)
4. [Fitur Otomasi Cerdas & Logika Bisnis (Core Engine)](#4-fitur-otomasi-cerdas--logika-bisnis-core-engine)

---

## 1. Fitur Pemrosesan & Pengiriman File Excel/CSV
Fitur ini dipicu saat pengguna mengunggah file spreadsheet (`.xlsx` atau `.csv`) ke bot **Telegram** maupun **WhatsApp**, baik tanpa caption atau menggunakan kata kunci (*caption*) tertentu.

---

>>> Import & Distribusi Tiket Lengkap (Normal Mode)
Membaca file Excel/CSV, memvalidasi header, memfilter tiket untuk Regional 1 (Sumbagut), menghitung SLA 22 jam, mencari PIC SQA/NOP berdasarkan kota/site, memverifikasi riwayat agar tidak terjadi duplikasi kirim, lalu mendistribusikan pesan pembuka, detail tiket, file Excel hasil filter, dan ringkasan reminder ke grup target WhatsApp.
Contoh Perintah / Kata Kunci:
- Mengunggah file Excel **tanpa caption**
- Mengunggah file Excel dengan caption: `.import`
- Mengunggah file Excel dengan caption: `.send`

---

>>> Kirim Cepat Tiket Baru (.update / .ticket)
Digunakan untuk mendistribusikan tiket baru secara instan dan ringkas ke grup WhatsApp target. Pada mode ini, salam pembuka, lampiran file Excel terfilter, dan reminder summary **tidak dikirim**, melainkan hanya pesan kartu tiket baru yang belum pernah dikirim hari ini.
Contoh Perintah / Kata Kunci:
- Mengunggah file Excel dengan caption: `.update`
- Mengunggah file Excel dengan caption: `.ticket`

---

>>> Ringkasan & Rekapitulasi Tiket Saja (.summary)
Membuat laporan rekapitulasi data tiket tanpa mendistribusikan pesan detail tiket satu per satu ke grup target WhatsApp. Sangat berguna untuk monitoring jumlah tiket valid, tiket in-progress, dan anomali tanpa membanjiri chat grup.
Contoh Perintah / Kata Kunci:
- Mengunggah file Excel dengan caption: `.summary`

---

>>> Injeksi Master Data Historis ke Database (.inject)
Menyimpan dan memperbarui seluruh data tiket dari file Excel langsung ke database master PostgreSQL (`SQA_SUMBAGUT.inap_ticketing_customer_complain`) tanpa mengirimkan pesan apa pun ke grup WhatsApp. Sistem secara otomatis membuat ground truth kolom `date` (YYYY-MM-DD) dari Order ID, menstandarkan timestamp WIB, dan menampilkan tabel preview summary di Telegram yang aman dari limit rate Telegram. Mendukung filter per bulan tertentu.
Contoh Perintah / Kata Kunci:
- Mengunggah file Excel dengan caption: `.inject` *(menginjeksi seluruh bulan di file)*
- Mengunggah file Excel dengan caption: `.inject mei` *(hanya menampilkan ringkasan bulan Mei)*
- Mengunggah file Excel dengan caption: `.inject 2025-05`
- Mengunggah file Excel dengan caption: `.inject januari`

---

>>> Mode Darurat / Force Resend (.special)
Mem-bypass pengecekan duplikasi harian pada database dan riwayat pengiriman tiket. Seluruh tiket yang valid di dalam file akan dipaksa dikirimkan ulang ke grup target WhatsApp meskipun tiket tersebut sudah pernah dikirim pada hari yang sama.
Contoh Perintah / Kata Kunci:
- Mengunggah file Excel dengan caption: `.special`

---

>>> Mode Penanganan Tiket ReOpen (.reopen)
Mengaktifkan mode khusus untuk memfilter dan memproses tiket dengan status ReOpen. Tiket dengan ReOpen berulang (ReOpen $\ge 3$) akan diarahkan secara otomatis ke penanganan khusus Tim Site Visit beserta catatan analisis call center yang telah dibersihkan.
Contoh Perintah / Kata Kunci:
- Mengunggah file Excel dengan caption: `.reopen`

---

>>> Mode Review Manual (.manual)
Memproses tiket dalam mode persiapan manual tanpa langsung meneruskannya ke antrean pengiriman otomatis grup WhatsApp.
Contoh Perintah / Kata Kunci:
- Mengunggah file Excel dengan caption: `.manual`

---

>>> Pembatalan Pengiriman Tiket Berjalan (.cancel / /cancel)
Menghentikan secara darurat seluruh antrean pengiriman tiket WhatsApp yang sedang berjalan atau terjadwal dalam jeda pacing queue.
Contoh Perintah / Kata Kunci:
- Mengetik: `.cancel` *(pada WhatsApp maupun Telegram)*
- Mengetik: `/cancel` *(pada Telegram)*

---

## 2. Fitur Manajemen & Kontrol Bot via Telegram
Fitur kontrol administratif sistem yang dapat dijalankan melalui bot Telegram resmi oleh pengguna atau grup yang telah diotorisasi.

---

>>> Start & Orientasi Pengguna (/start)
Menampilkan salam pembuka, ringkasan fungsionalitas bot, serta panduan cepat langkah awal penggunaan bot CCM Telegram.
Contoh Perintah:
- `/start`

---

>>> Menu Panduan Lengkap (/help)
Menampilkan seluruh dokumentasi perintah bot, aturan hak akses, format file Excel yang didukung, serta contoh-contoh penggunaan. Tampilan disesuaikan secara otomatis antara chat pribadi dan grup.
Contoh Perintah:
- `/help`

---

>>> Pendaftaran Chat & Pengguna (/register)
Mendaftarkan Chat ID pengguna pribadi atau grup Telegram ke dalam whitelist agar diizinkan berinteraksi dan mengunggah file ke bot. Administrator dapat mendaftarkan ID chat lain secara langsung.
Contoh Perintah:
- `/register` *(mendaftarkan chat saat ini)*
- `/register 123456789 user Budi_SQA` *(mendaftarkan ID pengguna spesifik)*
- `/register -1001234567890 group Grup_Koordinasi_CCM` *(mendaftarkan grup spesifik)*

---

>>> Cek Daftar Whitelist (/whitelist)
Melihat daftar seluruh pengguna pribadi dan grup Telegram yang telah terdaftar serta memiliki izin akses ke bot.
Contoh Perintah:
- `/whitelist`

---

>>> Cek Environment Aktif (/env)
Melihat environment runtime yang sedang digunakan bot (apakah berjalan di mode `production` atau `development/dev`), beserta path file konfigurasi aktif.
Contoh Perintah:
- `/env`

---

>>> Ganti Environment Runtime (/change_env)
Mengubah environment runtime aplikasi secara langsung tanpa perlu mematikan atau me-restart server bot.
Contoh Perintah:
- `/change_env dev`
- `/change_env production`

---

>>> Cek Status Sistem & WhatsApp (/status)
Menampilkan status kesehatan sistem, status koneksi socket Baileys WhatsApp, nomor sesi aktif, serta jumlah antrean pesan yang sedang berjalan.
Contoh Perintah:
- `/status`

---

>>> Monitoring Auto-Polling Database (/poll atau /autopoll)
Melihat status operasional worker auto-polling berkala ke database ClickHouse/PostgreSQL, termasuk jadwal interval, timestamp watermark terakhir, dan total tiket yang berhasil ditarik hari ini.
Contoh Perintah:
- `/poll`
- `/autopoll`

---

>>> Tarik Tiket Database Instan (/fetch atau /poll now)
Memicu worker untuk langsung melakukan query dan memeriksa tiket baru yang berstatus running/L2 Assign di database ClickHouse saat ini juga tanpa menunggu jadwal polling berikutnya.
Contoh Perintah:
- `/fetch`
- `/poll now`

---

>>> Kontrol Jeda & Lanjut Auto-Polling (/poll off & /poll on)
Menghentikan sementara (pause) atau mengaktifkan kembali (resume) siklus auto-polling database tanpa perlu mematikan aplikasi bot.
Contoh Perintah:
- `/poll off` *(menjeda auto-polling)*
- `/poll stop`
- `/poll on` *(melanjutkan auto-polling)*
- `/poll start`

---

>>> Manajemen Multi-Sesi WhatsApp (/sessions)
Melihat daftar seluruh sesi akun WhatsApp yang tersimpan di sistem, status login masing-masing nomor, dan nomor yang sedang aktif digunakan untuk broadcast.
Contoh Perintah:
- `/sessions`

---

>>> Login & Pairing WhatsApp QR (/login)
Memulai proses pairing akun WhatsApp baru atau menyambungkan kembali sesi yang terputus dengan mengirimkan gambar QR code resmi langsung ke chat Telegram untuk dipindai.
Contoh Perintah:
- `/login` *(login ke sesi default/aktif)*
- `/login 6282160478546` *(login ke ID sesi nomor tertentu)*

---

>>> Putuskan Sesi WhatsApp Sementara (/stop)
Memutuskan koneksi socket WhatsApp yang sedang aktif tanpa menghapus kredensial login (sesi dapat disambungkan kembali di kemudian hari tanpa perlu scan QR ulang).
Contoh Perintah:
- `/stop`

---

>>> Logout Akun WhatsApp (/logout)
Melakukan logout resmi dari WhatsApp Web dan menghapus token kredensial autentikasi sesi saat ini dari sistem.
Contoh Perintah:
- `/logout`

---

>>> Hapus Sesi Tertentu (/delete_session)
Menghapus file kredensial dan rekaman konfigurasi untuk ID sesi nomor tertentu dari disk penyimpanan bot.
Contoh Perintah:
- `/delete_session 6282160478546`

---

>>> Cek Daftar Grup Target WhatsApp (/groups)
Menampilkan seluruh nama grup WhatsApp dan JID (`@g.us`) tujuan pengiriman tiket (seperti grup SQA, NOP Medan, NOP Binjai, NOP Siantar, NOP Rantau Prapat, NOP Sidempuan, NOP Aceh, dan Site Visit).
Contoh Perintah:
- `/groups`

---

>>> Mode Pengiriman Privat / Draft (/private)
Menampilkan daftar kontak WhatsApp pribadi terdaftar serta mengonfigurasi pengalihan kiriman tiket dalam bentuk draft pesan pribadi (bukan langsung disebar ke grup publik).
Contoh Perintah:
- `/private`

---

## 3. Fitur Monitoring & Perintah Bantuan di WhatsApp
Fitur yang dapat dijalankan langsung melalui chat WhatsApp dengan bot oleh pengguna atau grup yang telah masuk dalam whitelist.

---

>>> Menu Bantuan Cepat WhatsApp (. atau .help)
Menampilkan daftar perintah singkat yang tersedia di WhatsApp beserta penjelasan fungsinya.
Contoh Perintah:
- `.`
- `.help`

---

>>> Cek Status Bot di WhatsApp (.status)
Mengetahui apakah bot WhatsApp sedang online, versi runtime, nomor aktif, serta koneksi database.
Contoh Perintah:
- `.status`

---

>>> Cek Daftar JID Grup WhatsApp (.groups)
Menampilkan daftar seluruh grup WhatsApp yang dikenali bot beserta kata kunci filter pencarian.
Contoh Perintah:
- `.groups`
- `.groups NOP`
- `.groups SQA`

---

>>> Cek Daftar JID Pengguna WhatsApp (.private)
Menampilkan daftar nomor dan JID pengguna pribadi (`@s.whatsapp.net`) yang berhak menerima draf atau komunikasi langsung dari bot.
Contoh Perintah:
- `.private`
- `.private SQA`

---

## 4. Fitur Otomasi Cerdas & Logika Bisnis (Core Engine)
Fitur backend otomatis yang bekerja secara cerdas di latar belakang untuk menjamin akurasi data tiket tanpa memerlukan perintah manual.

---

>>> Kalkulasi SLA 22 Jam Otomatis
Sistem secara otomatis menghitung tenggat waktu penyelesaian tiket (*Resolve Target*) tepat **22 Jam** sejak `Create Time` tiket dibuat.
- Jika waktu saat ini $\le$ Resolve Target $\rightarrow$ Status **`IN SLA`**.
- Jika waktu saat ini $>$ Resolve Target $\rightarrow$ Status **`OUT SLA`** disertai perhitungan durasi keterlambatan presisi (contoh: `Out 1d 13h 6m`).
- **Ground Truth Grounding**: Jika format waktu di Excel rusak atau berupa serial Excel (`45800.4305`), sistem secara cerdas mengekstrak tanggal dari `Order ID` (`CC-YYYYMMDD-...`), menjamin status tidak pernah menjadi `UNKNOWN`.

---

>>> Deteksi & Peringatan Tiket Salah Regional (Out-of-Region Detector)
Sistem memvalidasi setiap tiket apakah benar-benar wewenang Regional 1 (Sumbagut).
- Mendeteksi prefix Site ID di luar Sumbagut (contoh: `JKT`, `BKS`, `BDG`, `SMG`, `SBY`, `DPS`, `BJM`, `MKS`, `PLB`, `PKU`, dll.) serta alamat/kota pelanggan.
- Jika terdeteksi milik regional lain (misal Regional Jabotabek, Jawa Barat, atau Sumbagteng), tiket tidak dikirim ke grup Sumbagut, melainkan dimunculkan dalam kartu alert khusus pada laporan:
  ```text
  🚨 PERHATIAN: TIKET TERINDIKASI DI LUAR REGIONAL 1 (SUMBAGUT)
  • Order ID: CC-20260917-00000005
  • Dugaan Wilayah: Regional Jabotabek (Site Prefix: JKT)
  • Tindakan: Mohon cek CRM dan eskalasi/reassign ke Regional terkait.
  ```

---

>>> Resolusi Ground Truth Site ID & Kota Bertingkat
Sistem mencari Site ID dan Kota yang valid dengan urutan prioritas yang ketat:
1. Kolom Site ID langsung (`site_id1(L1 Assign)`).
2. Regex ekstraksi `#Site Cover` / `#SiteCover` dari kolom `Problem Analysis NSH` atau `CCH Suggestion`.
3. Pencocokan ke database master 6.901 site Sumbagut untuk melengkapi cluster area NOP, vendor, dan NSA.

---

>>> Eskalasi Tiket Berulang & ReOpen $\ge 3$ ke Tim Site Visit
- Tiket SQA yang mengalami ReOpen sebanyak $\ge 3$ kali atau berstatus repetitive secara otomatis dialihkan ke Tim Site Visit.
- Sistem mengekstrak catatan kendala call center murni (membersihkan template formal call center seperti `[HK][NO]`, `Nama Customer`, `DISAMPAIKAN HANYA JIKA DIBUTUHKAN`) sehingga teknisi lapangan mendapatkan inti permasalahan teknis yang padat dan jelas.

---

>>> Deduplikasi Harian & Pembersihan Otomatis Riwayat 14 Hari
- **Deduplikasi Ground Truth**: Setiap tiket dicatat berdasarkan `order_id PRIMARY KEY`. Tiket yang sudah terkirim hari ini tidak akan dikirim ulang secara ganda.
- **Pembersihan Otomatis**: Riwayat pengiriman di database PostgreSQL (`inap_sent_tickets_history`) yang sudah melewati **14 hari (2 minggu)** dibersihkan secara otomatis di latar belakang untuk menjaga performa database tetap optimal.

---

>>> Proteksi Anti-Spam & Limit Telegram (429 Rate Limit Shield)
Pada saat injeksi master data ribuan baris di Telegram:
- Sistem membatasi preview tabel summary maksimal 5 bagian (100 tiket) per bulan agar chat Telegram tetap bersih dan nyaman dibaca.
- Dilengkapi jeda pengiriman (*pacing delay* 400ms) dan proteksi *isolated error handling* sehingga error `Too Many Requests: retry after 66` dari Telegram Bot API tidak akan pernah membatalkan atau menggagalkan proses penyimpanan data ke database PostgreSQL.

---

>>> Pengingat Otomatis Penutupan Report Sore 17:00 WIB (Daily Inject Reminder)
- **Waktu Eksekusi**: Setiap hari kerja tepat pukul **17:00 WIB**.
- **Tujuan**: Mengingatkan Tim SQA agar melakukan filter di INAP (Regional 1, Customer Interaction Date From minggu lalu s/d Now), men-download file Excel (`Export All`), dan meng-upload file dengan caption `.inject` ke bot Telegram.
- **Proteksi Once-a-Day**: Dilengkapi pencatatan state `lastSentDate` (`data/runtime/daily_reminder_state.json`) sehingga reminder dijamin hanya terkirim sekali saja per hari meskipun bot di-restart.
- **Penerima Pesan**: Seluruh grup Telegram terdaftar (`authorized_groups`) dan target grup SQA (`target_groups.SQA`), serta dapat di-override melalui variabel `.env` `TELEGRAM_DAILY_REMINDER_CHAT_IDS`.
- **Trigger Manual**: Admin dapat melakukan tes kirim sewaktu-waktu menggunakan command `/remind_inject`.
