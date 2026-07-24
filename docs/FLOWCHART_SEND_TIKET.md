# Flowchart Send Tiket CCM

Dokumen ini berisi flowchart alur bot dari command masuk sampai tiket dikirim ke grup WhatsApp tujuan. Format diagram memakai Mermaid supaya bisa dirender langsung di GitHub, GitLab, VS Code extension Mermaid, atau mermaid.live.

## 1. Flow Utama

```mermaid
flowchart TD
  A[User kirim command + file Excel] --> B{Platform sumber}
  B -->|WhatsApp| C[WhatsApp Message Handler]
  B -->|Telegram| D[Telegram Command Handler]

  C --> E[Validasi akses]
  D --> E

  E -->|Tidak diizinkan| F[Balas akses ditolak]
  E -->|Diizinkan| G{Command valid?}

  G -->|Tidak ada command| H[Abaikan file]
  G -->|.import / .send| I[Flow utama import]
  G -->|.update| J[Flow update tiket saja]
  G -->|.summary| K[Flow summary saja]

  I --> L[Parse Excel]
  J --> L
  K --> L

  L --> M[Filter dan normalisasi tiket]
  M --> N[Deduplication dan validasi data]

  N --> O{Mode proses}
  O -->|Import / Send| P[Kirim salam + file filter + summary + tiket]
  O -->|Update| Q[Kirim tiket saja]
  O -->|Summary| R[Kirim summary saja ke target WA]

  P --> S[Simpan riwayat tiket terkirim]
  Q --> S
  R --> T[Selesai]
  S --> T
```

## 2. Validasi Akses

```mermaid
flowchart TD
  A[Pesan masuk] --> B{Sumber pesan}

  B -->|WhatsApp Group| C{Group ada di authorized_groups?}
  B -->|WhatsApp Private| D{User admin atau authorized_users?}
  B -->|Telegram Group| E{Group ada di authorized_groups?}
  B -->|Telegram Private| F{User admin atau authorized_users?}

  C -->|Ya| G[Akses diizinkan]
  D -->|Ya| G
  E -->|Ya| G
  F -->|Ya| G

  C -->|Tidak| H[Akses ditolak]
  D -->|Tidak| H
  E -->|Tidak| H
  F -->|Tidak| H

  G --> I{Command}
  I -->|.import / .send| J[Proses import penuh]
  I -->|.update| K[Proses tiket saja]
  I -->|.summary| L[Proses summary saja]
  I -->|File tanpa command| M[Abaikan]
```

## 3. Parse dan Filter Excel

```mermaid
flowchart TD
  A[File Excel diterima] --> B[Download dokumen]
  B --> C[Parse workbook]
  C -->|Gagal parse XLSX asli| D[Coba fallback export web]
  D -->|Gagal| E[Balas file tidak valid]
  C -->|Berhasil| F[Ambil rows]
  D -->|Berhasil| F

  F --> G[Validasi header penting]
  G -->|Header kurang| H[Balas daftar kolom kurang]
  G -->|Header lengkap| I[Proses tiap row]

  I --> J[Normalisasi Assignment Group]
  J --> K{Assignment didukung?}
  K -->|Tidak| L[Skip: ASSIGNMENT_GROUP_NOT_SUPPORTED]
  K -->|Ya| M[Ambil city dari Kabupaten/Kota]

  M --> N{City kosong?}
  N -->|Ya| O[Ambil Site Cover dari Problem Analysis NSH]
  O --> P[Search city dari data site NOP]
  N -->|Tidak| Q[Search PIC berdasarkan city]
  P --> Q

  Q --> R{City/PIC ditemukan?}
  R -->|Tidak| S[Skip: CITY_NOT_FOUND]
  R -->|Ya| T[Ambil site, vendor, cluster area]
  T --> U[Hitung SLA 22 jam]
  U --> V[Build tiket valid]
```

## 4. Resolusi PIC dan Target

```mermaid
flowchart TD
  A[Tiket valid awal] --> B{Assignment type}

  B -->|SQA| C[Ambil PIC CCM dari ccm_handling]
  C --> D[Ambil PIC SQA dari ccm_handling]
  D --> E[PIC NOP dikosongkan]
  E --> F[Target group SQA]

  B -->|NOP| G[PIC CCM dikosongkan]
  G --> H[PIC SQA dikosongkan]
  H --> I[Ambil PIC NOP dari data site/NOP]
  I --> J[Target group NOP sesuai departemen_ns]

  F --> K{JID target tersedia?}
  J --> K

  K -->|Ya| L[Masuk antrian target]
  K -->|Tidak| M[Alert ke pengirim: target group kosong]
```

## 5. Validasi Notes dan Analysis

```mermaid
flowchart TD
  A[Tiket valid] --> B{Notes kosong?}

  B -->|Tidak| C[Gunakan Description Fault Sumptomps]
  B -->|Ya| D[Build fallback notes]

  D --> E[Problem Start Time]
  E --> F[Customer Interaction Date]
  F --> G[Customer MSISDN]
  G --> H[Alamat dari desa, kecamatan, kabupaten/kota]
  H --> I[Complaint Detail dari Description]

  C --> J{Analysis valid?}
  I --> J

  J -->|Valid| K[Gunakan CCH Suggestion]
  J -->|Kosong / null / root cause not found| L[Fallback ke Problem Analysis NSH]

  L --> M{Fallback tersedia?}
  M -->|Ya| N[Catat: data tidak lengkap yang dikirim]
  M -->|Tidak| O[Catat: data tidak lengkap butuh bantuan]

  K --> P[Data siap kirim]
  N --> P
  O --> Q[Tiket tidak dikirim]
```

## 6. Business Status dan Template Pesan

```mermaid
flowchart TD
  A[Tiket siap kirim] --> B{Business Status}

  B -->|ReOpen| C[Cek kolom L2/ReOpen]
  C --> D{Kolom L2 berisi data?}

  D -->|Ya| E[Gunakan template ReOpen pendek]
  D -->|Tidak| F[Gunakan template tiket biasa]
  B -->|IN PROGRESS / lainnya| F

  E --> G[Ambil Reopen Number]
  G --> H[Hapus .0 dari angka reopen]
  H --> I[Tambahkan Remark Problem Analysis]
  I --> J[Tambahkan SLA Due Date]

  F --> K[Tambahkan notes]
  K --> L[Tambahkan analysis]
  L --> J
```

## 7. Deduplication

```mermaid
flowchart TD
  A[Tiket hasil filter] --> B[Baca riwayat data/runtime/sent_tickets.json]
  B --> C{Order ID pernah dikirim hari ini?}

  C -->|Tidak| D[Tiket boleh dikirim]
  C -->|Ya| E{Status berubah dari IN PROGRESS ke ReOpen?}

  E -->|Ya| F[Kirim ulang dengan template ReOpen]
  E -->|Tidak| G[Skip duplicate]

  D --> H{SLA Status}
  F --> H

  H -->|IN SLA| I[Kirim normal sesuai status bisnis]
  H -->|OUT SLA| J[Tetap kirim sebagai reminder]

  I --> K[Simpan riwayat kirim hari ini]
  J --> K
  G --> L[Masuk report duplicate]
```

## 8. Mode Pengiriman

```mermaid
flowchart TD
  A[Mode proses] --> B{Command}

  B -->|.import / .send| C[Kirim salam pembuka]
  C --> D[Kirim file Excel hasil filter]
  D --> E[Kirim dedupe report]
  E --> F[Kirim SQA area follow up message]
  F --> G[Kirim summary per target WA]
  G --> H[Kirim detail tiket]

  B -->|.update| I[Skip salam, file, dan summary]
  I --> H

  B -->|.summary| J[Skip detail tiket]
  J --> K[Kirim summary saja ke target WA]

  H --> L[Queue pengiriman]
  K --> M[Selesai]
  L --> M
```

## 9. Queue dan Rate Limit

```mermaid
flowchart TD
  A[Daftar tiket per target] --> B[Ambil target pertama]
  B --> C[Kirim tiket satu per satu]
  C --> D[Tunggu 5 detik tiap tiket]
  D --> E{Sudah 10 tiket pada target ini?}

  E -->|Ya| F[Jeda tambahan]
  E -->|Tidak| G{Tiket target selesai?}
  F --> G

  G -->|Tidak| C
  G -->|Ya| H[Kirim progress ke Telegram]
  H --> I{Masih ada target berikutnya?}

  I -->|Ya| J[Jeda 10 detik]
  J --> B
  I -->|Tidak| K[Kirim final progress]
```

## 10. Environment Config

```mermaid
flowchart TD
  A[Bot butuh config WhatsApp] --> B{WHATSAPP_CONFIG_PATH diisi?}

  B -->|Ya| C[Gunakan path manual]
  C --> D[/change_env dikunci]

  B -->|Tidak| E[Baca data/runtime/app_runtime_env.json]
  E --> F{Environment aktif}

  F -->|production| G[config/whatsapp.json]
  F -->|development| H[config/whatsapp-test.json]
  F -->|Kosong| I[APP_ENV atau default production]

  I --> G
  G --> J[Load authorized_groups, authorized_users, target_groups, mentions]
  H --> J
```

## 11. Ringkasan Flowchart Singkat

```mermaid
flowchart LR
  A[Command + Excel] --> B[Access Check]
  B --> C[Parse Excel]
  C --> D[Filter Assignment]
  D --> E[Lookup City/Site/PIC]
  E --> F[SLA + Business Status]
  F --> G[Fallback Notes/Analysis]
  G --> H[Deduplicate]
  H --> I[Group by Target]
  I --> J[Send Summary/File/Ticket]
  J --> K[Save Sent History]
```
