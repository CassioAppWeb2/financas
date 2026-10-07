// Exportação: CSV (Excel em português abre direto), Excel .xlsx (gerado no navegador) e PDF (impressão).

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** rows: array de arrays. Separador ";" e vírgula decimal — o padrão do Excel no Brasil. */
export function csv(rows, name) {
  const cell = (c) => typeof c === "number" ? String(c).replace(".", ",") : `"${String(c ?? "").replace(/"/g, '""')}"`;
  const text = "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n");
  download(new Blob([text], { type: "text/csv;charset=utf-8" }), name);
}

// ---------------------------------------------------------------- XLSX mínimo (zip sem compressão)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((s, x) => s + x.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

const x = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const colName = (i) => { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

/**
 * sheets: [{ name, rows: [[...]], money?: [índices de colunas em R$] }]. A 1ª linha é o cabeçalho (negrito).
 * Valores numéricos nas colunas "money" recebem formato de moeda.
 */
export function xlsx(sheets, name) {
  const files = [];
  const sheetXml = (s) => {
    const money = new Set(s.money || []);
    const widths = s.rows[0].map((_, ci) => Math.min(50, Math.max(10, ...s.rows.map((r) => String(r[ci] ?? "").length + 2))));
    const rows = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      const ref = colName(ci) + (ri + 1);
      if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${ri > 0 && money.has(ci) ? ' s="2"' : ""}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${ri === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${x(v)}</t></is></c>`;
    }).join("")}</row>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${rows}</sheetData></worksheet>`;
  };
  const safe = sheets.map((s, i) => ({ ...s, name: (s.name || `Planilha${i + 1}`).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) }));
  files.push({ name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${safe.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` });
  files.push({ name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
  files.push({ name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${safe.map((s, i) => `<sheet name="${x(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` });
  files.push({ name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${safe.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${safe.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
  files.push({ name: "xl/styles.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R$&quot; #,##0.00;[Red]-&quot;R$&quot; #,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` });
  safe.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
  download(zip(files), name);
}

/** PDF: abre a caixa de impressão do navegador (escolha "Salvar como PDF"). O CSS de impressão esconde menus e botões. */
export function pdf(title) {
  const old = document.title;
  document.title = title;
  document.body.classList.add("printing");
  const done = () => { document.body.classList.remove("printing"); document.title = old; window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  setTimeout(() => { window.print(); setTimeout(done, 1500); }, 50);
}

// ---------------------------------------------------------------- leitura de extratos (OFX / CSV)
function parseNum(s) {
  let v = String(s ?? "").trim().replace(/[R$\s]/g, "");
  if (!v) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(v)) { neg = true; v = v.slice(1, -1); }
  if (/[DC]$/i.test(v)) { neg = /D$/i.test(v); v = v.slice(0, -1); }
  if (v.includes(",") && v.lastIndexOf(",") > v.lastIndexOf(".")) v = v.replace(/\./g, "").replace(",", ".");
  else v = v.replace(/,/g, "");
  const n = Number(v);
  return neg ? -Math.abs(n) : n;
}
function parseDate(s) {
  s = String(s ?? "").trim();
  let m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  return null;
}

export function parseOFX(text) {
  const out = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  const tag = (b, t) => { const m = b.match(new RegExp(`<${t}>([^<\\r\\n]*)`, "i")); return m ? m[1].trim() : ""; };
  for (const b of blocks) {
    const valor = parseNum(tag(b, "TRNAMT"));
    const data = parseDate(tag(b, "DTPOSTED"));
    const desc = [tag(b, "MEMO"), tag(b, "NAME")].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" - ");
    out.push({ data, valor, descricao: desc, id_externo: tag(b, "FITID") ? "ofx:" + tag(b, "FITID") : "" });
  }
  return { itens: out, cartao: /<CREDITCARDMSGSRSV1>/i.test(text) };
}

function splitCsvLine(line, sep) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const nrm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function parseCSV(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("O arquivo está vazio ou não tem linhas de lançamentos.");
  const sep = [";", ",", "\t"].map((s) => [s, splitCsvLine(lines[0], s).length]).sort((a, b) => b[1] - a[1])[0][0];
  // acha a linha de cabeçalho (algumas exportações têm linhas de título antes)
  let hi = lines.findIndex((l) => { const h = splitCsvLine(l, sep).map(nrm); return h.some((c) => /^(data|date|dt)/.test(c)) && h.some((c) => /(valor|amount|value|quantia)/.test(c)); });
  if (hi < 0) throw new Error("Não encontrei as colunas de data e valor. O arquivo precisa ter um cabeçalho com “Data” e “Valor”.");
  const head = splitCsvLine(lines[hi], sep).map(nrm);
  const find = (re) => head.findIndex((c) => re.test(c));
  const iData = find(/^(data|date|dt)/);
  const iValor = find(/^(valor|amount|value|quantia)/) >= 0 ? find(/^(valor|amount|value|quantia)/) : find(/(valor|amount|value)/);
  const iDesc = find(/(descri|historico|title|titulo|memo|estabelecimento|lancamento|detalhe)/);
  const iId = find(/^(identificador|id|fitid|codigo)$/);
  const iDeb = find(/^(debito|saida)/), iCred = find(/^(credito|entrada)/);
  const itens = [];
  for (const l of lines.slice(hi + 1)) {
    const c = splitCsvLine(l, sep);
    let valor = parseNum(c[iValor]);
    if (Number.isNaN(valor) && iDeb >= 0) { const d = parseNum(c[iDeb]), cr = parseNum(c[iCred]); valor = !Number.isNaN(cr) && cr ? Math.abs(cr) : -Math.abs(d); }
    itens.push({ data: parseDate(c[iData]), valor, descricao: iDesc >= 0 ? c[iDesc] : "", id_externo: iId >= 0 && c[iId] ? "csv:" + c[iId] : "" });
  }
  return { itens, cartao: head.includes("title") && head.includes("amount") };
}
