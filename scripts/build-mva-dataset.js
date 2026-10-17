/*
 * Сборка mva_dataset_original.db из «Таблица ремонтов.xlsx».
 *
 *   node scripts/build-mva-dataset.js
 *
 * Что делает:
 *   - берёт схему (таблицы/индексы) из mba_data.db и создаёт по ней чистую БД;
 *   - читает листы «В ремонте 2026» / «в ремонте 25» / «в ремонте 2024»;
 *   - раскладывает строки по clients / equipment / orders;
 *   - телефон: первый номер -> clients.number, остальные -> clients.comments;
 *   - клиент: организации объединяются по имени, физлица без организации — по телефону;
 *   - даты приводятся к ISO YYYY-MM-DD (праздники -> дата, дата из текста вытаскивается);
 *   - все заявки закрываются статусом «Выдано».
 *
 * XLSX читается нативно (zip + XML), без внешних зависимостей.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const XLSX = path.join(ROOT, 'Таблица ремонтов.xlsx');
const SRC = path.join(ROOT, 'mba_data.db');
const DEST = path.join(ROOT, 'mva_dataset_original.db');
const COMPLETED_STATUS = 'Выдано';

// ---------------------------------------------------------------------------
// Минимальный читатель XLSX (zip + XML)
// ---------------------------------------------------------------------------
function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('XLSX: не найден EOCD');
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('XLSX: плохая запись каталога');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('XLSX: плохой локальный заголовок');
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error('XLSX: неподдерживаемый метод сжатия ' + entry.method);
}

const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&amp;/g, '&');

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(m[1]))) text += decodeXml(tm[1]);
    out.push(text);
  }
  return out;
}

function colToIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cRe = /<c([^>]*)\/>|<c([^>]*)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1] || cm[2] || '';
      const inner = cm[3] || '';
      const refM = attrs.match(/r="([A-Z]+\d+)"/);
      const tM = attrs.match(/t="([^"]+)"/);
      const type = tM ? tM[1] : 'n';
      let value = '';
      if (type === 's') {
        const vM = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (vM) value = shared[parseInt(vM[1], 10)] ?? '';
      } else if (type === 'inlineStr') {
        const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
        let tm;
        while ((tm = tRe.exec(inner))) value += decodeXml(tm[1]);
      } else {
        const vM = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (vM) value = decodeXml(vM[1]);
      }
      const idx = refM ? colToIndex(refM[1]) : cells.length;
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Преобразования значений
// ---------------------------------------------------------------------------
function clean(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  if (s === '') return '';
  if (/^-?\d+\.0+$/.test(s)) return s.replace(/\.0+$/, '');
  const m = /^(-?\d+(?:\.\d+)?)[eE]\+?(\d+)$/.exec(s);
  if (m) {
    const n = Number(s);
    return Number.isInteger(n) && Math.abs(n) < 1e15 ? String(n) : String(n);
  }
  return s;
}

const normKey = (s) => clean(s).replace(/\s+/g, ' ').toLowerCase();
const isNumeric = (s) => /^-?\d+(\.\d+)?$/.test(s);

function serialToIso(n) {
  if (!Number.isFinite(n) || n <= 20000 || n >= 80000) return null;
  const d = new Date(Math.round((n - 25569) * 86400 * 1000));
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const HOLIDAYS = [
  [/нов(ый|ого|ому)?\s*год|новогод/i, '01-01'],
  [/рождеств/i, '01-07'],
];

function flexDate(raw, sheetYear) {
  const s = clean(raw);
  if (!s) return null;
  if (isNumeric(s)) return serialToIso(Number(s));
  for (const [re, md] of HOLIDAYS) if (re.test(s)) return `${sheetYear}-${md}`;
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = s.match(/(\d{1,2})[.\/\-,]+(\d{1,2})[.\/\-,]*(\d{2,4})/);
  if (m) {
    const dd = +m[1], mm = +m[2];
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
      let year;
      if (m[3].length <= 2) year = +m[3] > 50 ? 1900 + +m[3] : 2000 + +m[3];
      else if (+m[3] >= 1980 && +m[3] <= 2100) year = +m[3];
      else if (/^0/.test(m[3])) year = sheetYear; // «0204»/«0206» — опечатка года
      if (year) return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
  }
  return null;
}

const phoneRuns = (raw) => {
  const s = clean(raw);
  return s ? (s.match(/\+?\d{7,}/g) || []) : [];
};

function parsePrice(v) {
  const m = clean(v).replace(/\s+/g, '').match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

function inferBrand(model) {
  const m = clean(model).toUpperCase();
  if (!m) return null;
  const rules = [
    [/WILO|ВИЛО|VILO|IPL|NLG|STRATOS|YONOS/, 'Wilo'],
    [/\bGRUNDFOS\b|MAGNA|\bCRE\b|\bCRN\b|\bCR\b|CR\d|CMBE|\bCME\b|\bCM\b|SCALA|\bSBA\b|\bSB\b|SB\d|\bSEV\b|SEV\d|TPE|\bUPE\b|\bUPC\b|\bUPS\b|\bUPM\b|\bUP\b|UP\d|\bSQE\b|\bSQ\b|SQ\d|\bNB\b|NB\d|\bNK\b|\bPF\b|\bMQ\b|\bJP\b|WRE|\bSEG\b|HYDRO/, 'Grundfos'],
    [/\bDAB\b|CP40|JET\b/, 'DAB'],
    [/JEMIX/, 'Jemix'],
    [/PENTAX/, 'Pentax'],
    [/UNIPUMP/, 'Unipump'],
  ];
  for (const [re, brand] of rules) if (re.test(m)) return brand;
  return null;
}

const HEADER_WORDS = new Set(['организация', 'организация 2', 'p/n', 'дата', 'тел', 'насос', 'к.л', 'столбец 1']);

// соответствие колонок листов
const SHEETS = [
  { file: 'xl/worksheets/sheet1.xml', year: 2026,
    c: { date: 1, tel: 2, contact: 3, org: 4, pn: 5, model: 6, serial: 7, kit: 8, diag: 9, price: 10, protocol: 11, ship: 12, resp: 13, wind: 14, bear: 15, ctu: 16, act: -1 } },
  { file: 'xl/worksheets/sheet2.xml', year: 2025,
    c: { date: 1, tel: 2, contact: 3, org: 4, pn: 5, model: 6, serial: 7, kit: 8, diag: 9, price: 10, protocol: 11, ship: 12, resp: 13, wind: 14, bear: 15, ctu: 16, act: -1 } },
  { file: 'xl/worksheets/sheet3.xml', year: 2024,
    c: { date: 2, tel: 3, contact: 4, org: 5, pn: 6, model: 7, serial: 8, kit: 9, diag: 10, price: 11, resp: 12, protocol: 13, ship: 14, wind: -1, bear: -1, ctu: -1, act: 0, resp2: 15 } },
];

// ---------------------------------------------------------------------------
// Сборка
// ---------------------------------------------------------------------------
function main() {
  if (!fs.existsSync(XLSX)) throw new Error('Не найден файл: ' + XLSX);
  const buf = fs.readFileSync(XLSX);
  const entries = readZipEntries(buf);
  const shared = parseSharedStrings(readEntry(buf, entries.get('xl/sharedStrings.xml')).toString('utf8'));
  const allRows = SHEETS.map((sh) => ({
    sh,
    rows: parseSheet(readEntry(buf, entries.get(sh.file)).toString('utf8'), shared),
  }));

  // организации (для объединения клиентов)
  const orgNames = new Set();
  for (const { sh, rows } of allRows) {
    for (let r = 1; r < rows.length; r++) {
      const org = clean((rows[r] || [])[sh.c.org]);
      if (org && !HEADER_WORDS.has(normKey(org))) orgNames.add(normKey(org));
    }
  }

  const records = [];
  const clients = new Map();
  for (const { sh, rows } of allRows) {
    const g = (row, idx) => (idx >= 0 && row[idx] !== undefined ? row[idx] : '');
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const dateRaw = clean(g(row, sh.c.date));
      const telRaw = clean(g(row, sh.c.tel));
      let contact = clean(g(row, sh.c.contact));
      let org = clean(g(row, sh.c.org));
      const pn = clean(g(row, sh.c.pn));
      const model = clean(g(row, sh.c.model));
      const serial = clean(g(row, sh.c.serial));
      if (![dateRaw, telRaw, contact, org, pn, model, serial, g(row, sh.c.diag), g(row, sh.c.price)].some((x) => clean(x))) continue;
      if (HEADER_WORDS.has(normKey(org))) org = '';
      if (HEADER_WORDS.has(normKey(contact))) contact = '';

      const phones = phoneRuns(telRaw);

      let key, name;
      if (org) { key = 'org:' + normKey(org); name = org; }
      else if (contact && orgNames.has(normKey(contact))) { key = 'org:' + normKey(contact); name = contact; }
      else if (phones.length) { key = 'tel:' + phones[0]; name = contact || ('Клиент ' + phones[0]); }
      else if (contact) { key = 'name:' + normKey(contact); name = contact; }
      else { key = 'none'; name = 'Без клиента'; }

      if (!clients.has(key)) clients.set(key, { name, numbers: new Set(), contacts: new Set() });
      const cl = clients.get(key);
      for (const p of phones) cl.numbers.add(p);
      if (contact && normKey(contact) !== normKey(name)) cl.contacts.add(contact);

      const parts = [];
      const add = (label, v) => { const s = clean(v); if (s) parts.push(label ? `${label}: ${s}` : s); };
      add('№ акта', g(row, sh.c.act));
      add('Комплектация', g(row, sh.c.kit));
      add('Ответственный', g(row, sh.c.resp));
      if (sh.c.resp2 !== undefined) add('Ответственный', g(row, sh.c.resp2));
      add('Обмотки', g(row, sh.c.wind));
      add('Подшипники', g(row, sh.c.bear));
      add('СТУ', g(row, sh.c.ctu));
      add('Протокол', g(row, sh.c.protocol));

      const priceRaw = clean(g(row, sh.c.price));
      const price = parsePrice(priceRaw);
      if (priceRaw && price === null) parts.push(`Оплата: ${priceRaw}`);

      const creation = flexDate(dateRaw, sh.year);
      if (dateRaw && creation === null) parts.push(`Дата: ${dateRaw}`);

      const shipRaw = clean(g(row, sh.c.ship));
      const shipping = flexDate(shipRaw, sh.year);
      if (shipRaw && !(isNumeric(shipRaw) && serialToIso(Number(shipRaw)))) parts.push(`Отгрузка: ${shipRaw}`);

      records.push({
        clientKey: key, sheetYear: sh.year, creation, shipping,
        diag: clean(g(row, sh.c.diag)) || null,
        comments: parts.length ? parts.join(' | ') : null,
        price,
        manufacturer: inferBrand(model),
        model: model || null,
        serial: serial || null,
        article: pn || null,
      });
    }
  }

  // схема
  const src = new DatabaseSync(SRC, { readOnly: true });
  const objects = src.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
    "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
  ).all();
  src.close();

  if (fs.existsSync(DEST)) fs.unlinkSync(DEST);
  const dest = new DatabaseSync(DEST);
  dest.exec('PRAGMA foreign_keys = ON');
  dest.exec('PRAGMA journal_mode = WAL');
  for (const o of objects) dest.exec(o.sql);

  const insClient = dest.prepare('INSERT INTO clients (name, number, mail, comments) VALUES (?, ?, NULL, ?)');
  const clientId = new Map();
  for (const [key, c] of clients) {
    const numbers = [...c.numbers];
    const contacts = [...c.contacts];
    const notes = [];
    if (numbers.length > 1) notes.push('Телефоны: ' + numbers.join(', '));
    if (contacts.length) notes.push('Контакт: ' + contacts.join(', '));
    const info = insClient.run(c.name, numbers[0] || null, notes.length ? notes.join(' | ') : null);
    clientId.set(key, Number(info.lastInsertRowid));
  }

  const insEquip = dest.prepare(
    'INSERT INTO equipment (client_id, manufacturer, model, serial_number, production_date, article_number) VALUES (?, ?, ?, ?, NULL, ?)'
  );
  const insOrder = dest.prepare(
    'INSERT INTO orders (client_id, equipment_id, creation_date, shipping_date, status, comments, diagnostic_results, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  dest.exec('BEGIN IMMEDIATE');
  try {
    for (const rec of records) {
      const cid = clientId.get(rec.clientKey);
      const eq = insEquip.run(cid, rec.manufacturer, rec.model, rec.serial, rec.article);
      insOrder.run(cid, Number(eq.lastInsertRowid), rec.creation, rec.shipping, COMPLETED_STATUS, rec.comments, rec.diag, rec.price);
    }
    dest.exec('COMMIT');
  } catch (e) {
    dest.exec('ROLLBACK');
    throw e;
  }

  const fk = dest.prepare('PRAGMA foreign_key_check').all();
  const counts = {};
  for (const t of ['clients', 'equipment', 'orders']) counts[t] = dest.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
  dest.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  dest.close();

  console.log('Готово:', DEST);
  console.log('Записей:', records.length, '| клиентов:', counts.clients, '| насосов:', counts.equipment, '| заявок:', counts.orders);
  console.log('foreign_key_check:', fk.length === 0 ? 'OK' : JSON.stringify(fk));
}

main();
