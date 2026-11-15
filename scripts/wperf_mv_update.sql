REFRESH MATERIALIZED VIEW "SQA_SUMBAGUT".mv_wperf_region_ytd_sqa;
REFRESH MATERIALIZED VIEW "SQA_SUMBAGUT".mv_wperf_nop_ytd_sqa;
REFRESH MATERIALIZED VIEW "SQA_SUMBAGUT".mv_wperf_kabupaten_ytd_sqa;
REFRESH MATERIALIZED VIEW "SQA_SUMBAGUT".mv_wperf_kecamatan_ytd_sqa;


----- REGION LEVEL ========================================================================================================
----
--CREATE TABLE "SQA_SUMBAGUT".wperf_region_ytd_mtd_mom_sqa_leapdate (
--    -- Identitas
--    tanggal date,
--    region text,
--
--    -- 1. DAILY SECTION
--    cur_daily_payload_gbyte numeric,
--    prev_daily_payload_gbyte numeric,
--    cur_daily_traffic_erl numeric,
--    prev_daily_traffic_erl numeric,
--
--    -- 2. YTD SECTION
--    cur_ytd_payload_gbyte numeric,
--    prev_ytd_payload_gbyte numeric,
--    ytd_payload_growth_pct numeric,
--    cur_ytd_traffic numeric,
--    prev_ytd_traffic numeric,
--    ytd_traffic_growth_pct numeric,
--
--    -- 3. MTD SECTION
--    cur_mtd_payload_gbyte numeric,
--    prev_mtd_payload_gbyte numeric,
--    mtd_payload_growth_pct numeric,
--    cur_mtd_traffic numeric,
--    prev_mtd_traffic numeric,
--    mtd_traffic_growth_pct numeric,
--
--    -- 4. MOM MTD SECTION
--    cur_mom_mtd_payload numeric,
--    prev_mom_mtd_payload numeric,
--    mom_mtd_payload_growth_pct numeric,
--    cur_mom_mtd_traffic numeric,
--    prev_mom_mtd_traffic numeric,
--    mom_mtd_traffic_growth_pct numeric,
--
--    -- Constraint untuk UPSERT
--    CONSTRAINT uq_wperf_region_leap UNIQUE (tanggal, region)
--);
----
---
INSERT INTO "SQA_SUMBAGUT".wperf_region_ytd_mtd_mom_sqa_leapdate (
    tanggal,
    region,

    -- DAILY
    cur_daily_payload_gbyte,
    prev_daily_payload_gbyte,
    cur_daily_traffic_erl,
    prev_daily_traffic_erl,

    -- YTD
    cur_ytd_payload_gbyte,
    prev_ytd_payload_gbyte,
    ytd_payload_growth_pct,
    cur_ytd_traffic,
    prev_ytd_traffic,
    ytd_traffic_growth_pct,

    -- MTD
    cur_mtd_payload_gbyte,
    prev_mtd_payload_gbyte,
    mtd_payload_growth_pct,
    cur_mtd_traffic,
    prev_mtd_traffic,
    mtd_traffic_growth_pct,

    -- MOM MTD
    cur_mom_mtd_payload,
    prev_mom_mtd_payload,
    mom_mtd_payload_growth_pct,
    cur_mom_mtd_traffic,
    prev_mom_mtd_traffic,
    mom_mtd_traffic_growth_pct
)
SELECT DISTINCT ON (tanggal, region)
    tanggal,
    region,

    -- DAILY
    cur_daily_payload_gbyte,
    prev_daily_payload_gbyte,
    cur_daily_traffic_erl,
    prev_daily_traffic_erl,

    -- YTD
    cur_ytd_payload_gbyte,
    prev_ytd_payload_gbyte,
    ytd_payload_growth_pct,
    cur_ytd_traffic,
    prev_ytd_traffic,
    ytd_traffic_growth_pct,

    -- MTD
    cur_mtd_payload_gbyte,
    prev_mtd_payload_gbyte,
    mtd_payload_growth_pct,
    cur_mtd_traffic,
    prev_mtd_traffic,
    mtd_traffic_growth_pct,

    -- MOM MTD
    cur_mom_mtd_payload,
    prev_mom_mtd_payload,
    mom_mtd_payload_growth_pct,
    cur_mom_mtd_traffic,
    prev_mom_mtd_traffic,
    mom_mtd_traffic_growth_pct
FROM "SQA_SUMBAGUT".mv_wperf_region_ytd_sqa
WHERE tanggal >= '2025-12-01'
ORDER BY tanggal, region, cur_daily_payload_gbyte DESC
ON CONFLICT (tanggal, region) DO UPDATE SET
    -- DAILY
    cur_daily_payload_gbyte = EXCLUDED.cur_daily_payload_gbyte,
    prev_daily_payload_gbyte = EXCLUDED.prev_daily_payload_gbyte,
    cur_daily_traffic_erl = EXCLUDED.cur_daily_traffic_erl,
    prev_daily_traffic_erl = EXCLUDED.prev_daily_traffic_erl,

    -- YTD
    cur_ytd_payload_gbyte = EXCLUDED.cur_ytd_payload_gbyte,
    prev_ytd_payload_gbyte = EXCLUDED.prev_ytd_payload_gbyte,
    ytd_payload_growth_pct = EXCLUDED.ytd_payload_growth_pct,
    cur_ytd_traffic = EXCLUDED.cur_ytd_traffic,
    prev_ytd_traffic = EXCLUDED.prev_ytd_traffic,
    ytd_traffic_growth_pct = EXCLUDED.ytd_traffic_growth_pct,

    -- MTD
    cur_mtd_payload_gbyte = EXCLUDED.cur_mtd_payload_gbyte,
    prev_mtd_payload_gbyte = EXCLUDED.prev_mtd_payload_gbyte,
    mtd_payload_growth_pct = EXCLUDED.mtd_payload_growth_pct,
    cur_mtd_traffic = EXCLUDED.cur_mtd_traffic,
    prev_mtd_traffic = EXCLUDED.prev_mtd_traffic,
    mtd_traffic_growth_pct = EXCLUDED.mtd_traffic_growth_pct,

    -- MOM MTD
    cur_mom_mtd_payload = EXCLUDED.cur_mom_mtd_payload,
    prev_mom_mtd_payload = EXCLUDED.prev_mom_mtd_payload,
    mom_mtd_payload_growth_pct = EXCLUDED.mom_mtd_payload_growth_pct,
    cur_mom_mtd_traffic = EXCLUDED.cur_mom_mtd_traffic,
    prev_mom_mtd_traffic = EXCLUDED.prev_mom_mtd_traffic,
    mom_mtd_traffic_growth_pct = EXCLUDED.mom_mtd_traffic_growth_pct;
---
--
--
--
---
----
----- NOP LEVEL ===========================================================================================================
----
--CREATE TABLE "SQA_SUMBAGUT".wperf_nop_ytd_mtd_mom_sqa_leapdate (
--    -- Identitas
--    tanggal date,
--    nop text,
--    region text,
--
--    -- DAILY SECTION
--    cur_daily_payload_gbyte numeric,
--    prev_daily_payload_gbyte numeric,
--    cur_daily_traffic_erl numeric,
--    prev_daily_traffic_erl numeric,
--
--    -- YTD SECTION
--    cur_ytd_payload_gbyte numeric,
--    prev_ytd_payload_gbyte numeric,
--    ytd_payload_growth_pct numeric,
--    cur_ytd_traffic numeric,
--    prev_ytd_traffic numeric,
--    ytd_traffic_growth_pct numeric,
--
--    -- MTD YoY SECTION
--    cur_mtd_payload_gbyte numeric,
--    prev_mtd_payload_gbyte numeric,
--    mtd_payload_growth_pct numeric,
--    cur_mtd_traffic numeric,
--    prev_mtd_traffic numeric,
--    mtd_traffic_growth_pct numeric,
--
--    -- MTD MoM SECTION
--    cur_mom_mtd_payload numeric,
--    prev_mom_mtd_payload numeric,
--    mom_mtd_payload_growth_pct numeric,
--    cur_mom_mtd_traffic numeric,
--    prev_mom_mtd_traffic numeric,
--    mom_mtd_traffic_growth_pct numeric,
--
--    CONSTRAINT uq_wperf_nop UNIQUE (tanggal, nop, region)
--);
----
---
INSERT INTO "SQA_SUMBAGUT".wperf_nop_ytd_mtd_mom_sqa_leapdate (
    tanggal, nop, region,
    cur_daily_payload_gbyte, prev_daily_payload_gbyte,
    cur_daily_traffic_erl, prev_daily_traffic_erl,
    cur_ytd_payload_gbyte, prev_ytd_payload_gbyte, ytd_payload_growth_pct,
    cur_ytd_traffic, prev_ytd_traffic, ytd_traffic_growth_pct,
    cur_mtd_payload_gbyte, prev_mtd_payload_gbyte, mtd_payload_growth_pct,
    cur_mtd_traffic, prev_mtd_traffic, mtd_traffic_growth_pct,
    cur_mom_mtd_payload, prev_mom_mtd_payload, mom_mtd_payload_growth_pct,
    cur_mom_mtd_traffic, prev_mom_mtd_traffic, mom_mtd_traffic_growth_pct
)
SELECT DISTINCT ON (tanggal, nop, region)
    tanggal, nop, region,
    cur_daily_payload_gbyte, prev_daily_payload_gbyte,
    cur_daily_traffic_erl, prev_daily_traffic_erl,
    cur_ytd_payload_gbyte, prev_ytd_payload_gbyte, ytd_payload_growth_pct,
    cur_ytd_traffic, prev_ytd_traffic, ytd_traffic_growth_pct,
    cur_mtd_payload_gbyte, prev_mtd_payload_gbyte, mtd_payload_growth_pct,
    cur_mtd_traffic, prev_mtd_traffic, mtd_traffic_growth_pct,
    cur_mom_mtd_payload, prev_mom_mtd_payload, mom_mtd_payload_growth_pct,
    cur_mom_mtd_traffic, prev_mom_mtd_traffic, mom_mtd_traffic_growth_pct
FROM "SQA_SUMBAGUT".mv_wperf_nop_ytd_sqa
WHERE tanggal >= '2025-12-01'
ORDER BY tanggal, nop, region, cur_daily_payload_gbyte DESC
ON CONFLICT (tanggal, nop, region) DO UPDATE SET
    cur_daily_payload_gbyte = EXCLUDED.cur_daily_payload_gbyte,
    prev_daily_payload_gbyte = EXCLUDED.prev_daily_payload_gbyte,
    cur_daily_traffic_erl = EXCLUDED.cur_daily_traffic_erl,
    prev_daily_traffic_erl = EXCLUDED.prev_daily_traffic_erl,
    cur_ytd_payload_gbyte = EXCLUDED.cur_ytd_payload_gbyte,
    prev_ytd_payload_gbyte = EXCLUDED.prev_ytd_payload_gbyte,
    ytd_payload_growth_pct = EXCLUDED.ytd_payload_growth_pct,
    cur_ytd_traffic = EXCLUDED.cur_ytd_traffic,
    prev_ytd_traffic = EXCLUDED.prev_ytd_traffic,
    ytd_traffic_growth_pct = EXCLUDED.ytd_traffic_growth_pct,
    cur_mtd_payload_gbyte = EXCLUDED.cur_mtd_payload_gbyte,
    prev_mtd_payload_gbyte = EXCLUDED.prev_mtd_payload_gbyte,
    mtd_payload_growth_pct = EXCLUDED.mtd_payload_growth_pct,
    cur_mtd_traffic = EXCLUDED.cur_mtd_traffic,
    prev_mtd_traffic = EXCLUDED.prev_mtd_traffic,
    mtd_traffic_growth_pct = EXCLUDED.mtd_traffic_growth_pct,
    cur_mom_mtd_payload = EXCLUDED.cur_mom_mtd_payload,
    prev_mom_mtd_payload = EXCLUDED.prev_mom_mtd_payload,
    mom_mtd_payload_growth_pct = EXCLUDED.mom_mtd_payload_growth_pct,
    cur_mom_mtd_traffic = EXCLUDED.cur_mom_mtd_traffic,
    prev_mom_mtd_traffic = EXCLUDED.prev_mom_mtd_traffic,
    mom_mtd_traffic_growth_pct = EXCLUDED.mom_mtd_traffic_growth_pct;
---
--
--
--
---
----
----- KABUPATEN LEVEL ========================================================================================================
----
--CREATE TABLE "SQA_SUMBAGUT".wperf_kabupaten_ytd_mtd_mom_sqa_leapdate (
--    -- Identitas
--    tanggal date,
--    kabupaten text,
--    nop text,
--    region text,
--
--    -- DAILY SECTION
--    cur_daily_payload_gbyte numeric,
--    prev_daily_payload_gbyte numeric,
--    cur_daily_traffic_erl numeric,
--    prev_daily_traffic_erl numeric,
--
--    -- YTD SECTION
--    cur_ytd_payload_gbyte numeric,
--    prev_ytd_payload_gbyte numeric,
--    ytd_payload_growth_pct numeric,
--    cur_ytd_traffic numeric,
--    prev_ytd_traffic numeric,
--    ytd_traffic_growth_pct numeric,
--
--    -- MTD YoY SECTION
--    cur_mtd_payload_gbyte numeric,
--    prev_mtd_payload_gbyte numeric,
--    mtd_payload_growth_pct numeric,
--    cur_mtd_traffic numeric,
--    prev_mtd_traffic numeric,
--    mtd_traffic_growth_pct numeric,
--
--    -- MTD MoM SECTION
--    cur_mom_mtd_payload numeric,
--    prev_mom_mtd_payload numeric,
--    mom_mtd_payload_growth_pct numeric,
--    cur_mom_mtd_traffic numeric,
--    prev_mom_mtd_traffic numeric,
--    mom_mtd_traffic_growth_pct numeric,
--
--    CONSTRAINT uq_wperf_kabupaten UNIQUE (tanggal, kabupaten, nop, region)
--);
----
---
INSERT INTO "SQA_SUMBAGUT".wperf_kabupaten_ytd_mtd_mom_sqa_leapdate (
    tanggal, kabupaten, nop, region,
    cur_daily_payload_gbyte, prev_daily_payload_gbyte,
    cur_daily_traffic_erl, prev_daily_traffic_erl,
    cur_ytd_payload_gbyte, prev_ytd_payload_gbyte, ytd_payload_growth_pct,
    cur_ytd_traffic, prev_ytd_traffic, ytd_traffic_growth_pct,
    cur_mtd_payload_gbyte, prev_mtd_payload_gbyte, mtd_payload_growth_pct,
    cur_mtd_traffic, prev_mtd_traffic, mtd_traffic_growth_pct,
    cur_mom_mtd_payload, prev_mom_mtd_payload, mom_mtd_payload_growth_pct,
    cur_mom_mtd_traffic, prev_mom_mtd_traffic, mom_mtd_traffic_growth_pct
)
SELECT DISTINCT ON (tanggal, kabupaten, nop, region)
    tanggal, kabupaten, nop, region,
    cur_daily_payload_gbyte, prev_daily_payload_gbyte,
    cur_daily_traffic_erl, prev_daily_traffic_erl,
    cur_ytd_payload_gbyte, prev_ytd_payload_gbyte, ytd_payload_growth_pct,
    cur_ytd_traffic, prev_ytd_traffic, ytd_traffic_growth_pct,
    cur_mtd_payload_gbyte, prev_mtd_payload_gbyte, mtd_payload_growth_pct,
    cur_mtd_traffic, prev_mtd_traffic, mtd_traffic_growth_pct,
    cur_mom_mtd_payload, prev_mom_mtd_payload, mom_mtd_payload_growth_pct,
    cur_mom_mtd_traffic, prev_mom_mtd_traffic, mom_mtd_traffic_growth_pct
FROM "SQA_SUMBAGUT".mv_wperf_kabupaten_ytd_sqa
WHERE tanggal >= '2025-12-01'
ORDER BY tanggal, kabupaten, nop, region, cur_daily_payload_gbyte DESC
ON CONFLICT (tanggal, kabupaten, nop, region) DO UPDATE SET
    cur_daily_payload_gbyte = EXCLUDED.cur_daily_payload_gbyte,
    prev_daily_payload_gbyte = EXCLUDED.prev_daily_payload_gbyte,
    cur_daily_traffic_erl = EXCLUDED.cur_daily_traffic_erl,
    prev_daily_traffic_erl = EXCLUDED.prev_daily_traffic_erl,
    cur_ytd_payload_gbyte = EXCLUDED.cur_ytd_payload_gbyte,
    prev_ytd_payload_gbyte = EXCLUDED.prev_ytd_payload_gbyte,
    ytd_payload_growth_pct = EXCLUDED.ytd_payload_growth_pct,
    cur_ytd_traffic = EXCLUDED.cur_ytd_traffic,
    prev_ytd_traffic = EXCLUDED.prev_ytd_traffic,
    ytd_traffic_growth_pct = EXCLUDED.ytd_traffic_growth_pct,
    cur_mtd_payload_gbyte = EXCLUDED.cur_mtd_payload_gbyte,
    prev_mtd_payload_gbyte = EXCLUDED.prev_mtd_payload_gbyte,
    mtd_payload_growth_pct = EXCLUDED.mtd_payload_growth_pct,
    cur_mtd_traffic = EXCLUDED.cur_mtd_traffic,
    prev_mtd_traffic = EXCLUDED.prev_mtd_traffic,
    mtd_traffic_growth_pct = EXCLUDED.mtd_traffic_growth_pct,
    cur_mom_mtd_payload = EXCLUDED.cur_mom_mtd_payload,
    prev_mom_mtd_payload = EXCLUDED.prev_mom_mtd_payload,
    mom_mtd_payload_growth_pct = EXCLUDED.mom_mtd_payload_growth_pct,
    cur_mom_mtd_traffic = EXCLUDED.cur_mom_mtd_traffic,
    prev_mom_mtd_traffic = EXCLUDED.prev_mom_mtd_traffic,
    mom_mtd_traffic_growth_pct = EXCLUDED.mom_mtd_traffic_growth_pct;
---
--
--
--
---
----
----- KECAMATAN LEVEL ========================================================================================================
----
--CREATE TABLE "SQA_SUMBAGUT".wperf_kecamatan_ytd_mtd_mom_sqa_leapdate (
--    -- Identitas
--    tanggal date,
--    kecamatan text,
--    kabupaten text,
--    nop text,
--    region text,
--
--    -- DAILY SECTION
--    cur_daily_payload_gbyte numeric,
--    prev_daily_payload_gbyte numeric,
--    cur_daily_traffic_erl numeric,
--    prev_daily_traffic_erl numeric,
--
--    -- YTD SECTION
--    cur_ytd_payload_gbyte numeric,
--    prev_ytd_payload_gbyte numeric,
--    ytd_payload_growth_pct numeric,
--    cur_ytd_traffic numeric,
--    prev_ytd_traffic numeric,
--    ytd_traffic_growth_pct numeric,
--
--    -- MTD SECTION
--    cur_mtd_payload_gbyte numeric,
--    prev_mtd_payload_gbyte numeric,
--    mtd_payload_growth_pct numeric,
--    cur_mtd_traffic numeric,
--    prev_mtd_traffic numeric,
--    mtd_traffic_growth_pct numeric,
--
--    -- MOM MTD SECTION
--    cur_mom_mtd_payload numeric,
--    prev_mom_mtd_payload numeric,
--    mom_mtd_payload_growth_pct numeric,
--    cur_mom_mtd_traffic numeric,
--    prev_mom_mtd_traffic numeric,
--    mom_mtd_traffic_growth_pct numeric,
--
--    CONSTRAINT uq_wperf_kecamatan UNIQUE (tanggal, kecamatan, kabupaten, nop, region)
--);
----
---
INSERT INTO "SQA_SUMBAGUT".wperf_kecamatan_ytd_mtd_mom_sqa_leapdate (
    tanggal, kecamatan, kabupaten, nop, region,
    cur_daily_payload_gbyte, prev_daily_payload_gbyte,
    cur_daily_traffic_erl, prev_daily_traffic_erl,
    cur_ytd_payload_gbyte, prev_ytd_payload_gbyte, ytd_payload_growth_pct,
    cur_ytd_traffic, prev_ytd_traffic, ytd_traffic_growth_pct,
    cur_mtd_payload_gbyte, prev_mtd_payload_gbyte, mtd_payload_growth_pct,
    cur_mtd_traffic, prev_mtd_traffic, mtd_traffic_growth_pct,
    cur_mom_mtd_payload, prev_mom_mtd_payload, mom_mtd_payload_growth_pct,
    cur_mom_mtd_traffic, prev_mom_mtd_traffic, mom_mtd_traffic_growth_pct
)
SELECT DISTINCT ON (tanggal, kecamatan, kabupaten, nop, region)
    tanggal, kecamatan, kabupaten, nop, region,
    cur_daily_payload_gbyte, prev_daily_payload_gbyte,
    cur_daily_traffic_erl, prev_daily_traffic_erl,
    cur_ytd_payload_gbyte, prev_ytd_payload_gbyte, ytd_payload_growth_pct,
    cur_ytd_traffic, prev_ytd_traffic, ytd_traffic_growth_pct,
    cur_mtd_payload_gbyte, prev_mtd_payload_gbyte, mtd_payload_growth_pct,
    cur_mtd_traffic, prev_mtd_traffic, mtd_traffic_growth_pct,
    cur_mom_mtd_payload, prev_mom_mtd_payload, mom_mtd_payload_growth_pct,
    cur_mom_mtd_traffic, prev_mom_mtd_traffic, mom_mtd_traffic_growth_pct
FROM "SQA_SUMBAGUT".mv_wperf_kecamatan_ytd_sqa
WHERE tanggal >= '2025-12-01'
ORDER BY tanggal, kecamatan, kabupaten, nop, region, cur_daily_payload_gbyte DESC
ON CONFLICT (tanggal, kecamatan, kabupaten, nop, region) DO UPDATE SET
    cur_daily_payload_gbyte = EXCLUDED.cur_daily_payload_gbyte,
    prev_daily_payload_gbyte = EXCLUDED.prev_daily_payload_gbyte,
    cur_daily_traffic_erl = EXCLUDED.cur_daily_traffic_erl,
    prev_daily_traffic_erl = EXCLUDED.prev_daily_traffic_erl,
    cur_ytd_payload_gbyte = EXCLUDED.cur_ytd_payload_gbyte,
    prev_ytd_payload_gbyte = EXCLUDED.prev_ytd_payload_gbyte,
    ytd_payload_growth_pct = EXCLUDED.ytd_payload_growth_pct,
    cur_ytd_traffic = EXCLUDED.cur_ytd_traffic,
    prev_ytd_traffic = EXCLUDED.prev_ytd_traffic,
    ytd_traffic_growth_pct = EXCLUDED.ytd_traffic_growth_pct,
    cur_mtd_payload_gbyte = EXCLUDED.cur_mtd_payload_gbyte,
    prev_mtd_payload_gbyte = EXCLUDED.prev_mtd_payload_gbyte,
    mtd_payload_growth_pct = EXCLUDED.mtd_payload_growth_pct,
    cur_mtd_traffic = EXCLUDED.cur_mtd_traffic,
    prev_mtd_traffic = EXCLUDED.prev_mtd_traffic,
    mtd_traffic_growth_pct = EXCLUDED.mtd_traffic_growth_pct,
    cur_mom_mtd_payload = EXCLUDED.cur_mom_mtd_payload,
    prev_mom_mtd_payload = EXCLUDED.prev_mom_mtd_payload,
    mom_mtd_payload_growth_pct = EXCLUDED.mom_mtd_payload_growth_pct,
    cur_mom_mtd_traffic = EXCLUDED.cur_mom_mtd_traffic,
    prev_mom_mtd_traffic = EXCLUDED.prev_mom_mtd_traffic,
    mom_mtd_traffic_growth_pct = EXCLUDED.mom_mtd_traffic_growth_pct;
---
--
--
--
---
----
----- SITE LEVEL ========================================================================================================
----

----
---

---
--
--
--
---
----
