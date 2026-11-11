// A made-up statement in the Evoca layout (owner, 2026-11-11), built the way the bank's .NET writer builds its workbooks: every tag prefixed with x:,
// a decorative table, absolute part paths, shared strings. Names and amounts are invented; the real file is never kept in the repository.
import JSZip from "jszip";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const HEAD = ["Ամսաթիվ", "Փաստ.N", "ԳՏ", "Հաշիվ", "Նպատակ", "Մուտք", "Ելք", "Վճարող/Շահառու"];

// rows: arrays of cell strings (null = empty cell). Builds a workbook the way the .NET writer does.
export async function evocaWorkbook(rows) {
  const strings = [];
  const sid = (s) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  const colName = (i) => String.fromCharCode(65 + i);
  const sheetRows = rows
    .map((row, r) => {
      const cells = row.map((v, c) => (v === null || v === "" ? "" : `<x:c r="${colName(c)}${r + 1}" t="s"><x:v>${sid(v)}</x:v></x:c>`)).join("");
      return `<x:row r="${r + 1}">${cells}</x:row>`;
    })
    .join("");
  const NS = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '﻿<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" /><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /></Types>');
  zip.file("_rels/.rels", '﻿<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/xl/workbook.xml" Id="R1" /></Relationships>');
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="utf-8"?><x:workbook ${NS}><x:sheets><x:sheet name="AccountStatementReport" sheetId="2" r:id="rId2" /></x:sheets></x:workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", '﻿<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml" Id="rId2" /><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="/xl/sharedStrings.xml" Id="rId3" /></Relationships>');
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="utf-8"?><x:worksheet ${NS}><x:sheetData>${sheetRows}</x:sheetData><x:tableParts count="1"><x:tablePart r:id="rId5" /></x:tableParts></x:worksheet>`);
  zip.file("xl/worksheets/_rels/sheet1.xml.rels", '<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="/xl/tables/table1.xml" Id="rId5" /></Relationships>');
  zip.file("xl/tables/table1.xml", `<?xml version="1.0" encoding="utf-8"?><x:table ${NS} id="1" name="Table1" displayName="Table1" ref="A13:H14"><x:tableColumns count="1"><x:tableColumn id="1" name="A" /></x:tableColumns></x:table>`);
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="utf-8"?><x:sst ${NS}>${strings.map((s) => `<x:si><x:t>${esc(s)}</x:t></x:si>`).join("")}</x:sst>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

export const ACCOUNT = "1660000000000100";
// three days: day 1 has two payments in and a bank fee, day 2 a salary and a transfer from our other account, day 3 is quiet
export function evocaRows({ totalIn = "5,350,000.00", totalOut = "314,500.00", closing = "7,235,500.00", day1Balance = "3,544,500.00" } = {}) {
  return [
    ["Ժամանակահատվածի սկիզբ", "01/10/2026"],
    ["Ժամանակահատվածի վերջ", "03/10/2026"],
    ["Հաշիվ N", ACCOUNT, "«ՏԵՍՏ ՕՅԼ» ՍՊԸ"],
    ["Արժույթ", "AMD", "Հայկական դրամ"],
    ["ՀՎՀՀ", "00000000"],
    [],
    ["Սկզբնական մնացորդ 01/10/2026-ով", "2,200,000.00"],
    ["Ընդհանուր շարժ դեբետով", totalOut],
    ["Ընդհանուր շարժ կրեդիտով", totalIn],
    ["Վերջնական մնացորդ 03/10/2026-ով", closing],
    [],
    HEAD,
    ["01/10/2026", "100001", "TRF", "1570000000000100", "Ապրանքի գումար", "1,000,000.00", "0.00", "«ՏԵՍՏ ՀԱՃԱԽՈՐԴ» ՍՊԸ"],
    ["01/10/2026", "100002", "TRF", "1570000000000200", "Պարտքի մարում", "350,000.00", "0.00", "ՏԵՍՏ ԱՁ"],
    ["01/10/2026", "000634", "FEE", "1660000000000900", "Գանձում փոխանցումից\\Commission", "0.00", "5,500.00", ""],
    [null, null, null, null, "Շարժ 01/10/2026-ով", "1,350,000.00", "5,500.00", null],
    [null, null, null, null, "Մնացորդ 01/10/2026-ով", null, day1Balance, null],
    HEAD,
    ["02/10/2026", "100003", "TRF", "1660000000000300", "Փոխանցում հաշվին", "4,000,000.00", "0.00", "«ՏԵՍՏ ՕՅԼ» ՍՊԸ"],
    ["02/10/2026", "100004", "TRF", "1660000000000400", "աշխատավարձ", "0.00", "309,000.00", "ՏԵՍՏ ԱՇԽԱՏԱԿԻՑ"],
    [null, null, null, null, "Շարժ 02/10/2026-ով", "4,000,000.00", "309,000.00", null],
    [null, null, null, null, "Մնացորդ 02/10/2026-ով", null, "7,235,500.00", null],
    ["Օրերի քանակ", "3"],
  ];
}

