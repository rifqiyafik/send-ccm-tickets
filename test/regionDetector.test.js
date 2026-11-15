import assert from "node:assert/strict";
import test from "node:test";
import {
  extractSitePrefix,
  detectSuspectedRegion,
} from "../src/utils/regionDetector.js";

test("extractSitePrefix extracts 3-letter prefix from complex cell strings", () => {
  assert.equal(extractSitePrefix("E_JKT388MT1_Gedungbrantas_MT03"), "JKT");
  assert.equal(extractSitePrefix("MDN629"), "MDN");
  assert.equal(extractSitePrefix("4G_BJI182_SEI_BINGAI"), "BJI");
  assert.equal(extractSitePrefix("BDG001"), "BDG");
  assert.equal(extractSitePrefix(""), "");
  assert.equal(extractSitePrefix(null), "");
});

test("detectSuspectedRegion recognizes Jakarta / Jabotabek from site prefix", () => {
  const result = detectSuspectedRegion({
    siteId: "E_JKT388MT1_Gedungbrantas_MT03",
  });
  assert.equal(result.isOutOfRegion, true);
  assert.equal(result.suspectedRegion, "Jabotabek & Banten (Regional 2)");
  assert.ok(result.matchedBy.includes("JKT"));
  assert.ok(result.recommendation.includes("reassign"));
});

test("detectSuspectedRegion recognizes out-of-region from address text keywords", () => {
  const result = detectSuspectedRegion({
    addressText: "kel. cawang jakarta timur detil itu aja jatinegara",
  });
  assert.equal(result.isOutOfRegion, true);
  assert.equal(result.suspectedRegion, "Jabotabek & Banten (Regional 2)");
  assert.ok(result.matchedBy.includes("Jakarta"));
});

test("detectSuspectedRegion recognizes Bandung / Jawa Barat", () => {
  const result = detectSuspectedRegion({
    siteId: "BDG123",
  });
  assert.equal(result.isOutOfRegion, true);
  assert.equal(result.suspectedRegion, "Jawa Barat (Regional 3)");
});

test("detectSuspectedRegion recognizes Surabaya / Jawa Timur", () => {
  const result = detectSuspectedRegion({
    siteId: "SBY045",
  });
  assert.equal(result.isOutOfRegion, true);
  assert.equal(result.suspectedRegion, "Jawa Timur (Regional 5)");
});

test("detectSuspectedRegion returns isOutOfRegion: false for Sumbagut sites", () => {
  const result = detectSuspectedRegion({
    siteId: "MDN629",
    cityText: "KOTA MEDAN",
  });
  assert.equal(result.isOutOfRegion, false);
  assert.equal(result.suspectedRegion, null);
});
