// Mynt's program schedule: a plain PDF, written here without a library, that Mynt appends to the licence provider's
// agreement before it's signed. It states what Mynt fills in for the agreement (the parties, the developer's firm, the
// app, the products and states covered, the dates, the template's version and hash), so the signed copy carries them
// whatever the template's layout. Text only, standard Helvetica, US Letter, as many pages as it takes.

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const SIZE = 10;
const LEADING = 14;
const MAX_CHARS = 95;
const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);

// Latin-1 only (the standard fonts' encoding); anything else becomes "?".
const latin1 = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function wrap(text: string): string[] {
  const out: string[] = [];
  for (const para of latin1(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      for (let w = word; w.length; ) {
        const piece = w.slice(0, MAX_CHARS);
        w = w.slice(MAX_CHARS);
        if (!line) line = piece;
        else if (line.length + 1 + piece.length <= MAX_CHARS) line += ` ${piece}`;
        else {
          out.push(line);
          line = piece;
        }
      }
    }
    out.push(line);
  }
  return out;
}

export interface ScheduleSection {
  heading: string;
  lines: [label: string, value: string][];
}

export function schedulePdf(title: string, sections: ScheduleSection[], footer: string): Buffer {
  const lines: { text: string; bold: boolean }[] = [{ text: latin1(title), bold: true }, { text: "", bold: false }];
  for (const s of sections) {
    lines.push({ text: latin1(s.heading), bold: true });
    for (const [label, value] of s.lines) for (const l of wrap(`${label}: ${value}`)) lines.push({ text: l, bold: false });
    lines.push({ text: "", bold: false });
  }
  for (const l of wrap(footer)) lines.push({ text: l, bold: false });

  const pages: (typeof lines)[] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));

  // Objects: 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, then a page and its content stream per page.
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  pages.forEach((page, i) => {
    const ops = ["BT", `${LEADING} TL`, `${MARGIN} ${PAGE_H - MARGIN} Td`];
    for (const l of page) ops.push(`/${l.bold ? "F2" : "F1"} ${SIZE} Tf`, `(${escape(l.text)}) Tj`, "T*");
    ops.push("ET", "BT", `/F1 8 Tf`, `${MARGIN} ${MARGIN / 2} Td`, `(${escape(`Page ${i + 1} of ${pages.length}`)}) Tj`, "ET");
    const stream = ops.join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  });

  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
