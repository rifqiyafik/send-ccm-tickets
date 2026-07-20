import assert from "node:assert/strict";
import test from "node:test";

import {
  createPicSearch,
  getAssignmentType,
  getCityFromTicketRow,
  normalizeAssignmentGroup,
} from "../src/services/picSearchService.js";

const searchPicFromTicketRow = createPicSearch({
  rows: [
    {
      city: "KOTA LANGSA",
      nsa: "BINJAI",
      ccm_handling: "Budi Harahap",
      pic_sqa: "Herman",
      pic_nop: "Rizlul Khairi",
      vendor: "ERICSSON",
    },
  ],
});

function searchFixtureRow(row) {
  return searchPicFromTicketRow({
    city: row["Kabupaten/Kota(Create Ticket)"],
    assignmentGroup: row["Assign to L2(L2 Assign)"],
  });
}

test("normalizes assignment group from Excel value", () => {
  assert.equal(
    normalizeAssignmentGroup("group:Service Quality Assurance Sumbagut"),
    "SERVICE QUALITY ASSURANCE SUMBAGUT"
  );

  assert.equal(
    normalizeAssignmentGroup("group:Network Operations and Productivity Banda Aceh"),
    "NETWORK OPERATIONS AND PRODUCTIVITY ACEH"
  );
});

test("detects assignment group type", () => {
  assert.equal(
    getAssignmentType("group:Service Quality Assurance Sumbagut"),
    "SQA"
  );

  assert.equal(
    getAssignmentType("group:Network Operations and Productivity Binjai"),
    "NOP"
  );

  assert.equal(getAssignmentType("group:RTP Engineering Sumbagut"), "UNKNOWN");
});

test("reads city from Kabupaten/Kota(Create Ticket) column", () => {
  const row = {
    "Kabupaten/Kota(Create Ticket)": " Kota Langsa ",
  };

  assert.equal(getCityFromTicketRow(row), "KOTA LANGSA");
});

test("returns pic_sqa when assignment group is SQA", () => {
  const row = {
    "Kabupaten/Kota(Create Ticket)": "KOTA LANGSA",
    "Assign to L2(L2 Assign)": "group:Service Quality Assurance Sumbagut",
  };

  const result = searchFixtureRow(row);

  assert.equal(result.ok, true);
  assert.equal(result.assignment_type, "SQA");
  assert.equal(result.city, "KOTA LANGSA");
  assert.equal(result.ccm_handling, "Budi Harahap");
  assert.equal(result.pic, result.pic_sqa);
  assert.equal(result.pic, "Herman");
});

test("returns pic_nop when assignment group is NOP", () => {
  const row = {
    "Kabupaten/Kota(Create Ticket)": "KOTA LANGSA",
    "Assign to L2(L2 Assign)": "group:Network Operations and Productivity Binjai",
  };

  const result = searchFixtureRow(row);

  assert.equal(result.ok, true);
  assert.equal(result.assignment_type, "NOP");
  assert.equal(result.city, "KOTA LANGSA");
  assert.equal(result.ccm_handling, "Budi Harahap");
  assert.equal(result.pic, result.pic_nop);
  assert.equal(result.pic, "Rizlul Khairi");
});

test("returns CITY_NOT_FOUND when city is not in ccm handling data", () => {
  const row = {
    "Kabupaten/Kota(Create Ticket)": "KOTA TIDAK ADA",
    "Assign to L2(L2 Assign)": "group:Service Quality Assurance Sumbagut",
  };

  const result = searchFixtureRow(row);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "CITY_NOT_FOUND");
  assert.equal(result.city, "KOTA TIDAK ADA");
});
