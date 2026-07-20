import "dotenv/config";

import { startBot } from "./src/handlers/whatsappMessageHandler.js";
import { createLogger } from "./src/utils/logger.js";

const logger = createLogger("index");

// #penjelasan: entry point aplikasi; semua koneksi dan handler WhatsApp dimulai dari sini.
startBot().catch((error) => {
  logger.error("Failed to start WhatsApp bot", error);
  process.exit(1);
});
