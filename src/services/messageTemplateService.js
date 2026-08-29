import { createLogger } from "../utils/logger.js";
import { formatNameTag } from "../utils/text.js";
import { normalizeJid } from "../utils/jid.js";
import { getMentionContact } from "../config/appConfig.js";
import { extractSiteCover } from "./siteSearchService.js";
import {
  resolveTsSiteVisit,
  resolveTsSiteVisitEntry,
  formatTsMentionHeader,
} from "./siteVisitService.js";

const logger = createLogger("messageTemplateService");

export const GROUP_OPENING_MESSAGE = [
  "Assalamualaikum,",
  "Semangat Pagi dan Semangat Sehat,",
  "Dear Bapak Manager dan Tim,",
  "Berikut kami infokan tiket Remedy Customer Complaint terupdate,",
  "Mohon dibantu untuk segera di follow up.",
  "",
  "link: https://10.62.7.112:31943/portal-web/portal/homepage.html",
  "",
  "Terimakasih 🙏🏻",
].join("\n");

export const INDONESIAN_MONTHS_FULL = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

export const NOP_SHORT_NAMES = {
  ACEH: "ACEH",
  BINJAI: "BJI",
  MEDAN: "MEDAN",
  PEMATANGSIANTAR: "PMS",
  "RANTAU PRAPAT": "RAP",
  "PADANG SIDEMPUAN": "PSP",
};

export function cleanTableValue(value) {
  if (value === null || value === undefined) return "-";
  const str = String(value).trim();
  return str.length > 0 ? str : "-";
}

export function cleanMultilineText(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

export function countWords(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

// mengambil user part JID untuk token @mention yang dikenali WhatsApp, contoh 628xx@s.whatsapp.net -> @628xx.
export function getMentionTokenFromJid(jid) {
  const normalizedJid = normalizeJid(jid);
  const userPart = normalizedJid.split("@")[0];

  return userPart ? `@${userPart}` : "";
}

// mengambil label/JID mention dari config; fallback ke label teks biasa jika config belum lengkap.
export function resolveMentionTag(name, fallbackSuffix = "") {
  const contact = getMentionContact(name);
  const fallbackTag = formatNameTag(name, fallbackSuffix);
  const label = cleanTableValue(contact?.label || fallbackTag);
  const jid = normalizeJid(contact?.jid);
  const mentionToken = getMentionTokenFromJid(jid);

  if (label === "-") {
    return {
      text: "",
      jid: null,
      label: "",
      mention_token: "",
    };
  }

  if (mentionToken) {
    logger.info("Mention tag resolved with JID token", {
      name,
      jid,
      label,
      mentionToken,
    });
    return {
      text: mentionToken,
      jid,
      label,
      mention_token: mentionToken,
    };
  }

  logger.warn("Mention tag resolved without JID, output will be plain text", {
    name,
    label,
  });

  return {
    text: `@${label.replace(/^@+/, "")}`,
    jid: null,
    label,
    mention_token: "",
  };
}

// menghapus JID kosong/duplikat agar payload mentions bersih.
export function uniqueMentionJids(items) {
  return [...new Set(items.map((item) => item?.jid).filter(Boolean))];
}

export function normalizeNopAreaName(value) {
  const source = cleanTableValue(value)
    .replace(/^NOP\s+/i, "")
    .toUpperCase()
    .trim();
  const compactSource = source.replace(/\s+/g, "");

  return NOP_SHORT_NAMES[source] || NOP_SHORT_NAMES[compactSource] || source;
}

// mengambil nilai Count ReOpen dari kolom Reopen Number / Reopen Count
export function getReopenCount(ticket) {
  const value = cleanTableValue(ticket?.reopen_number ?? ticket?.reopen_count);
  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && Number.isInteger(numericValue)) {
    return String(numericValue);
  }
  return value;
}

export function extractReminderSiteIdFromProblemAnalysis(ticket) {
  const problemAnalysis = cleanMultilineText(ticket?.problem_analysis);
  const siteCover = extractSiteCover(problemAnalysis);
  if (siteCover) {
    return siteCover;
  }

  const text = cleanTableValue(problemAnalysis);
  const match = text.match(
    /\b(?:site\s+cover|di\s+cover|cover)\s+([A-Z]{2,5}\d{2,5})\b/i,
  );
  return match ? match[1].toUpperCase() : "";
}

export function getReminderSiteId(ticket) {
  return cleanTableValue(
    extractReminderSiteIdFromProblemAnalysis(ticket) || ticket?.site_id || ticket?.site_id1 || ticket?.site_cover,
  );
}

// mengambil teks remark Problem Analysis untuk tabel reminder dengan pemotongan stop patterns dan batas 15 kata.
export function getpreviousProblemAnalysis(ticket) {
  const text = cleanTableValue(cleanMultilineText(ticket?.previous_problem_analysis_remark || ticket?.problem_analysis));
  if (!text || text === "-") {
    return "-";
  }

  const stopPatterns = [
    /\bperkiraan\s+site\b/i,
    /\bdominant\s+cell\b/i,
    /\bpotensial\s+problem\b/i,
    /\bcat?egor[yi]\s+problem\b/i,
  ];
  const stopIndexes = stopPatterns
    .map((pattern) => text.search(pattern))
    .filter((index) => index >= 0);
  const processedText =
    stopIndexes.length > 0 ? text.slice(0, Math.min(...stopIndexes)) : text;

  const sentences = processedText
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let resultText = processedText;
  if (sentences.length > 0) {
    const firstSentence = sentences[0];
    const wordCountFirst = countWords(firstSentence);

    if (wordCountFirst >= 15) {
      resultText = firstSentence;
    } else if (sentences.length >= 2) {
      resultText = `${firstSentence} ${sentences[1]}`;
    }
  }

  return (
    resultText
      .replace(/\s+/g, " ")
      .replace(/\s+[.,;:]+$/g, "")
      .trim() || "-"
  );
}

export function getReminderDepartmentName(ticket) {
  const department = cleanTableValue(
    ticket?.departement_ns ||
      ticket?.departemen_ns ||
      ticket?.cluster_area ||
      ticket?.nsa ||
      ticket?.city ||
      ticket?.assignment_group,
  );

  return normalizeNopAreaName(department) || "-";
}

export function getNopReminderName(tickets) {
  const firstTicket = tickets?.[0] || {};
  const source = cleanTableValue(
    firstTicket.cluster_area || firstTicket.nsa || firstTicket.assignment_group,
  )
    .replace(/^NOP\s+/i, "")
    .toUpperCase();

  return normalizeNopAreaName(source) || "NOP";
}

export function summarizeSla(tickets) {
  return tickets.reduce(
    (summary, ticket) => {
      summary.total += 1;
      const sla = cleanTableValue(ticket?.sla_status).toUpperCase();
      if (sla === "IN SLA") {
        summary.inSla += 1;
      }
      if (sla === "OUT SLA") {
        summary.outSla += 1;
      }
      return summary;
    },
    { total: 0, inSla: 0, outSla: 0 },
  );
}

export function hasRequiredReminderDetailData(ticket) {
  return [
    cleanTableValue(ticket?.order_id),
    getReminderSiteId(ticket),
    getReopenCount(ticket),
    getpreviousProblemAnalysis(ticket),
  ].every((value) => value && value !== "-");
}

export function hasRequiredNopReminderDetailData(ticket) {
  return (
    hasRequiredReminderDetailData(ticket) &&
    cleanTableValue(ticket?.pic_nop) !== "-"
  );
}

export function getReopenReminderTickets(tickets, { requirePicNop = false } = {}) {
  return tickets.filter((ticket) =>
    requirePicNop
      ? hasRequiredNopReminderDetailData(ticket)
      : hasRequiredReminderDetailData(ticket),
  );
}

// membuat teks reminder untuk grup SQA sebelum detail tiket dikirim.
export function formatSqaReminderMessage(tickets) {
  const summary = summarizeSla(tickets);
  const detailTickets = getReopenReminderTickets(tickets);
  const lines = [
    "*Remind Ticket CX Open:*",
    "",
    "*Group | Total Ticket | In SLA | Out SLA*",
    `*SQA | ${summary.total} | ${summary.inSla} | ${summary.outSla}*`,
  ];

  if (detailTickets.length > 0) {
    lines.push(
      "",
      "*Wilayah | Nomor Ticket | SITE ID | Count ReOpen | Remark ReOpen*",
      "*---------------------------------------------------------------------------*",
      ...detailTickets.flatMap((ticket) => [
        `*${getReminderDepartmentName(ticket)} | ${cleanTableValue(
          ticket.order_id,
        )} | ${getReminderSiteId(ticket)} | ${getReopenCount(
          ticket,
        )} | ${getpreviousProblemAnalysis(ticket)}*`,
        "",
      ]),
    );
  }

  return lines.join("\n");
}

// membuat teks reminder untuk grup NOP sebelum detail tiket dikirim.
export function formatNopReminderMessage(tickets) {
  const summary = summarizeSla(tickets);
  const nopName = getNopReminderName(tickets);
  const detailTickets = getReopenReminderTickets(tickets, {
    requirePicNop: true,
  });
  const mentionTags = detailTickets.map((ticket) =>
    resolveMentionTag(ticket.pic_nop),
  );
  const lines = [
    "*Remind ticket CX Open :*",
    "",
    "*NOP | Total Ticket | In SLA | Out SLA*",
    `*${nopName} | ${summary.total} | ${summary.inSla} | ${summary.outSla}*`,
  ];

  if (detailTickets.length > 0) {
    lines.push(
      "",
      "*PIC NOP | Nomor Ticket | Site ID | Count ReOpen | Remark ReOpen*",
      "*---------------------------------------------------------------------------*",
      ...detailTickets.flatMap((ticket, index) => {
        const tag = mentionTags[index];
        return [
          `*${tag?.text || "-"} | ${cleanTableValue(ticket.order_id)} | ${cleanTableValue(
            getReminderSiteId(ticket),
          )} | ${getReopenCount(ticket)} | ${getpreviousProblemAnalysis(ticket)}*`,
          "",
        ];
      }),
    );
  }

  return {
    text: lines.join("\n"),
    mentions: uniqueMentionJids(mentionTags),
  };
}

// pesan salam yang dikirim ke grup tujuan sebelum Excel, reminder, dan detail tiket.
export function formatTargetGroupOpeningMessage() {
  logger.info("Formatting target group opening message");
  return GROUP_OPENING_MESSAGE;
}

// nama file Excel update harian, contoh: Update Ticket 20 Juli Pagi.xlsx.
export function formatUpdateTicketFileName(now = new Date()) {
  const period =
    now.getHours() < 11
      ? "Pagi"
      : now.getHours() < 15
        ? "Siang"
        : now.getHours() < 18
          ? "Sore"
          : "Malam";
  const fileName = `Update Ticket ${now.getDate()} ${
    INDONESIAN_MONTHS_FULL[now.getMonth()]
  } ${period}.xlsx`;

  logger.info("Formatted update ticket file name", { fileName });
  return fileName;
}

// membuat payload reminder berdasarkan assignment grup target.
export function formatReminderMessagePayload(tickets) {
  const assignmentType = tickets[0]?.assignment_type;
  logger.info("Formatting reminder message payload", {
    assignmentType,
    tickets: tickets.length,
  });

  if (assignmentType === "SQA") {
    return {
      text: formatSqaReminderMessage(tickets),
      mentions: [],
    };
  }

  return formatNopReminderMessage(tickets);
}

// membuat format khusus untuk Ticket Re-Open yang sudah memiliki data L2/resolution/root cause/site L2.
export function formatReopenEscalationText(ticket, { ccmTag, sqaTag, nopTag }) {
  const isSqa = ticket.assignment_type === "SQA";
  const reopenNumber = getReopenCount(ticket);
  const reopenLine =
    reopenNumber === "-"
      ? "*Ticket Re-Open*"
      : `*Ticket Re-Open (${reopenNumber}X)*`;
  const problemAnalysisRemark = cleanMultilineText(ticket.problem_analysis);
  const remarkLines = problemAnalysisRemark
    ? ["_Remark Problem Analysis:_", problemAnalysisRemark]
    : [];

  logger.info("Formatting ReOpen escalation text", {
    orderId: ticket.order_id,
    assignmentType: ticket.assignment_type,
    reopenNumber,
    hasProblemAnalysisRemark: Boolean(problemAnalysisRemark),
    filledColumns: ticket.reopen_filled_columns,
  });

  if (isSqa) {
    return [
      `Mohon dibantu pengecekannya kembali ya bang ${ccmTag.text || "-"}`,
      `*${ticket.order_id || "-"}*`,
      `CC bang ${sqaTag.text || "-"}`,
      "",
      reopenLine,
      ...remarkLines,
      `SLA DUE DATE 24H : *${ticket.resolve_target_22h_text || "-"}*`,
    ].join("\n");
  }

  return [
    `Mohon dibantu pengecekannya kembali ya bang ${nopTag.text || "-"}`,
    `*${ticket.order_id || "-"}*`,
    "",
    reopenLine,
    ...remarkLines,
    `SLA DUE DATE 24H : *${ticket.resolve_target_22h_text || "-"}*`,
  ].join("\n");
}

export function isOutSlaInProgressTicket(ticket) {
  const slaStatus = cleanTableValue(ticket.sla_status).toUpperCase();
  const businessStatus = cleanTableValue(ticket.business_status)
    .toUpperCase()
    .replace(/[\s_-]+/g, "");

  return slaStatus === "OUT SLA" && businessStatus === "INPROGRESS";
}

export function formatOutSlaInProgressEscalationText(ticket, { ccmTag, nopTag }) {
  const isSqa = ticket.assignment_type === "SQA";
  const assigneeTag = isSqa ? ccmTag : nopTag;

  logger.info("Formatting OUT SLA In Progress reminder text", {
    orderId: ticket.order_id,
    assignmentType: ticket.assignment_type,
  });

  return [
    `Mohon dibantu bang ${assigneeTag.text || "-"}`,
    ticket.order_id || "-",
    "",
    `SLA DUE DATE 24H : *${ticket.resolve_target_22h_text || "-"}*`,
  ].join("\n");
}

export function getReminderAssigneeTag(ticket, options = {}) {
  if (ticket.assignment_type === "SQA") {
    const usePicSqa = options.usePicSqa || options.targetGroupKey === "MAIN SQA";
    return usePicSqa
      ? resolveMentionTag(ticket.pic_sqa, "PIC SQA Telkomsel")
      : resolveMentionTag(ticket.ccm_handling, "CCM");
  }
  return resolveMentionTag(ticket.pic_nop);
}

export function getInProgressReminderTargetName(tickets) {
  const assignmentType = tickets[0]?.assignment_type;
  if (assignmentType === "SQA") {
    return "SQA SUMBAGUT";
  }

  return `NOP ${getNopReminderName(tickets)}`;
}

export function parseFormattedDueDate(rawDueDate, ticket) {
  if (
    ticket?.resolve_target_22h instanceof Date &&
    !Number.isNaN(ticket.resolve_target_22h.getTime())
  ) {
    return ticket.resolve_target_22h;
  }
  if (!rawDueDate || rawDueDate === "-") {
    return null;
  }
  const cleaned = rawDueDate.replace(/^[A-Za-z]+\s*\/\s*/, "").trim();
  const enFormatted = cleaned
    .replace(/\bMei\b/i, "May")
    .replace(/\bAgu\b/i, "Aug")
    .replace(/\bOkt\b/i, "Oct")
    .replace(/\bDes\b/i, "Dec");
  const date = new Date(enFormatted);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatOverdueTime(rawDueDate, ticket, now = new Date()) {
  const dueDate = parseFormattedDueDate(rawDueDate, ticket);
  if (!dueDate) return "";

  const diffMs = now.getTime() - dueDate.getTime();
  if (diffMs <= 0) return "";

  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor((diffMs / (1000 * 60 * 60)) % 24);
  const diffMinutes = Math.floor((diffMs / (1000 * 60)) % 60);

  return diffDays > 0
    ? `Out ${diffDays}d ${diffHours}h ${diffMinutes}m`
    : `Out ${diffHours}h ${diffMinutes}m`;
}

export function getInProgressReminderLine(ticket, index) {
  const slaStatus = cleanTableValue(ticket.sla_status).toUpperCase() || "-";
  const siteId = getReminderSiteId(ticket) || "-";
  const rawDueDate = cleanTableValue(ticket.resolve_target_22h_text);
  const businessStatus = cleanTableValue(ticket.business_status)
    .toUpperCase()
    .replace(/[\s_-]+/g, "");
  const reopenCountStr = getReopenCount(ticket);
  const reopenNum = Number(reopenCountStr);
  const isReopen = businessStatus === "REOPEN";

  let dueText = "";
  if (isReopen && Number.isFinite(reopenNum)) {
    dueText = reopenNum > 1 ? `${reopenNum}X ReOpen` : "ReOpen";
  } else if (slaStatus === "IN SLA") {
    dueText = rawDueDate !== "-" ? rawDueDate : "";
  } else if (slaStatus === "OUT SLA" && businessStatus === "INPROGRESS") {
    dueText = formatOverdueTime(rawDueDate, ticket);
  }

  const extraPart = dueText ? ` | ${dueText}` : "";
  return `${index + 1}. *${cleanTableValue(ticket.order_id)}* | ${slaStatus} | ${siteId}${extraPart}`;
}

// membuat bubble reminder ringkas untuk tiket In Progress yang sudah pernah dikirim hari sebelumnya.
export function formatInProgressReminderMessagePayload(tickets, options = {}) {
  const isReminderCmd = Boolean(
    options.isReminderCmd || options.includeSummary,
  );
  const reminderTickets = isReminderCmd
    ? tickets
    : tickets.filter(
        (ticket) =>
          cleanTableValue(ticket.business_status)
            .toUpperCase()
            .replace(/[\s_-]+/g, "") === "INPROGRESS",
      );

  if (!reminderTickets || reminderTickets.length === 0) {
    return {
      text: "",
      mentions: [],
    };
  }

  const summary = summarizeSla(reminderTickets);
  const targetName = getInProgressReminderTargetName(reminderTickets);
  const groupedByPic = new Map();

  for (const ticket of reminderTickets) {
    const tag = getReminderAssigneeTag(ticket, options);
    const key = cleanTableValue(tag.label || tag.text || "-").toUpperCase();
    const group = groupedByPic.get(key) || {
      tag,
      tickets: [],
    };
    group.tickets.push(ticket);
    groupedByPic.set(key, group);
  }

  const mentionTags = [...groupedByPic.values()].map((group) => group.tag);
  const lines = [
    "*🔔 REMIND TICKET IN PROGRESS*",
    "",
    `Izin mengingatkan, berikut tiket yang masih belum resolve di *${targetName}*.`,
    "",
  ];

  if (isReminderCmd) {
    lines.push(
      "*📊 Summary:*",
      `*Total | In SLA | Out SLA*`,
      `*${summary.total} | ${summary.inSla} | ${summary.outSla}*`,
      "",
    );
  }

  for (const group of [...groupedByPic.values()].sort((a, b) =>
    cleanTableValue(a.tag?.label).localeCompare(cleanTableValue(b.tag?.label)),
  )) {
    lines.push(`👤 ${group.tag?.text || "-"}`);
    lines.push(
      ...group.tickets.map((ticket, index) =>
        getInProgressReminderLine(ticket, index),
      ),
      "",
    );
  }

  lines.push(
    "Mohon dibantu update dan resolve tiketnya ya abang-abang.",
    "Untuk tiket IN SLA mohon dijaga agar tidak masuk OUT SLA.",
    "",
    "Terimakasih 🙏",
  );

  logger.info("In Progress reminder message payload created", {
    assignmentType: reminderTickets[0]?.assignment_type,
    tickets: reminderTickets.length,
    picGroups: groupedByPic.size,
    isReminderCmd,
  });

  return {
    text: lines.join("\n").trim(),
    mentions: uniqueMentionJids(mentionTags),
  };
}

export function extractCustomerDetailsSummary(textInput, row = {}) {
  const text = String(textInput ?? "");
  const lines = [];

  const extractField = (patterns) => {
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m && m[1] !== undefined) {
        return m[1].trim();
      }
    }
    return "";
  };

  const namaCustomer =
    extractField([/Nama Customer\s*:\s*([^\r\n]+)/i]) ||
    cleanTableValue(row["Customer Name"] || row["Nama Customer"]);
  const msisdnA =
    extractField([/MSISDN-A(?: Yang Menghubungi)?\s*:\s*([^\r\n]+)/i]) ||
    cleanTableValue(
      row["Customer MSISDN(Create Ticket_customer_msisdn)"] ||
        row["Customer MSISDN"],
    );
  const msisdnB =
    extractField([/MSISDN-B(?: Yang Bermasalah)?\s*:\s*([^\r\n]+)/i]) || msisdnA;
  const tglKejadian =
    extractField([/Tanggal(?:\/Jam)? Kejadian\s*:\s*([^\r\n]+)/i]) ||
    cleanTableValue(row["Create Time"]);
  const lokasi =
    extractField([/Lokasi Pelanggan(?:\s*\(alamat\))?\s*:\s*([^\r\n]+)/i]) ||
    cleanTableValue(row["Kabupaten/Kota(Create Ticket)"] || row["City"]);
  const koordinat = extractField([
    /Koordinat customer\s*:\s*([^\r\n]*)/i,
    /Koordinat\s*:\s*([^\r\n]*)/i,
  ]);
  const simCapability = extractField([/SIM Capability\s*:\s*([^\r\n]+)/i]);
  const tier = extractField([/Customer Tier(?: Pelanggan)?\s*:\s*([^\r\n]+)/i]);
  const caseOwner = extractField([/Case Owner\s*:\s*([^\r\n]+)/i]);
  const detailComplain = extractField([
    /Detail Complain\s*:\s*([^\r\n]+)/i,
    /Detail Complaint\s*:\s*([^\r\n]+)/i,
    /kendala\s*:\s*([^\r\n]+)/i,
  ]);
  const captureCca = extractField([
    /Capture CCA\s*:\s*([^\r\n]+)/i,
    /Capture Bukti Pelanggan\s*:\s*([^\r\n]+)/i,
  ]);

  if (namaCustomer && namaCustomer !== "-") lines.push(`Nama Customer : ${namaCustomer}`);
  if (msisdnA && msisdnA !== "-") lines.push(`MSISDN-A Yang Menghubungi : ${msisdnA}`);
  if (msisdnB && msisdnB !== "-") lines.push(`MSISDN-B Yang Bermasalah : ${msisdnB}`);
  if (tglKejadian && tglKejadian !== "-") lines.push(`Tanggal/Jam Kejadian : ${tglKejadian}`);
  if (lokasi && lokasi !== "-") lines.push(`Lokasi Pelanggan (alamat) : ${lokasi}`);
  lines.push(`Koordinat customer : ${koordinat || ""}`);
  if (simCapability && simCapability !== "-") lines.push(`SIM Capability : ${simCapability}`);
  if (tier && tier !== "-") lines.push(`Customer Tier Pelanggan : ${tier}`);
  if (caseOwner && caseOwner !== "-") lines.push(`Case Owner : ${caseOwner}`);
  if (detailComplain && detailComplain !== "-") lines.push(`Detail Complain : ${detailComplain}`);
  if (captureCca && captureCca !== "-") lines.push(`Capture CCA : ${captureCca}`);

  return lines.join("\n");
}

export function extractRepetitiveNote(textInput, row = {}) {
  const text = String(textInput ?? "");
  const m = text.match(/Note\s*:\s*([^\r\n]+(?:[\r\n]+(?!(?:SLA|Capture|Remarks|Suggestion|Mohon dibantu))[^\r\n]+)*)/i);
  if (m && m[1]) {
    return m[1].trim();
  }
  return cleanTableValue(row["Note"] || row["Notes"]) || "-";
}

export function cleanCcmAnalysis(text) {
  if (!text) return "-";
  let cleaned = String(text).trim();
  cleaned = cleaned.replace(/\s*(?:Potensial|Potential)\s+Problem\s*:\s*.*$/is, "").trim();
  return cleaned || "-";
}

export function formatRepetitiveEscalationPayload(ticket) {
  logger.info("Formatting repetitive escalation message", {
    orderId: ticket.order_id,
  });

  const tsList = ticket.ts_site_visit || resolveTsSiteVisit(ticket);
  const tsTags = formatTsMentionHeader(tsList);
  const sqaTag = resolveMentionTag(ticket.pic_sqa, "PIC SQA Telkomsel");
  const bagusTag = resolveMentionTag("Bagus", "PIC SQA Telkomsel");

  let ccLine;
  if (sqaTag.jid && bagusTag.jid && sqaTag.jid !== bagusTag.jid) {
    ccLine = `CC bang ${sqaTag.text} & bang ${bagusTag.text}`;
  } else {
    const singleTag = sqaTag.text || bagusTag.text || "-";
    ccLine = `CC bang ${singleTag}`;
  }

  const customerSummary =
    ticket.customer_summary_text ||
    extractCustomerDetailsSummary(ticket.raw_description || ticket.notes, ticket.row_raw || {});

  const rawCcmAnalysis = ticket.ccm_analysis || ticket.resolution_l2 || "-";
  const ccmAnalysis = cleanCcmAnalysis(rawCcmAnalysis);

  const rawNote =
    ticket.repetitive_note ||
    extractRepetitiveNote(ticket.raw_description || ticket.notes, ticket.row_raw || {});
  const cleanNote = String(rawNote || "").trim();
  const hasNote =
    cleanNote &&
    cleanNote !== "-" &&
    !/^tidak ada$/i.test(cleanNote) &&
    !/^none$/i.test(cleanNote);

  const lines = [
    `Mohon dibantu ${tsTags}`,
    ticket.order_id || "-",
    ccLine,
    "",
    ticket.order_id || "-",
    "",
    "Ticket Complain Repetitif",
    "",
    customerSummary || "-",
    "",
    `CCM Analysis : ${ccmAnalysis}`,
    "",
  ];

  if (hasNote) {
    lines.push(`Note : ${cleanNote}`, "");
  }

  lines.push(
    `SLA DUE DATE 24H : *${ticket.resolve_target_22h_text || "-"}*`,
    "",
    "Mohon dibantu ya bang🙏🏻🙏🏻",
  );

  const mentions = uniqueMentionJids([
    ...tsList,
    sqaTag,
    bagusTag,
  ]);

  logger.info("Repetitive escalation message mention payload created", {
    orderId: ticket.order_id,
    mentions,
  });

  return {
    text: lines.join("\n").trim(),
    mentions,
  };
}

export function formatSiteVisitCombinedReminderPayload(tickets, options = {}) {
  if (!tickets || tickets.length === 0) {
    return { text: "", mentions: [] };
  }

  const summary = summarizeSla(tickets);
  const allMentions = [];

  // Group tickets by TS Area
  const areaGroups = new Map();
  for (const ticket of tickets) {
    const { area, tsList } = resolveTsSiteVisitEntry(ticket);
    const groupKey = area.toUpperCase();
    const group = areaGroups.get(groupKey) || {
      area,
      tsList,
      tickets: [],
    };
    group.tickets.push(ticket);
    areaGroups.set(groupKey, group);
  }

  const lines = [
    "🔔 *REMINDER TIKET REPETITIF / SITE VISIT*",
    "",
    "Selamat pagi/siang abang-abang, izin mengingatkan kembali progres tiket complain repetitif yang masih berstatus *In Progress* di Sumbagut.",
    "",
    "📊 *Summary:*",
    "*Total | In SLA | Out SLA*",
    `*${summary.total} | ${summary.inSla} | ${summary.outSla}*`,
  ];

  for (const group of areaGroups.values()) {
    const tsHeader = formatTsMentionHeader(group.tsList);
    lines.push(
      "",
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `👤 *TS ${group.area}*: ${tsHeader}`,
      "",
    );

    group.tsList.forEach((ts) => {
      if (ts.jid) allMentions.push(ts.jid);
    });

    group.tickets.forEach((ticket, idx) => {
      const rawDesc = String(ticket.raw_description || ticket.notes || "");
      const locMatch = rawDesc.match(/Lokasi Pelanggan(?: \(alamat\))?\s*:\s*([^\r\n]+)/i);
      const lokasi = locMatch ? locMatch[1].trim() : (ticket.city || ticket.nsa || "-");

      const compMatch = rawDesc.match(/(?:Detail Complain|Detail Complaint|kendala)\s*:\s*([^\r\n]+)/i);
      const kendala = compMatch ? compMatch[1].trim() : (ticket.incident_domain || ticket.symptom || "-");

      const siteId = cleanTableValue(ticket.site_id) || cleanTableValue(ticket.site_name) || "-";
      const slaStatus = ticket.sla_status || "IN SLA";
      const due = ticket.resolve_target_22h_text || "-";

      lines.push(
        `${idx + 1}. *${ticket.order_id}* | ${slaStatus} | ${siteId}`,
        `   📍 ${lokasi}`,
        `   ⚠️ Kendala: ${kendala}`,
        `   ⏱️ Due: ${due}`,
      );
      if (idx < group.tickets.length - 1) {
        lines.push("");
      }
    });
  }

  // CC SQA & Bg Bagus
  const sqaPics = new Set();
  tickets.forEach((t) => {
    if (t.pic_sqa) sqaPics.add(t.pic_sqa);
  });

  const sqaTags = [];
  sqaPics.forEach((pic) => {
    const tag = resolveMentionTag(pic, "PIC SQA Telkomsel");
    if (tag.jid && !sqaTags.some((st) => st.jid === tag.jid)) {
      sqaTags.push(tag);
      allMentions.push(tag.jid);
    }
  });

  const bagusTag = resolveMentionTag("Bagus", "PIC SQA Telkomsel");
  if (bagusTag.jid && !sqaTags.some((st) => st.jid === bagusTag.jid)) {
    sqaTags.push(bagusTag);
    allMentions.push(bagusTag.jid);
  }

  const sqaCcText = sqaTags.length > 0
    ? sqaTags.map((t) => `bang ${t.text}`).join(" & ")
    : "bang -";

  lines.push(
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "👥 *CC Pengawalan & Koordinasi:*",
    sqaCcText,
    "",
    "Mohon kesediaan dan kerjasamanya untuk dapat segera diagendakan kunjungan/pengecekan ke site terkait agar keluhan pelanggan tidak berulang kembali dan SLA tetap aman ya bang 🙏🏻",
    "",
    "Semangat dan terima kasih atas bantuannya! 💪🏻",
  );

  return {
    text: lines.join("\n").trim(),
    mentions: [...new Set(allMentions.filter(Boolean))],
  };
}

// membuat teks pesan eskalasi dan daftar JID mention yang dikirim ke Baileys.
export function formatEscalationMessagePayload(ticket) {
  logger.info("Formatting escalation message", {
    orderId: ticket.order_id,
    assignmentType: ticket.assignment_type,
    isRepetitive: ticket.is_repetitive,
  });

  if (
    ticket.is_repetitive ||
    ticket.targetGroupKey === "SITE VISIT" ||
    ticket.assignment_type === "SITE_VISIT"
  ) {
    return formatRepetitiveEscalationPayload(ticket);
  }

  const ccmTag = resolveMentionTag(ticket.ccm_handling, "CCM");
  const sqaTag = resolveMentionTag(ticket.pic_sqa, "PIC SQA Telkomsel");
  const nopTag = resolveMentionTag(ticket.pic_nop);
  const isSqa = ticket.assignment_type === "SQA";

  if (ticket.use_reopen_message_format && !ticket.escalated_from) {
    const mentions = uniqueMentionJids(isSqa ? [ccmTag, sqaTag] : [nopTag]);
    const text = formatReopenEscalationText(ticket, { ccmTag, sqaTag, nopTag });

    logger.info("ReOpen escalation message mention payload created", {
      orderId: ticket.order_id,
      mentionDetails: isSqa ? [ccmTag, sqaTag] : [nopTag],
      mentions,
    });

    return {
      text,
      mentions,
    };
  }

  if (isOutSlaInProgressTicket(ticket) && !ticket.escalated_from) {
    const mentions = uniqueMentionJids(isSqa ? [ccmTag] : [nopTag]);
    const text = formatOutSlaInProgressEscalationText(ticket, {
      ccmTag,
      nopTag,
    });

    logger.info("OUT SLA In Progress reminder mention payload created", {
      orderId: ticket.order_id,
      mentionDetails: isSqa ? [ccmTag, sqaTag] : [nopTag],
      mentions,
    });

    return {
      text,
      mentions,
    };
  }

  const intro = isSqa
    ? [
        `Mohon dibantu bang ${ccmTag.text || "-"}`,
        ticket.order_id || "-",
        `CC bang ${sqaTag.text || "-"}`,
      ]
    : [`Mohon dibantu bang ${nopTag.text || "-"}`, ticket.order_id || "-"];
  const repeatedOrderId = isSqa ? [ticket.order_id || "-", ""] : [];
  const middleHeader = ticket.escalated_from
    ? [`*Ticket Escalated from ${ticket.escalated_from}*`, ticket.order_id || "-", ""]
    : repeatedOrderId;

  const text = [
    ...intro,
    "",
    ...middleHeader,
    ticket.notes || "-",
    "",
    "====================",
    "",
    ticket.analysis_text || "-",
    "",
    `SLA DUE DATE 24H : *${ticket.resolve_target_22h_text || "-"}*`,
  ].join("\n");

  const mentions = uniqueMentionJids(isSqa ? [ccmTag, sqaTag] : [nopTag]);
  logger.info("Escalation message mention payload created", {
    orderId: ticket.order_id,
    mentionDetails: isSqa ? [ccmTag, sqaTag] : [nopTag],
    mentions,
  });

  return {
    text,
    mentions,
  };
}

// membuat format pesan eskalasi final untuk SQA/NOP berdasarkan PIC dan konten notes/analisis.
export function formatEscalationMessage(ticket) {
  return formatEscalationMessagePayload(ticket).text;
}
