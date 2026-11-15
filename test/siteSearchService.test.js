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

test("resolves site details from site_id_l2_assign when site_id1 is empty or opaque", () => {
  const resolveSiteFromTicketRow = createSiteResolver({
    rows: [
      {
        site_id: "PMR059",
        site_name: "PERDAGANGAN",
        kabupaten: "SIMALUNGUN",
        vendor: "ERICSSON",
        departement_ns: "NOP PEMATANGSIANTAR",
      },
    ],
  });

  // 1. When site_id1 is empty
  const res1 = resolveSiteFromTicketRow({
    site_id1_l1_assign: "",
    site_id_l2_assign: "PMR059",
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.site_id, "PMR059");
  assert.equal(res1.source, "site_id_l2_assign");

  // 2. When site_id1 is opaque (e.g. numeric ID 12345678)
  const res2 = resolveSiteFromTicketRow({
    site_id1_l1_assign: "12345678",
    site_id_l2_assign: "PMR059ML2", // with cell sector
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.site_id, "PMR059");
  assert.equal(res2.source, "site_id_l2_assign_token");
});

test("resolves site details from tech tag pattern e.g. Site cover (4G): LHK330ML1", () => {
  const resolveSiteFromTicketRow = createSiteResolver({
    rows: [
      {
        site_id: "LHK330",
        site_name: "PAYAPUNTEUT",
        kabupaten: "KOTA LHOKSEUMAWE",
        vendor: "HUAWEI",
        departement_ns: "NOP BANDA ACEH",
      },
    ],
  });

  const res = resolveSiteFromTicketRow({
    site_id1_l1_assign: "-",
    problem_analysis_nsh: "- Site cover (4G): LHK330ML1 jarak site 115 Metre",
  });
  assert.equal(res.ok, true);
  assert.equal(res.site_id, "LHK330");
});

test("resolves site details from geographic kecamatan fallback", () => {
  const resolveSiteFromTicketRow = createSiteResolver({
    rows: [
      {
        site_id: "DLS704",
        site_name: "BAKTIRAJA",
        kabupaten: "HUMBANG HASUNDUTAN",
        kecamatan: "BAKTIRAJA",
        vendor: "ERICSSON",
        departement_ns: "NOP PEMATANGSIANTAR",
      },
    ],
  });

  const res = resolveSiteFromTicketRow({
    site_id1_l1_assign: "",
    "Lokasi Pelanggan": "Kecamatan BAKTIRAJA Humbang Hasundutan Sumatra Utara",
  });
  assert.equal(res.ok, true);
  assert.equal(res.site_id, "DLS704");
  assert.equal(res.source, "geo_kecamatan_BAKTIRAJA");
});

test("returns ok: false and site_id: null when all fallbacks are exhausted (never NOT_IDENTIFIED)", () => {
  const resolveSiteFromTicketRow = createSiteResolver({ rows: [] });

  const res = resolveSiteFromTicketRow({
    site_id1_l1_assign: "-",
    "Lokasi Pelanggan": "medan",
  });
  assert.equal(res.ok, false);
  assert.equal(res.site_id, null);
  assert.equal(res.reason, "SITE_ID_EMPTY_AND_SITE_COVER_NOT_FOUND");
});
