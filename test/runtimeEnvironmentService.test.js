import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  changeRuntimeEnvironment,
  formatEnvironmentStatus,
  getActiveAppEnvironment,
  resolveWhatsAppConfigPath,
} from "../src/services/runtimeEnvironmentService.js";

function setupRuntimeEnv(name) {
  const runtimePath = path.join("tmp", `${name}-runtime-env.json`);
  fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
  fs.rmSync(runtimePath, { force: true });

  const previousRuntimePath = process.env.APP_RUNTIME_ENV_PATH;
  const previousAppEnv = process.env.APP_ENV;
  const previousConfigPath = process.env.WHATSAPP_CONFIG_PATH;

  process.env.APP_RUNTIME_ENV_PATH = runtimePath;
  delete process.env.WHATSAPP_CONFIG_PATH;
  delete process.env.APP_ENV;

  return {
    runtimePath,
    cleanup() {
      fs.rmSync(runtimePath, { force: true });
      if (previousRuntimePath === undefined) {
        delete process.env.APP_RUNTIME_ENV_PATH;
      } else {
        process.env.APP_RUNTIME_ENV_PATH = previousRuntimePath;
      }
      if (previousAppEnv === undefined) {
        delete process.env.APP_ENV;
      } else {
        process.env.APP_ENV = previousAppEnv;
      }
      if (previousConfigPath === undefined) {
        delete process.env.WHATSAPP_CONFIG_PATH;
      } else {
        process.env.WHATSAPP_CONFIG_PATH = previousConfigPath;
      }
    },
  };
}

test("defaults to production WhatsApp config when no runtime env exists", () => {
  const context = setupRuntimeEnv("default-production");

  assert.equal(getActiveAppEnvironment().active_env, "production");
  assert.equal(
    path.relative(process.cwd(), resolveWhatsAppConfigPath()),
    path.join("config", "whatsapp.json"),
  );

  context.cleanup();
});

test("changes runtime environment to development and resolves whatsapp-test config", () => {
  const context = setupRuntimeEnv("change-development");

  const result = changeRuntimeEnvironment("development", {
    updatedBy: "999",
  });

  assert.equal(result.ok, true);
  assert.equal(getActiveAppEnvironment().active_env, "development");
  assert.equal(
    path.relative(process.cwd(), resolveWhatsAppConfigPath()),
    path.join("config", "whatsapp-test.json"),
  );
  assert.match(formatEnvironmentStatus(), /development/);
  assert.match(formatEnvironmentStatus(), /whatsapp-test\.json/);

  context.cleanup();
});

test("rejects runtime environment changes when WHATSAPP_CONFIG_PATH override is active", () => {
  const context = setupRuntimeEnv("override-active");
  process.env.WHATSAPP_CONFIG_PATH = "config/whatsapp-test.json";

  const result = changeRuntimeEnvironment("development", {
    updatedBy: "999",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "CONFIG_PATH_OVERRIDE_ACTIVE");

  context.cleanup();
});

test("rejects unsupported runtime environment names", () => {
  const context = setupRuntimeEnv("unsupported-env");

  const result = changeRuntimeEnvironment("staging", {
    updatedBy: "999",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "UNSUPPORTED_ENV");
  assert.equal(fs.existsSync(context.runtimePath), false);

  context.cleanup();
});
