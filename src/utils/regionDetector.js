// utilitas untuk mendeteksi indikasi regional tiket di luar Regional 1 (Sumbagut)
// berdasarkan prefix Site ID dan kata kunci nama kota / alamat pelanggan di Indonesia.

const SITE_PREFIX_TO_REGION = [
  // Regional 2: Jabotabek & Banten
  {
    prefixes: ["JKT", "BKS", "TGR", "BGR", "DPK", "SER", "CLG", "LEB", "PAN"],
    region: "Jabotabek & Banten (Regional 2)",
    exampleCities: ["Jakarta", "Bekasi", "Tangerang", "Bogor", "Depok", "Serang", "Cilegon"],
  },
  // Regional 3: Jawa Barat
  {
    prefixes: ["BDG", "CRB", "TSM", "SKB", "PWK", "KRG", "SUB", "IDM", "MJL", "KNG", "CMI", "GRT", "CMS", "BNR"],
    region: "Jawa Barat (Regional 3)",
    exampleCities: ["Bandung", "Cirebon", "Tasikmalaya", "Sukabumi", "Purwakarta", "Karawang", "Garut"],
  },
  // Regional 4: Jawa Tengah & DIY
  {
    prefixes: ["SMG", "SLO", "YGY", "PWT", "KDS", "PKL", "MGL", "KLT", "BYL", "SKH", "WNG", "KRN", "SRA", "GRO", "BLA", "RBG", "PAT", "JEP", "DMK", "TEM", "KND", "BAT", "PML", "TEG", "BBG", "CIL", "BMS", "PBG", "BNA", "KBM", "PWO", "WNS", "SLE", "BTL", "KLP", "GKG"],
    region: "Jawa Tengah & DIY (Regional 4)",
    exampleCities: ["Semarang", "Solo", "Yogyakarta", "Purwokerto", "Kudus", "Pekalongan", "Magelang"],
  },
  // Regional 5: Jawa Timur
  {
    prefixes: ["SBY", "MLG", "KDR", "JBR", "MDI", "BWI", "SDA", "GSK", "MJR", "PAS", "PRO", "LMG", "TBK", "BGN", "NGW", "MGT", "PON", "PAC", "TRG", "TLG", "BLT", "NJK", "LUM", "BON", "STB", "SMP", "PKS", "BKL"],
    region: "Jawa Timur (Regional 5)",
    exampleCities: ["Surabaya", "Malang", "Kediri", "Jember", "Madiun", "Banyuwangi", "Sidoarjo", "Gresik"],
  },
  // Regional 6: Bali & Nusa Tenggara
  {
    prefixes: ["DPS", "MTR", "KPG", "BLL", "JBR", "TBN", "BDG", "GYR", "KLK", "BGL", "KRA", "LOB", "LOT", "LOU", "SBW", "SBB", "DOM", "BMA", "KUP", "TTS", "TTU", "BEL", "ALR", "LEM", "FLT", "SIK", "END", "NAG", "MGR", "MGB", "MGT", "SUM", "SUB", "SUT", "SBD", "ROT", "SBR"],
    region: "Bali & Nusa Tenggara (Regional 6)",
    exampleCities: ["Denpasar", "Mataram", "Kupang", "Badung", "Lombok", "Sumbawa", "Flores", "Labuan Bajo"],
  },
  // Regional 7: Kalimantan
  {
    prefixes: ["BJM", "BPN", "SMD", "PNK", "TRK", "PLK", "STG", "KTP", "SKP", "BTI", "BRU", "KUT", "PAS", "PPU", "KUK", "BUL", "MAL", "NUN", "TNA"],
    region: "Kalimantan (Regional 7)",
    exampleCities: ["Banjarmasin", "Balikpapan", "Samarinda", "Pontianak", "Tarakan", "Palangkaraya"],
  },
  // Regional 8: Sulawesi
  {
    prefixes: ["MKS", "MND", "PLU", "KDI", "GTL", "MAM", "PRP", "PLP", "GOW", "MRG", "PIN", "SID", "ENR", "LWW", "TTR", "TNJ", "WJO", "SOP", "BRU", "PKE", "BTL", "JEN", "TAK", "BUL", "SEL", "SIN", "BNE", "BIT", "TOM", "KTG", "MIN", "MIT", "MIS", "BOL", "BOM", "BOG", "STA", "TLD", "TIR", "PAR", "POS", "TOL", "BNG", "MOR", "MOW", "BAU", "KOL", "KON", "BUT", "BUM", "MUN", "WAK", "BOM", "KOB", "KOT", "POL", "MAJ", "MAS", "MJU", "MAM"],
    region: "Sulawesi (Regional 8)",
    exampleCities: ["Makassar", "Manado", "Palu", "Kendari", "Gorontalo", "Mamuju", "Parepare", "Palopo"],
  },
  // Regional 9: Maluku & Papua
  {
    prefixes: ["AMB", "JPR", "SOQ", "TIM", "MER", "MKW", "BIA", "TTE", "TID", "NAB", "SER"],
    region: "Maluku & Papua (Regional 9)",
    exampleCities: ["Ambon", "Jayapura", "Sorong", "Timika", "Merauke", "Manokwari", "Biak", "Ternate"],
  },
  // Sumbagteng & Sumbagsel (Regional Sumatera Non-Sumbagut)
  {
    prefixes: ["PLB", "LPG", "BKL", "JMB", "PKU", "BTM", "PDG", "TPI", "DUM", "BKN", "BKT", "PYK", "SLK", "PRM", "SWL", "TBH", "RGT", "TLK", "PBL", "LLG", "PAG", "KAY", "LAI", "MRT", "BTR", "TGL", "MET", "KOT", "KLI", "GNS"],
    region: "Sumbagteng & Sumbagsel",
    exampleCities: ["Palembang", "Bandar Lampung", "Bengkulu", "Jambi", "Pekanbaru", "Batam", "Padang", "Tanjung Pinang", "Dumai", "Bukittinggi"],
  },
];

// mengekstrak prefix 3 huruf dari site ID (misal: E_JKT388MT1 -> JKT, MDN629 -> MDN)
export function extractSitePrefix(siteId) {
  if (!siteId) return "";
  const cleaned = String(siteId).trim().toUpperCase();
  // Tangani format seperti E_JKT388MT1, G_BDG123, 4G_SBY001, atau JKT388
  const m = cleaned.match(/(?:^[A-Z0-9]+_)?([A-Z]{3})\d+/i);
  if (m && m[1]) {
    return m[1].toUpperCase();
  }
  const directLetters = cleaned.replace(/^[0-9A-Z]+_/i, "").match(/^[A-Z]{3}/i);
  return directLetters ? directLetters[0].toUpperCase() : "";
}

// mendeteksi wilayah asal dugaan tiket berdasarkan site ID, alamat, atau teks kota
export function detectSuspectedRegion({ siteId = "", addressText = "", cityText = "" } = {}) {
  const prefix = extractSitePrefix(siteId);

  // 1. Cek berdasarkan Site ID Prefix
  if (prefix) {
    for (const entry of SITE_PREFIX_TO_REGION) {
      if (entry.prefixes.includes(prefix)) {
        return {
          isOutOfRegion: true,
          suspectedRegion: entry.region,
          matchedBy: `Site Prefix (${prefix})`,
          prefix,
          recommendation: `Segera update/reassign tiket di CRM ke tim ${entry.region} agar dapat ditangani tepat waktu!`,
        };
      }
    }
  }

  // 2. Cek berdasarkan kata kunci nama kota / alamat pelanggan
  const combinedText = `${cityText} ${addressText}`.toLowerCase();
  if (combinedText.trim()) {
    for (const entry of SITE_PREFIX_TO_REGION) {
      for (const cityName of entry.exampleCities) {
        const regex = new RegExp(`\\b${cityName.toLowerCase()}\\b`, "i");
        if (regex.test(combinedText)) {
          return {
            isOutOfRegion: true,
            suspectedRegion: entry.region,
            matchedBy: `Kata Kunci Alamat/Kota (${cityName})`,
            prefix: prefix || null,
            recommendation: `Segera update/reassign tiket di CRM ke tim ${entry.region} agar dapat ditangani tepat waktu!`,
          };
        }
      }
    }
  }

  return {
    isOutOfRegion: false,
    suspectedRegion: null,
    matchedBy: null,
    prefix: prefix || null,
    recommendation: "Periksa kembali detail lokasi dan site cover pada tiket CRM.",
  };
}
