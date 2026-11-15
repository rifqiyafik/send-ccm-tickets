import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  formatProgressBar,
  formatWperfProgressMessage,
  loadWperfStatements,
  executeWperfSync,
  createWperfSyncService,
} from "../src/services/wperfSyncService.js";

test("formatProgressBar renders block characters accurately", () => {
  assert.equal(formatProgressBar(0), "░░░░░░░░░░");
  assert.equal(formatProgressBar(25), "██░░░░░░░░");
  assert.equal(formatProgressBar(50), "█████░░░░░");
  assert.equal(formatProgressBar(75), "███████░░░");
  assert.equal(formatProgressBar(100), "██████████");
});

test("formatWperfProgressMessage generates attractive progress, completion, and error states", () => {
  // Test in progress
  const progressMsg = formatWperfProgressMessage({
    stage: 2,
    percent: 50,
    durationSec: 15,
    rowCounts: { region: 12 },
  });
  assert.ok(progressMsg.includes("Progress:"), "Harus ada status progress");
  assert.ok(progressMsg.includes("50%"), "Harus menampilkan 50%");
  assert.ok(progressMsg.includes("Region"), "Harus memuat baris Region");
  assert.ok(progressMsg.includes("(12 baris)"), "Harus memuat jumlah baris Region");
  assert.ok(progressMsg.includes("15 detik"), "Harus menampilkan durasi berjalan");

  // Test completed
  const doneMsg = formatWperfProgressMessage({
    isDone: true,
    durationSec: 42,
    rowCounts: { region: 12, nop: 58, kabupaten: 240, kecamatan: 1420 },
  });
  assert.ok(doneMsg.includes("Berhasil"), "Harus menampilkan kata Berhasil");
  assert.ok(doneMsg.includes("42 detik"), "Harus menampilkan total durasi");
  assert.ok(doneMsg.includes("1420 baris"), "Harus menampilkan row count kecamatan");

  // Test error
  const errorMsg = formatWperfProgressMessage({
    error: new Error("Connection timeout"),
    durationSec: 10,
  });
  assert.ok(errorMsg.includes("Gagal"), "Harus menampilkan kata Gagal");
  assert.ok(errorMsg.includes("Connection timeout"), "Harus menampilkan pesan error");
});

test("loadWperfStatements extracts statements from SQL file cleanly", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wperf-sql-test-"));
  const tmpSql = path.join(tmpDir, "test.sql");

  const sampleSql = `
    -- Comment line
    REFRESH MATERIALIZED VIEW test_mv1;
    REFRESH MATERIALIZED VIEW test_mv2;
    REFRESH MATERIALIZED VIEW test_mv3;
    REFRESH MATERIALIZED VIEW test_mv4;
    INSERT INTO test_region VALUES (1);
    INSERT INTO test_nop VALUES (2);
    INSERT INTO test_kabupaten VALUES (3);
    INSERT INTO test_kecamatan VALUES (4);
  `;
  await fs.writeFile(tmpSql, sampleSql, "utf8");

  const stmts = await loadWperfStatements(tmpSql);
  assert.equal(stmts.length, 8, "Harus menghasilkan 8 statements");
  assert.ok(stmts[0].includes("test_mv1"));
  assert.ok(stmts[4].includes("test_region"));
  assert.ok(stmts[7].includes("test_kecamatan"));
});

test("executeWperfSync executes statements sequentially and triggers onProgress callbacks", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wperf-exec-test-"));
  const tmpSql = path.join(tmpDir, "test.sql");

  const sampleSql = `
    REFRESH MATERIALIZED VIEW mv1;
    REFRESH MATERIALIZED VIEW mv2;
    REFRESH MATERIALIZED VIEW mv3;
    REFRESH MATERIALIZED VIEW mv4;
    INSERT INTO tbl_region SELECT 1;
    INSERT INTO tbl_nop SELECT 2;
    INSERT INTO tbl_kabupaten SELECT 3;
    INSERT INTO tbl_kecamatan SELECT 4;
  `;
  await fs.writeFile(tmpSql, sampleSql, "utf8");

  const executedQueries = [];
  const progressReports = [];

  const fakeQueryFn = async (sql) => {
    executedQueries.push(sql);
    return { rowCount: 10 };
  };

  const result = await executeWperfSync({
    sqlFilePath: tmpSql,
    queryFn: fakeQueryFn,
    onProgress: async (state) => {
      progressReports.push(state.percent);
    },
  });

  assert.equal(result.success, true);
  assert.equal(executedQueries.length, 8);
  assert.deepEqual(result.rowCounts, {
    region: 10,
    nop: 10,
    kabupaten: 10,
    kecamatan: 10,
  });
  assert.ok(progressReports.includes(12), "Harus melewati 12%");
  assert.ok(progressReports.includes(25), "Harus melewati 25%");
  assert.ok(progressReports.includes(37), "Harus melewati 37%");
  assert.ok(progressReports.includes(50), "Harus melewati 50%");
  assert.ok(progressReports.includes(62), "Harus melewati 62%");
  assert.ok(progressReports.includes(75), "Harus melewati 75%");
  assert.ok(progressReports.includes(87), "Harus melewati 87%");
  assert.ok(progressReports.includes(100), "Harus mencapai 100%");
});

test("formatWperfProgressMessage renders individual status for all 4 Materialized Views", () => {
  const msg = formatWperfProgressMessage({
    stage: 0,
    percent: 25,
    durationSec: 10,
    mvDetails: {
      region: { status: "done", durationSec: 2 },
      nop: { status: "done", durationSec: 3 },
      kabupaten: { status: "processing", durationSec: null },
      kecamatan: { status: "pending", durationSec: null },
    },
    rowCounts: {},
  });

  assert.ok(msg.includes("Region"), "Harus memuat Region");
  assert.ok(msg.includes("✅ Selesai (2s)"), "Region harus berstatus Selesai dengan durasi");
  assert.ok(msg.includes("NOP"), "Harus memuat NOP");
  assert.ok(msg.includes("✅ Selesai (3s)"), "NOP harus berstatus Selesai dengan durasi");
  assert.ok(msg.includes("Kabupaten"), "Harus memuat Kabupaten");
  assert.ok(msg.includes("⏳ Memproses..."), "Kabupaten harus berstatus Memproses");
  assert.ok(msg.includes("Kecamatan"), "Harus memuat Kecamatan");
  assert.ok(msg.includes("⏳ Menunggu"), "Kecamatan harus berstatus Menunggu");
});

test("wperfSyncService scheduled trigger runs at 09:00 WIB and sends reports exclusively to admins", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wperf-service-test-"));
  const tmpSql = path.join(tmpDir, "test.sql");
  const statePath = path.join(tmpDir, "state.json");

  await fs.writeFile(
    tmpSql,
    `
    REFRESH MATERIALIZED VIEW mv1;
    REFRESH MATERIALIZED VIEW mv2;
    REFRESH MATERIALIZED VIEW mv3;
    REFRESH MATERIALIZED VIEW mv4;
    INSERT INTO reg SELECT 1;
    INSERT INTO nop SELECT 2;
    INSERT INTO kab SELECT 3;
    INSERT INTO kec SELECT 4;
  `,
    "utf8",
  );

  const sentMessages = [];
  const editedMessages = [];

  const fakeBot = {
    sendMessage: async (chatId, text, options) => {
      sentMessages.push({ chatId, text });
      return { message_id: 999 };
    },
    editMessageText: async (chatId, msgId, text, options) => {
      editedMessages.push({ chatId, msgId, text });
      return true;
    },
  };

  const adminChatIds = ["111222333"];

  const service = createWperfSyncService({
    telegramBot: fakeBot,
    adminChatIds,
    sqlFilePath: tmpSql,
    statePath,
    queryFn: async () => ({ rowCount: 5 }),
    scheduledHour: 9,
    scheduledMinute: 0,
  });

  // Test: waktu sebelum 09:00 WIB (misal 08:30 WIB = 01:30 UTC)
  const beforeTime = new Date("2026-10-13T01:30:00Z");
  const ranBefore = await service.checkAndRunScheduled(beforeTime);
  assert.equal(ranBefore, false, "Tidak boleh jalan sebelum jam 09:00 WIB");

  // Test: waktu tepat 09:00 WIB (02:00 UTC)
  const scheduleTime = new Date("2026-10-13T02:00:00Z");
  const ranAtTarget = await service.checkAndRunScheduled(scheduleTime);
  assert.equal(ranAtTarget, true, "Harus jalan pada jam 09:00 WIB");

  // Pastikan pesan hanya dikirim ke admin
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, "111222333");
  assert.ok(editedMessages.length > 0, "Harus melakukan edit pesan untuk progress bar");

  // Test: tidak boleh jalan duplikat di hari yang sama
  const duplicateTime = new Date("2026-10-13T02:05:00Z");
  const ranDuplicate = await service.checkAndRunScheduled(duplicateTime);
  assert.equal(ranDuplicate, false, "Tidak boleh jalan ganda di hari yang sama");
});
