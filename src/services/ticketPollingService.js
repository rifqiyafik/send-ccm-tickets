import fs from "node:fs/promises";
import path from "node:path";

import { createLogger } from "../utils/logger.js";
import { fetchRunningL2Tickets, pingClickHouse } from "./clickhouseService.js";
import { processTicketRows } from "./ticketImportService.js";
import { createSentTicketPlan } from "./sentTicketService.js";
import {
  sendTicketDetailsToTargetGroups,
  resetDeliveryCancellation,
  isDeliveryCancelled,
} from "../handlers/whatsappMessageHandler.js";
import { createCodeBlock, formatAsciiTable } from "../utils/asciiTable.js";
import { SITE_ID1_COLUMN } from "./siteSearchService.js";
import { ASSIGNMENT_GROUP_COLUMN, CITY_COLUMN } from "./picSearchService.js";
import { isDatabaseConfigured } from "./databaseService.js";
import { getHMinusOneWatermark, batchUpsertMasterTickets } from "./inapTicketStore.js";

const logger = createLogger("ticketPollingService");

const DEFAULT_WATERMARK_PATH = "data/runtime/db_poll_watermark.json";

// mendapatkan tanggal hari ini dalam zona waktu WIB (UTC+7) format YYYY-MM-DD
export function getWibDateString(date = new Date()) {
  const wib = new Date(date.getTime() + 7 * 3600000);
  const yyyy = wib.getUTCFullYear();
  const mm = String(wib.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(wib.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// mendapatkan default watermark waktu hari ini jam 00:00:00 WIB
export function getDefaultWatermark(date = new Date()) {
  return `${getWibDateString(date)} 00:00:00`;
}

// memeriksa apakah waktu sekarang berada dalam rentang jam operasional WIB
export function isWithinWorkingHours(now = new Date(), options = {}) {
  const startHour = Number(
    options.startHour ?? process.env.DB_POLL_START_HOUR ?? 7,
  );
  const endHour = Number(
    options.endHour ?? process.env.DB_POLL_END_HOUR ?? 17,
  );

  const wibHours = (now.getUTCHours() + 7) % 24;
  return wibHours >= startHour && wibHours < endHour;
}

// mengubah row database ClickHouse snake_case ke format kolom standar
export function convertDbRowToTicketRow(row) {
  if (!row || typeof row !== "object") return {};

  let assignmentGroup = String(
    row.assign_to_l2_l2_assign ??
      row.assign_to_l2 ??
      row.assignment_group ??
      row["Assignment Group"] ??
      row["Assign to L2(L2 Assign)"] ??
      row[ASSIGNMENT_GROUP_COLUMN] ??
      "",
  ).trim();

  // Bersihkan prefix 'group:' jika berasal dari database ClickHouse
  assignmentGroup = assignmentGroup.replace(/^group:\s*/i, "").trim();

  // Dukung format pendek jika dari DB hanya tertulis SQA atau NOP <WILAYAH>
  const upperGroup = assignmentGroup.toUpperCase();
  if (upperGroup === "SQA" || upperGroup === "SERVICE QUALITY ASSURANCE") {
    assignmentGroup = "SERVICE QUALITY ASSURANCE SUMBAGUT";
  } else if (upperGroup.startsWith("NOP ")) {
    assignmentGroup = `NETWORK OPERATIONS AND PRODUCTIVITY ${assignmentGroup.slice(4).trim().toUpperCase()}`;
  } else if (upperGroup.startsWith("NETWORK OPERATIONS AND PRODUCTIVITY")) {
    assignmentGroup = upperGroup;
  }

  const city = String(
    row.kabupaten_kota_create_ticket ??
      row.kabupaten_kota ??
      row.city ??
      row["City"] ??
      row["Kabupaten/Kota(Create Ticket)"] ??
      row[CITY_COLUMN] ??
      "",
  ).trim();

  const siteId = String(
    row.site_id_2_l2_assign ??
      row.site_id_l2_assign ??
      row.site_id1_l1_assign ??
      row.site_id1 ??
      row.site_id_1 ??
      row.site_id ??
      row["Site ID 1"] ??
      row["site_id1(L1 Assign)"] ??
      row[SITE_ID1_COLUMN] ??
      "",
  ).trim();

  const descriptionFaultSymptoms = String(
    row.description_fault_sumptomps_create_ticket ??
      row.description_fault_symptomps_create_ticket ??
      row.description_fault_symptomps ??
      row.description_fault_sumptomps ??
      row.description_fault_symptoms ??
      row[
        "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)"
      ] ??
      row["Description Fault Sumptomps"] ??
      row["Description Fault Symptoms"] ??
      "",
  ).trim();

  const customerMsisdn = String(
    row.customer_msisdn_create_ticket ??
      row.customer_msisdn ??
      row["Customer MSISDN(Create Ticket_customer_msisdn)"] ??
      row["Customer MSISDN"] ??
      "",
  ).trim();

  const problemStartTime = String(
    row.problem_start_time_create_ticket ??
      row.problem_start_time ??
      row["Problem Start Time"] ??
      row["Problem Start Time(Create Ticket_problem_start_time)"] ??
      "",
  ).trim();

  const customerInteractionDate = String(
    row.customer_interaction_date_create_ticket ??
      row.customer_interaction_date ??
      row["Customer Interaction Date"] ??
      row["Customer Interaction Date(Create Ticket)"] ??
      row["Customer Interaction Date(Create Ticket_customer_interaction_date)"] ??
      "",
  ).trim();

  const desaKelurahan = String(
    row.desa_kelurahan_create_ticket ??
      row.desa_kelurahan ??
      row.kelurahan ??
      row["Desa/Kelurahan(Create Ticket)"] ??
      row["Desa/Kelurahan"] ??
      row["Kelurahan"] ??
      "",
  ).trim();

  const kecamatan = String(
    row.kecamatan_create_ticket ??
      row.kecamatan ??
      row["kecamatan(Create Ticket)"] ??
      row["Kecamatan(Create Ticket)"] ??
      row["kecamatan"] ??
      row["Kecamatan"] ??
      "",
  ).trim();

  let assignPersonal = String(
    row.assign_personal_l2_assign ??
      row.assign_personal ??
      row.assign_to_personal ??
      row["Assign Personal(L2 Assign)"] ??
      "",
  ).trim();
  assignPersonal = assignPersonal.replace(/^user:\s*/i, "").trim();

  const cchSuggestion = String(
    row.cch_suggestion_l1_assign ??
      row.cch_suggestion ??
      row.cch_suggestion_l1_assign_cch_suggestion ??
      row["CCH Suggestion(L1 Assign_cch_suggestion)"] ??
      "",
  ).trim();

  const resolutionTier2 = String(
    row.resolution_categorization_tier_2_l1_assign ??
      row.resolution_categorization_tier_2 ??
      row["Resolution Categorization Tier 2(L1 Assign)"] ??
      "",
  ).trim();

  const reopenNumber = String(
    row.reopen_number_confirm_close ??
      row.reopen_number ??
      row["Reopen Number(Confirm Close)"] ??
      "",
  ).trim();

  const resolution = String(
    row.resolution_l2_assign ??
      row.resolution ??
      row["Resolution(L2 Assign)"] ??
      "",
  ).trim();

  return {
    "Order ID": String(row.order_id ?? row["Order ID"] ?? "").trim(),
    "Ticket Id": String(row.ticket_id ?? row["Ticket Id"] ?? "").trim(),
    "Create Time": String(row.create_time ?? row["Create Time"] ?? "").trim(),
    "Business Status": String(
      row.business_status ?? row["Business Status"] ?? "",
    ).trim(),
    [ASSIGNMENT_GROUP_COLUMN]: assignmentGroup,
    "Assignment Group": assignmentGroup,
    "Assign to L2": assignmentGroup,
    [CITY_COLUMN]: city,
    City: city,
    "Kabupaten/Kota": city,
    [SITE_ID1_COLUMN]: siteId,
    "Site ID 1": siteId,
    "Site ID": siteId,
    "Problem Analysis NSH": String(
      row.problem_analysis_nsh ?? row["Problem Analysis NSH"] ?? "",
    ).trim(),
    "CCH Suggestion(L1 Assign_cch_suggestion)": cchSuggestion,
    "CCH Suggestion": cchSuggestion,
    "Description Fault Sumptomps(Create Ticket_description__fault_symptomps)":
      descriptionFaultSymptoms,
    "Description Fault Sumptomps": descriptionFaultSymptoms,
    "Description Fault Symptoms": descriptionFaultSymptoms,
    "Customer MSISDN(Create Ticket_customer_msisdn)": customerMsisdn,
    "Customer MSISDN": customerMsisdn,
    "Problem Start Time": problemStartTime,
    "Problem Start Time(Create Ticket_problem_start_time)": problemStartTime,
    "Customer Interaction Date": customerInteractionDate,
    "Customer Interaction Date(Create Ticket)": customerInteractionDate,
    "Customer Interaction Date(Create Ticket_customer_interaction_date)":
      customerInteractionDate,
    "Desa/Kelurahan(Create Ticket)": desaKelurahan,
    "Desa/Kelurahan": desaKelurahan,
    "kecamatan(Create Ticket)": kecamatan,
    Kecamatan: kecamatan,
    Description: String(row.description ?? row["Description"] ?? "").trim(),
    "Problem Analysis": String(
      row.problem_analysis ?? row["Problem Analysis"] ?? "",
    ).trim(),
    "Resolution(L2 Assign)": resolution,
    "Reopen Number(Confirm Close)": reopenNumber,
    "Assign Personal(L2 Assign)": assignPersonal,
    "Resolution Categorization Tier 1": String(
      row.resolution_categorization_tier_1 ??
        row["Resolution Categorization Tier 1"] ??
        "",
    ).trim(),
    "Resolution Categorization Tier 2(L1 Assign)": resolutionTier2,
    "Resolution Categorization Tier 3": String(
      row.resolution_categorization_tier_3 ??
        row["Resolution Categorization Tier 3"] ??
        "",
    ).trim(),
    "Root Caused Tier 1(L2 Assign)": String(
      row.root_caused_tier_1_l2_assign ??
        row.root_caused_tier_1 ??
        row["Root Caused Tier 1(L2 Assign)"] ??
        "",
    ).trim(),
    "Root Caused Tier 2(L2 Assign)": String(
      row.root_caused_tier_2_l2_assign ??
        row.root_caused_tier_2 ??
        row["Root Caused Tier 2(L2 Assign)"] ??
        "",
    ).trim(),
    "Root Caused Tier 3(L2 Assign)": String(
      row.root_caused_tier_3_l2_assign ??
        row.root_caused_tier_3 ??
        row["Root Caused Tier 3(L2 Assign)"] ??
        "",
    ).trim(),
    "Root Caused Tier 8(L2 Assign)": String(
      row.root_caused_tier_8_l2_assign ??
        row.root_caused_tier_8 ??
        row["Root Caused Tier 8(L2 Assign)"] ??
        "",
    ).trim(),
    "Site ID(L2 Assign)": String(
      row.site_id_l2_assign ?? row["Site ID(L2 Assign)"] ?? "",
    ).trim(),
  };
}

// memuat status watermark polling dari file runtime
export async function loadPollWatermark(filePath = DEFAULT_WATERMARK_PATH) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const today = getWibDateString();

    return {
      lastPollTime: parsed.lastPollTime || null,
      lastWatermark: parsed.lastWatermark || getDefaultWatermark(),
      todayDate: today,
      totalSentToday: parsed.todayDate === today ? Number(parsed.totalSentToday || 0) : 0,
    };
  } catch (_) {
    return {
      lastPollTime: null,
      lastWatermark: getDefaultWatermark(),
      todayDate: getWibDateString(),
      totalSentToday: 0,
    };
  }
}

// menyimpan status watermark polling ke file runtime
export async function savePollWatermark(data, filePath = DEFAULT_WATERMARK_PATH) {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    logger.warn("Failed to save DB poll watermark state", { error: error.message });
  }
}

// memformat pesan notifikasi pra-pengiriman saat tiket baru ditemukan
export function formatPreSendNotification(tickets) {
  const sampleOrders = tickets
    .slice(0, 5)
    .map((t) => `\`${t.order_id}\``)
    .join(", ");
  const extra = tickets.length > 5 ? ` (+${tickets.length - 5} lainnya)` : "";

  return [
    `🔔 **Ditemukan ${tickets.length} Tiket Baru dari Database**`,
    "",
    `📋 Tiket: ${sampleOrders}${extra}`,
    "⏳ Memulai pengiriman otomatis ke WhatsApp (Adaptive Jitter Active)...",
  ].join("\n");
}

// memformat pesan notifikasi tabel ASCII setelah tiket berhasil dikirim (dipaginasi per chunkSize)
export function formatSentTicketsNotificationMessages(tickets, chunkSize = 20) {
  if (!Array.isArray(tickets) || tickets.length === 0) {
    return [];
  }

  const columns = [
    { key: "order_id", header: "Order ID", minWidth: 20, maxWidth: 24 },
    { key: "city", header: "City", minWidth: 12, maxWidth: 18 },
    { key: "cluster_area", header: "Cluster Area", minWidth: 14, maxWidth: 20 },
    { key: "sla_status", header: "SLA Status", minWidth: 10 },
    { key: "pic", header: "PIC", minWidth: 12, maxWidth: 24 },
    { key: "site_id", header: "Site ID", minWidth: 7, maxWidth: 10 },
  ];

  const totalPages = Math.ceil(tickets.length / chunkSize);
  const messages = [];

  for (let page = 0; page < totalPages; page++) {
    const chunk = tickets.slice(page * chunkSize, (page + 1) * chunkSize);
    const rows = chunk.map((t) => ({
      order_id: t.order_id || "-",
      city: t.city || "-",
      cluster_area: t.cluster_area || "-",
      sla_status: t.sla_status || "-",
      pic: t.pic || "-",
      site_id: t.site_id || "-",
    }));

    const table = formatAsciiTable(columns, rows);
    const pageLabel = totalPages > 1 ? ` (Bagian ${page + 1}/${totalPages})` : "";
    const isLastPage = page === totalPages - 1;

    const parts = [
      `✅ **Tiket Baru Terkirim Otomatis**${pageLabel}`,
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      createCodeBlock(table),
    ];

    if (isLastPage) {
      parts.push(`📦 Total: **${tickets.length} tiket** berhasil diteruskan ke grup target.`);
    }

    messages.push(parts.join("\n"));
  }

  return messages;
}

export function formatSentTicketsNotificationTable(tickets) {
  const msgs = formatSentTicketsNotificationMessages(tickets);
  return msgs[0] || "";
}

// membuat instance service polling database ClickHouse mandiri
export function createTicketPollingService({
  telegramBot,
  adminChatIds = [],
  createAdapter,
  fetchTickets = fetchRunningL2Tickets,
  pingDb = pingClickHouse,
  watermarkPath = DEFAULT_WATERMARK_PATH,
  useDatabase = isDatabaseConfigured(),
} = {}) {
  const useDb = Boolean(useDatabase && watermarkPath === DEFAULT_WATERMARK_PATH);
  let timer = null;
  let isRunning = false;
  let isPaused = false;
  let isPollingCycleActive = false;
  let lastError = null;
  let inMemoryState = {
    lastPollTime: null,
    lastWatermark: null,
    todayDate: getWibDateString(),
    totalSentToday: 0,
  };

  async function sendAdminNotification(text) {
    if (!telegramBot?.sendMessage || adminChatIds.length === 0) return;
    for (const chatId of adminChatIds) {
      try {
        await telegramBot.sendMessage(chatId, text, { parse_mode: "Markdown" });
      } catch (err) {
        logger.warn("Failed to send polling notification to Telegram admin", {
          chatId,
          error: err.message,
        });
      }
    }
  }

  // mengeksekusi satu siklus pengecekan database
  async function poll({ force = false } = {}) {
    if (isPollingCycleActive) {
      logger.info("Skipping poll cycle: another cycle is already active");
      return { status: "ALREADY_ACTIVE" };
    }

    if (isPaused && !force) {
      logger.info("Skipping poll cycle: polling is paused by admin");
      return { status: "PAUSED" };
    }

    if (!force && !isWithinWorkingHours()) {
      logger.info("Skipping poll cycle: outside of working hours (07:00 - 17:00 WIB)");
      return { status: "OUTSIDE_WORKING_HOURS" };
    }

    isPollingCycleActive = true;
    const pollStartTime = new Date();

    try {
      let state;
      if (useDb) {
        const today = getWibDateString();
        if (inMemoryState.todayDate !== today) {
          inMemoryState.todayDate = today;
          inMemoryState.totalSentToday = 0;
        }
        state = inMemoryState;
      } else {
        state = await loadPollWatermark(watermarkPath);
      }

      const sinceTime = useDb
        ? getHMinusOneWatermark(pollStartTime)
        : state.lastWatermark || getDefaultWatermark();

      logger.info("Executing DB ticket poll cycle", {
        sinceTime,
        force,
        totalSentToday: state.totalSentToday,
        isHMinusOne: useDb,
      });

      const rawRows = await fetchTickets({ sinceTime });
      lastError = null;

      if (!rawRows || rawRows.length === 0) {
        state.lastPollTime = pollStartTime.toISOString();
        if (!useDb) {
          await savePollWatermark(state, watermarkPath);
        }
        logger.info("DB poll cycle finished: no rows returned from query");
        return { status: "NO_ROWS", newTickets: 0 };
      }

      if (isDatabaseConfigured()) {
        try {
          await batchUpsertMasterTickets(rawRows);
        } catch (dbErr) {
          logger.warn("Failed to upsert raw rows to PostgreSQL in poll cycle", {
            error: dbErr.message,
          });
        }
      }

      // 1. Normalisasi rows dari DB ke model tiket standar
      const convertedRows = rawRows.map(convertDbRowToTicketRow);
      const processedResult = processTicketRows(convertedRows);

      if (!processedResult.valid_tickets || processedResult.valid_tickets.length === 0) {
        state.lastPollTime = pollStartTime.toISOString();
        if (!useDb) {
          await savePollWatermark(state, watermarkPath);
        }
        logger.info("DB poll cycle finished: no valid tickets after processing");
        return { status: "NO_VALID_TICKETS", newTickets: 0 };
      }

      // 2. Deduplikasi tiket yang sudah pernah terkirim (selaras dengan pipeline .update)
      const plan = await createSentTicketPlan(
        processedResult.valid_tickets,
        new Date(),
        {
          retentionDays: Number(process.env.SENT_TICKET_RETENTION_DAYS || 7),
          ticketOnlyMode: true,
          pollingMode: true,
        },
      );

      const sendableTickets = plan.sendable_tickets || [];
      logger.info("DB poll deduplication plan resolved", {
        totalFromDb: rawRows.length,
        valid: processedResult.valid_tickets.length,
        sendable: sendableTickets.length,
        duplicates: plan.duplicate_tickets ? plan.duplicate_tickets.length : 0,
      });

      // Update watermark waktu query ke create_time tertinggi dari baris yang ditarik
      const maxCreateTime = rawRows.reduce((latest, row) => {
        const ct = String(row.create_time || "");
        return ct > latest ? ct : latest;
      }, sinceTime);

      state.lastPollTime = pollStartTime.toISOString();
      state.lastWatermark = maxCreateTime;

      if (sendableTickets.length === 0) {
        if (!useDb) {
          await savePollWatermark(state, watermarkPath);
        }
        logger.info("DB poll cycle completed: no new sendable tickets after deduplication filter", {
          totalFromDb: rawRows.length,
          valid: processedResult.valid_tickets.length,
          duplicates: plan.duplicate_tickets ? plan.duplicate_tickets.length : 0,
        });
        return { status: "ALL_DUPLICATES", newTickets: 0 };
      }

      // 3. Notifikasi pra-kirim ke Telegram Admin
      await sendAdminNotification(formatPreSendNotification(sendableTickets));

      // 4. Kirim tiket ke WhatsApp dengan kartu progres live & adaptive jitter delay
      const primaryAdminChatId = adminChatIds[0];
      if (!createAdapter || !primaryAdminChatId) {
        logger.warn("Adapter or admin chat ID not provided, skipping WhatsApp dispatch");
        if (!useDb) {
          await savePollWatermark(state, watermarkPath);
        }
        return { status: "ADAPTER_NOT_AVAILABLE", newTickets: sendableTickets.length };
      }

      // Reset state pembatalan lama sebelum memulai pengiriman baru
      resetDeliveryCancellation();

      const adapter = createAdapter(primaryAdminChatId);
      const dispatchResult = await sendTicketDetailsToTargetGroups(
        adapter,
        adapter.sourceJid,
        sendableTickets,
        {
          skipPreamble: true,
          manualMode: false,
        },
      );

      const wasCancelled = Boolean(
        dispatchResult?.cancelled || isDeliveryCancelled(),
      );
      const actualSentCount =
        typeof dispatchResult?.sentCount === "number"
          ? dispatchResult.sentCount
          : wasCancelled
            ? 0
            : sendableTickets.length;

      // 5. Simpan watermark dan rekap pengiriman
      state.totalSentToday += actualSentCount;
      if (!useDb) {
        await savePollWatermark(state, watermarkPath);
      }

      // 6. Kirim tabel rekapitulasi ke Telegram Admin
      if (wasCancelled) {
        logger.warn("DB poll cycle dispatch stopped early due to cancellation", {
          sentCount: actualSentCount,
          totalPlanned: sendableTickets.length,
          totalSentToday: state.totalSentToday,
        });
        await sendAdminNotification(
          [
            "🛑 **PENGIRIMAN TIKET DIBATALKAN**",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            `⚠️ Pengiriman otomatis ke WhatsApp dihentikan oleh pembatalan (${actualSentCount}/${sendableTickets.length} tiket terkirim).`,
          ].join("\n"),
        );
      } else {
        const notifMessages = formatSentTicketsNotificationMessages(sendableTickets);
        for (const msg of notifMessages) {
          await sendAdminNotification(msg);
        }

        logger.info("DB poll cycle dispatch completed successfully", {
          sentCount: sendableTickets.length,
          totalSentToday: state.totalSentToday,
        });
      }

      return {
        status: wasCancelled ? "CANCELLED" : "SUCCESS",
        newTickets: sendableTickets.length,
        sentTickets: actualSentCount,
        totalSentToday: state.totalSentToday,
      };
    } catch (error) {
      lastError = error;
      logger.error("DB poll cycle encountered an error", {
        message: error.message,
        stack: error.stack,
      });
      return { status: "ERROR", error: error.message };
    } finally {
      isPollingCycleActive = false;
    }
  }

  // memulai timer polling berkala di background
  function start() {
    if (timer) clearInterval(timer);

    const intervalMinutes = Math.max(
      1,
      Number(process.env.DB_POLL_INTERVAL_MINUTES || 5),
    );
    const intervalMs = intervalMinutes * 60 * 1000;

    isRunning = true;
    isPaused = false;

    logger.info("Starting ticket polling service", {
      intervalMinutes,
      workingHours: `${process.env.DB_POLL_START_HOUR || 7}:00 - ${process.env.DB_POLL_END_HOUR || 17}:00 WIB`,
    });

    // Jalankan satu kali saat startup jika dalam jam kerja
    setTimeout(() => {
      poll().catch(() => {});
    }, 5000);

    timer = setInterval(() => {
      poll().catch(() => {});
    }, intervalMs);
  }

  // menghentikan timer polling
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    isRunning = false;
    isPaused = true;
    logger.info("Ticket polling service stopped");
  }

  function pause() {
    isPaused = true;
    logger.info("Ticket polling service paused by admin");
  }

  function resume() {
    isPaused = false;
    logger.info("Ticket polling service resumed by admin");
  }

  // mendapatkan status lengkap polling untuk command /poll status
  async function getStatus() {
    const pingResult = await pingDb();
    const state = useDb ? inMemoryState : await loadPollWatermark(watermarkPath);
    const inWorkingHours = isWithinWorkingHours();
    const intervalMinutes = Number(process.env.DB_POLL_INTERVAL_MINUTES || 5);
    const startHour = process.env.DB_POLL_START_HOUR || 7;
    const endHour = process.env.DB_POLL_END_HOUR || 17;

    return {
      isRunning,
      isPaused,
      inWorkingHours,
      intervalMinutes,
      workingHoursText: `${startHour}:00 - ${endHour}:00 WIB`,
      dbConnected: pingResult.ok,
      dbError: pingResult.error || null,
      lastPollTime: state.lastPollTime,
      lastWatermark: useDb
        ? `${getHMinusOneWatermark()} (H-1 Lookback Window)`
        : state.lastWatermark,
      totalSentToday: state.totalSentToday,
      todayDate: state.todayDate,
      lastError: lastError ? lastError.message : null,
    };
  }

  return {
    start,
    stop,
    pause,
    resume,
    poll,
    getStatus,
  };
}
