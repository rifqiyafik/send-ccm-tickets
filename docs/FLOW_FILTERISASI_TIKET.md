# Flow Filterisasi Tiket CCM WhatsApp Bot

Dokumen ini menjelaskan alur pemrosesan file Excel tiket CCM dari awal diterima bot WhatsApp sampai tiket dikirim ke grup tujuan dan file Excel hasil filter dikirim balik.

## 1. Input File

Bot hanya memproses dokumen Excel `.xlsx` yang dikirim lewat WhatsApp.

File diproses oleh:

- `index.js`
- `src/handlers/whatsappMessageHandler.js`
- `src/services/ticketImportService.js`

Jika format bukan `.xlsx`, bot membalas bahwa format belum didukung.

## 2. Header Wajib

File Excel wajib memiliki kolom berikut:

- `Order ID`
- `Ticket Id`
- `Create Time`
- `Business Status`
- `Assign to L2(L2 Assign)`
- `Kabupaten/Kota(Create Ticket)`
- `site_id1(L1 Assign)`
- `Problem Analysis NSH`
- `CCH Suggestion(L1 Assign_cch_suggestion)`
- `Description Fault Sumptomps(Create Ticket_description__fault_symptomps)`
- `Customer MSISDN(Create Ticket_customer_msisdn)`

Jika ada kolom yang tidak ditemukan, proses dihentikan dan bot mengirim daftar kolom yang kurang.

## 3. Normalisasi Assignment Group

Kolom sumber:

```text
Assign to L2(L2 Assign)
```

Nilai dibersihkan dengan aturan:

1. Prefix `group:` dihapus.
2. Spasi berlebih dirapikan.
3. Nilai diubah ke huruf besar untuk search stabil.
4. Alias tertentu disamakan, misalnya:

```text
Network Operations and Productivity Banda Aceh
=> Network Operations and Productivity Aceh
```

Assignment valid:

- `Service Quality Assurance Sumbagut`
- `Network Operations and Productivity Aceh`
- `Network Operations and Productivity Binjai`
- `Network Operations and Productivity Medan`
- `Network Operations and Productivity Pematangsiantar`
- `Network Operations and Productivity Rantau Prapat`
- `Network Operations and Productivity Padang Sidempuan`

Assignment di luar pola SQA/NOP dilewati dengan reason:

```text
ASSIGNMENT_GROUP_NOT_SUPPORTED
```

## 4. Resolusi City

City utama diambil dari:

```text
Kabupaten/Kota(Create Ticket)
```

Jika kolom city kosong, sistem fallback ke:

```text
Problem Analysis NSH
```

Sistem mencari site ID dari pola:

```text
#Site Cover : MDN629
#SiteCover: BIR185
```

Site ID hasil ekstraksi dicari ke:

```text
data/pic_nop_region_sumbagut.json
```

Dari data site, sistem mengambil:

```text
kabupaten
```

sebagai city.

Jika city kosong dan site cover tidak ditemukan, tiket dilewati dengan reason:

```text
CITY_EMPTY_AND_SITE_COVER_NOT_FOUND
```

Jika site cover ada tetapi tidak ada di database NOP, tiket dilewati dengan reason:

```text
SITE_COVER_NOT_FOUND_IN_NOP_DATA
```

## 5. Resolusi Site, Vendor, dan Cluster Area

Site ID utama diambil dari:

```text
site_id1(L1 Assign)
```

Jika kosong, sistem fallback ke site ID dari `#Site Cover` di `Problem Analysis NSH`.

Site ID dicari ke:

```text
data/pic_nop_region_sumbagut.json
```

Data yang dipakai:

- `site_id` -> kolom `Site ID`
- `vendor` -> kolom `Vendor`
- `departement_ns` -> kolom `Cluster Area`

## 6. Search PIC

PIC dicari berdasarkan city ke:

```text
data/ccm_handling_sqa_region_sumbagut.json
```

Jika assignment group adalah SQA:

- `PIC CCM` diambil dari `ccm_handling`
- `PIC SQA` diambil dari `pic_sqa`
- `PIC NOP` dikosongkan

Jika assignment group adalah NOP:

- `PIC CCM` dikosongkan
- `PIC SQA` dikosongkan
- `PIC NOP` diambil dari `pic_nop`

Jika city tidak ditemukan di data CCM handling, tiket dilewati dengan reason:

```text
CITY_NOT_FOUND
```

## 7. SLA 22 Jam

SLA dihitung dari:

```text
Resolve Target 22 Hour = Create Time + 22 jam
```

Status SLA:

- `IN SLA`: waktu proses belum melewati resolve target
- `OUT SLA`: waktu proses sudah melewati resolve target
- `UNKNOWN`: `Create Time` tidak bisa dibaca sebagai tanggal

Format resolve target yang dipakai di pesan:

```text
Kamis / 16 Jul 2026, 08:15:19 PM
```

## 8. Output Excel Balasan

Setelah filter selesai, bot membuat file:

```text
filtered_ccm_tickets.xlsx
```

Header file output:

```text
Order ID | Create Time | Resolve Target 22 Hour | SLA Status | Business Status | Assigment Group | City | Vendor | PIC CCM | Cluster Area | Site ID | PIC SQA | PIC NOP
```

File ini dikirim balik ke chat pengirim file.

## 9. Format Pesan Eskalasi

Jika assignment SQA:

```text
Mohon dibantu bang @Bg Ferry CCM
CC-20260715-00000405
CC bang @Bg Fernando PIC SQA Telkomsel

CC-20260715-00000405

{Description Fault Sumptomps}

========

{CCH Suggestion atau fallback Problem Analysis NSH}

SLA DUE DATE 24H : **Kamis / 16 Jul 2026, 08:15:19 PM**
```

Jika assignment NOP:

```text
Mohon dibantu bang @Bg PIC NOP
CC-20260715-00000405

{Description Fault Sumptomps}

========

{CCH Suggestion atau fallback Problem Analysis NSH}

SLA DUE DATE 24H : **Kamis / 16 Jul 2026, 08:15:19 PM**
```

Bagian analisis memakai:

1. `CCH Suggestion(L1 Assign_cch_suggestion)`
2. Jika kosong/null/berisi `cause: No matched data is found, suggestion: null, other: null`, fallback ke `Problem Analysis NSH`

## 10. Routing Grup WhatsApp

Routing grup dikonfigurasi di:

```text
config/whatsapp.json
```

Jika assignment SQA:

```text
groups.SQA.jid
```

Jika assignment NOP:

```text
groups["NOP ACEH"].jid
groups["NOP BINJAI"].jid
groups["NOP MEDAN"].jid
groups["NOP PEMATANG SIANTAR"].jid
groups["NOP RANTAU PRAPAT"].jid
groups["NOP PADANG SIDEMPUAN"].jid
```

Jika JID grup belum diisi, bot fallback ke chat pengirim file.

## 11. Struktur Kode

```text
src/
  commands/
  config/
    appConfig.js
    whatsappRouting.js
  handlers/
    whatsappMessageHandler.js
  middlewares/
  services/
    picSearchService.js
    siteSearchService.js
    ticketImportService.js
  utils/
    dateTime.js
    jsonFile.js
    logger.js
    text.js
config/
  whatsapp.example.json
sessions/
downloads/
logs/
```

Peran file:

- `index.js`: entry point bot.
- `whatsappMessageHandler.js`: koneksi Baileys, QR login, download file, kirim pesan/file.
- `appConfig.js`: baca `config/whatsapp.json` dan normalisasi key.
- `whatsappRouting.js`: menentukan grup tujuan.
- `picSearchService.js`: normalisasi assignment dan search PIC dari city.
- `siteSearchService.js`: ekstraksi site cover, search city/site/vendor/cluster.
- `ticketImportService.js`: validasi Excel, filterisasi, SLA, formatter pesan, dan output Excel.
