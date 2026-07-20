import assert from "node:assert/strict";
import test from "node:test";

import {
  createCityResolver,
  createSiteResolver,
  extractSiteCover,
} from "../src/services/siteSearchService.js";

test("extracts site id from #Site Cover with spaces", () => {
  const text = `
Lokasi Pelanggan (alamat): jl dr masyur 66 merdeka

#Site Cover : MDN629
E_MDN926ML1_StmkDalam_ML03
`;

  assert.equal(extractSiteCover(text), "MDN629");
});

test("extracts site id from #SiteCover without spaces", () => {
  assert.equal(extractSiteCover("#SiteCover: BIR185"), "BIR185");
});

test("resolves city from direct city column first", () => {
  const resolveCityFromTicketRow = createCityResolver({
    rows: [
      {
        site_id: "MDN629",
        kabupaten: "KOTA MEDAN",
      },
    ],
  });

  const result = resolveCityFromTicketRow({
    "Kabupaten/Kota(Create Ticket)": "KOTA LANGSA",
    "Problem Analysis NSH": "#Site Cover : MDN629",
  });

  assert.equal(result.ok, true);
  assert.equal(result.city, "KOTA LANGSA");
  assert.equal(result.source, "city_column");
  assert.equal(result.site_id, null);
});

test("resolves city from Problem Analysis NSH site cover when city is empty", () => {
  const resolveCityFromTicketRow = createCityResolver({
    rows: [
      {
        site_id: "MDN629",
        kabupaten: "KOTA MEDAN",
        site_name: "SEISIKAMBING",
        departement_ns: "NOP MEDAN",
      },
    ],
  });

  const result = resolveCityFromTicketRow({
    "Kabupaten/Kota(Create Ticket)": "",
    "Problem Analysis NSH": "#Site Cover : MDN629",
  });

  assert.equal(result.ok, true);
  assert.equal(result.city, "KOTA MEDAN");
  assert.equal(result.source, "problem_analysis_nsh");
  assert.equal(result.site_id, "MDN629");
});

test("returns clear reason when city and site cover are missing", () => {
  const resolveCityFromTicketRow = createCityResolver({ rows: [] });

  const result = resolveCityFromTicketRow({
    "Kabupaten/Kota(Create Ticket)": "",
    "Problem Analysis NSH": "Tidak ada site cover",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "CITY_EMPTY_AND_SITE_COVER_NOT_FOUND");
});

test("resolves site details from site_id1 column first", () => {
  const resolveSiteFromTicketRow = createSiteResolver({
    rows: [
      {
        site_id: "MDN629",
        kabupaten: "KOTA MEDAN",
        vendor: "ERICSSON",
        departement_ns: "NOP MEDAN",
      },
    ],
  });

  const result = resolveSiteFromTicketRow({
    "site_id1(L1 Assign)": "MDN629",
    "Problem Analysis NSH": "#SiteCover: BIR185",
  });

  assert.equal(result.ok, true);
  assert.equal(result.site_id, "MDN629");
  assert.equal(result.vendor, "ERICSSON");
  assert.equal(result.cluster_area, "NOP MEDAN");
  assert.equal(result.source, "site_id1_column");
});

test("resolves site details from site cover when site_id1 is empty", () => {
  const resolveSiteFromTicketRow = createSiteResolver({
    rows: [
      {
        site_id: "BIR185",
        kabupaten: "ACEH UTARA",
        vendor: "HUAWEI",
        departement_ns: "NOP BINJAI",
      },
    ],
  });

  const result = resolveSiteFromTicketRow({
    "site_id1(L1 Assign)": "",
    "Problem Analysis NSH": "#SiteCover: BIR185",
  });

  assert.equal(result.ok, true);
  assert.equal(result.site_id, "BIR185");
  assert.equal(result.vendor, "HUAWEI");
  assert.equal(result.cluster_area, "NOP BINJAI");
  assert.equal(result.source, "problem_analysis_nsh");
});
