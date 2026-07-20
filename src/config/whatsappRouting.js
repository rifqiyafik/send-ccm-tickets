import { getGroupConfig, normalizeKey } from "./appConfig.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("whatsappRouting");

// membaca fallback routing dari env WHATSAPP_GROUPS untuk kompatibilitas konfigurasi lama.
function parseGroupMapping(value = "") {
  logger.info("Parsing WHATSAPP_GROUPS env fallback");
  return Object.fromEntries(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [key, ...jidParts] = item.split(":");
        return [key.trim().toUpperCase(), jidParts.join(":").trim()];
      })
      .filter(([key, jid]) => key && jid)
  );
}

export const WHATSAPP_GROUPS = parseGroupMapping(process.env.WHATSAPP_GROUPS);

// menentukan key grup target berdasarkan tipe assignment tiket.
export function getTargetGroupKey(ticket) {
  return ticket.assignment_type === "SQA" ? "SQA" : ticket.cluster_area || ticket.nsa;
}

// menentukan grup tujuan; prioritas target_groups di config/whatsapp.json, lalu env WHATSAPP_GROUPS.
export function resolveTargetJid(ticket) {
  logger.info("Resolving WhatsApp target JID", {
    orderId: ticket.order_id,
    assignmentType: ticket.assignment_type,
    clusterArea: ticket.cluster_area,
  });

  const configGroupKey = getTargetGroupKey(ticket);
  const configGroup = getGroupConfig(configGroupKey);
  if (configGroup?.jid) {
    logger.info("Resolved target JID from target_groups config", {
      groupKey: configGroupKey,
      jid: configGroup.jid,
    });
    return configGroup.jid;
  }

  const picKey = String(ticket.pic || "").toUpperCase();
  const nsaKey = String(ticket.nsa || "").toUpperCase();
  const assignmentKey = String(ticket.assignment_type || "").toUpperCase();
  const clusterKey = normalizeKey(ticket.cluster_area);

  const targetJid =
    WHATSAPP_GROUPS[clusterKey] ||
    WHATSAPP_GROUPS[picKey] ||
    WHATSAPP_GROUPS[nsaKey] ||
    WHATSAPP_GROUPS[assignmentKey] ||
    null;

  if (!targetJid) {
    logger.warn("Target JID not found", {
      orderId: ticket.order_id,
      groupKey: configGroupKey,
      assignmentType: ticket.assignment_type,
      clusterArea: ticket.cluster_area,
      nsa: ticket.nsa,
      pic: ticket.pic,
    });
    return null;
  }

  logger.info("Resolved target JID from env fallback", { targetJid });
  return targetJid;
}
