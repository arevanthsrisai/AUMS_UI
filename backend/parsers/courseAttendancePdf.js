/**
 * Parse course-wise daily attendance data from an AUMS PDF buffer or text.
 *
 * The AUMS PDF renders a table whose cells get concatenated during plain-text
 * extraction (pdf-parse joins every item at the exact same y coordinate into
 * one line). That flattens the visual table rows, so continuation cells for a
 * date get merged onto the wrong record.
 *
 * Instead, this parser reads the *positioned* text items exposed by pdf.js
 * (x/y coordinates). Each visual table row has its own y, so rows are grouped
 * by y and read left-to-right by x:
 *
 *   y=903.5  x=50.5:08/07/2026  x=132.3:23CSE201  x=201.3:70251176
 *            x=267.9:Period 1   x=332.9:Period 1   x=407.6:1.0  x=455.6:0.0
 *
 * Columns are consistent across reports:
 *   date x~50, course code x~132, emp no x~201 (ignored),
 *   period from x~267, period to x~332, total hours x~407, status x~455.
 *
 * Rowspan cells (date/code/emp) only appear on the first row of a multi-period
 * day; following rows inherit the date from the previous row.
 */

const STATUS_MAP = {
  '0': 'Absent',
  '0.0': 'Absent',
  '1': 'Present',
  '1.0': 'Present',
  '2': 'OD',
  '2.0': 'OD'
};

const DATE_REGEX = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;
const PERIOD_REGEX = /Period\s*(\d+)\s*Period\s*(\d+)\s*(\d+\.\d+)/g;
const STANDALONE_STATUS_REGEX = /^([0-2](?:\.[05])?)$/;
// Full-number matcher for a trailing status/hours value (handles 3.0, 4.0, ...).
const TRAILING_NUMBER_REGEX = /(\d+(?:\.\d+)?)\s*$/;

// Positioned-text column thresholds (shared by every AUMS report inspected).
const COLUMN_X = {
  date: 80,
  code: 165,
  empNo: 235,
  periodFrom: 310,
  periodTo: 375,
  hours: 430,
  status: 480
};

function normalizeStatus(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const trimmed = String(raw).trim();
  if (STATUS_MAP[trimmed] !== undefined) return STATUS_MAP[trimmed];
  // Any other numeric attendance value: 0 -> Absent, 2 -> OD, positive -> Present.
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    if (numeric === 0) return 'Absent';
    if (numeric === 2) return 'OD';
    if (numeric > 0) return 'Present';
  }
  return null;
}

function formatISODate(dd, mm, yyyy) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${yyyy}-${pad(mm)}-${pad(dd)}`;
}

function extractField(text, label) {
  const escaped = label.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}\\s*:?\\s*([^\\n]+)`));
  return match ? match[1].trim() : '';
}

function parseStatusValue(str) {
  if (str === null || str === undefined) return null;
  const m = String(str).trim().match(/^(\d+(?:\.\d+)?)$/);
  return m ? m[1] : null;
}

function itemAtX(items, threshold) {
  let best = null;
  for (const item of items) {
    if (item.x <= threshold) {
      if (best === null || item.x > best.x) best = item;
    }
  }
  return best;
}

function classifyItemsByColumn(items) {
  const cols = {
    date: null,
    code: null,
    empNo: null,
    periodFrom: null,
    periodTo: null,
    hours: null,
    status: null,
    other: []
  };
  for (const item of items) {
    const x = item.x;
    if (x <= COLUMN_X.date) cols.date = item;
    else if (x <= COLUMN_X.code) cols.code = item;
    else if (x <= COLUMN_X.empNo) cols.empNo = item;
    else if (x <= COLUMN_X.periodFrom) cols.periodFrom = item;
    else if (x <= COLUMN_X.periodTo) cols.periodTo = item;
    else if (x <= COLUMN_X.hours) cols.hours = item;
    else if (x <= COLUMN_X.status) cols.status = item;
    else cols.other.push(item);
  }
  return cols;
}

/**
 * Parse attendance PDF text into structured records.
 *
 * Kept as a plain-text fallback for callers that only have extracted text.
 * Prefer parseCourseAttendancePdf() (positioned-text based) for accuracy.
 * @param {string} text - Raw text extracted from the PDF
 * @returns {object} - { courseCode, courseName, attendanceType, records: [{ date, period, periodTo, hours, status, rawStatus }] }
 */
export function parseCourseAttendanceText(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('No PDF text provided');
  }

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const courseCode = extractField(text, 'Course Code');
  const courseName = extractField(text, 'Course Name').replace(/^:/, '').trim();
  const attendanceType = extractField(text, 'Attendance Type').replace(/^:/, '').trim();

  const records = [];
  let currentDate = null;
  let pendingStatus = null;

  for (const line of lines) {
    // Skip header/footer lines
    if (/Attendance Date|Page \d+ of \d+|Attendance Report|Amrita School/.test(line)) continue;

    // 1. Update current date + capture status that precedes it on the same line.
    const dateMatch = line.match(DATE_REGEX);
    if (dateMatch) {
      const [, dd, mm, yyyy] = dateMatch;
      currentDate = formatISODate(dd, mm, yyyy);

      const beforeDate = line.slice(0, dateMatch.index);
      const statusBeforeDate = beforeDate.match(TRAILING_NUMBER_REGEX);
      if (statusBeforeDate) {
        pendingStatus = normalizeStatus(statusBeforeDate[1]);
      }
    }

    // 2. Capture a standalone status line (rowspan rows where the status cell
    //    is extracted on its own line, e.g. "2.0" then a date-only line).
    const standaloneStatus = line.match(STANDALONE_STATUS_REGEX);
    if (standaloneStatus && !dateMatch && !PERIOD_REGEX.test(line)) {
      pendingStatus = normalizeStatus(standaloneStatus[1]);
      continue;
    }

    // 3. Extract period records from this line.
    PERIOD_REGEX.lastIndex = 0;
    let periodMatch;
    while ((periodMatch = PERIOD_REGEX.exec(line)) !== null) {
      const [, fromRaw, toRaw, hoursRaw] = periodMatch;

      let status = pendingStatus;
      const beforePeriod = line.slice(0, periodMatch.index);
      const statusBeforePeriod = beforePeriod.match(TRAILING_NUMBER_REGEX);
      if (statusBeforePeriod) {
        status = normalizeStatus(statusBeforePeriod[1]);
      }

      const hours = parseFloat(hoursRaw) || 0;

      // Infer status when the PDF didn't provide one for this row.
      if (!status) {
        status = hours > 0 ? 'Present' : 'Absent';
      }

      records.push({
        date: currentDate,
        period: parseInt(fromRaw, 10),
        periodTo: parseInt(toRaw, 10),
        hours,
        status,
        rawStatus: status
      });

      pendingStatus = null;
    }
  }

  return {
    courseCode,
    courseName,
    attendanceType,
    records
  };
}

/**
 * Parse a PDF buffer using positioned text items (accurate for AUMS tables).
 * @param {Buffer} buffer - PDF file contents
 * @returns {Promise<object>} - Structured attendance data
 */
export async function parseCourseAttendancePdf(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('Empty PDF buffer');
  }

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const PDFJS = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
  PDFJS.disableWorker = true;

  const doc = await PDFJS.getDocument({ data: new Uint8Array(buffer) }).promise;

  let text = '';
  let courseCode = '';
  let courseName = '';
  let attendanceType = '';
  const records = [];

  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const textContent = await page.getTextContent();

      // Collect positioned items, sorted top-to-bottom then left-to-right.
      const items = [];
      for (const item of textContent.items) {
        if (!item.str) continue;
        items.push({
          y: item.transform[5],
          x: item.transform[4],
          str: item.str
        });
      }
      items.sort((a, b) => b.y - a.y || a.x - b.x);

      // Group items into visual rows using a y tolerance (rows are ~30pt apart,
      // rowspan cells drift by <1pt, emp/status cells by <6pt).
      const rows = [];
      for (const item of items) {
        const last = rows[rows.length - 1];
        if (last && Math.abs(last.y - item.y) <= 4) {
          last.items.push(item);
        } else {
          rows.push({ y: item.y, items: [item] });
        }
      }

      let pageText = '';
      let currentDate = null;

      for (const row of rows) {
        const rowText = row.items.map(i => i.str).join(' ').trim();
        pageText += rowText + '\n';

        // Capture header fields (first page) from the positioned row items.
        if (p === 1) {
          if (!courseCode) {
            const codeItem = row.items.find(i => /^Course Code/.test(i.str.trim()));
            if (codeItem) {
              const codeVal = row.items.filter(i => i.x > codeItem.x).sort((a, b) => a.x - b.x)[0];
              courseCode = codeVal ? codeVal.str.trim() : '';
            }
          }
          if (!courseName) {
            const nameIdx = row.items.findIndex(i => /^Course Name/.test(i.str.trim()));
            if (nameIdx !== -1) {
              courseName = row.items.slice(nameIdx + 1).map(i => i.str.trim()).join(' ').replace(/^:/, '').trim();
            }
          }
          if (!attendanceType) {
            const atIdx = row.items.findIndex(i => /^Attendance Type/.test(i.str.trim()));
            if (atIdx !== -1) {
              attendanceType = row.items.slice(atIdx + 1).map(i => i.str.trim()).join(' ').replace(/^:/, '').trim();
            }
          }
        }

        // Date column (rowspan: only first row of a day carries the date).
        const dateItem = itemAtX(row.items, COLUMN_X.date);
        const dateMatch = dateItem ? dateItem.str.trim().match(DATE_REGEX) : null;
        if (dateMatch) {
          const [, dd, mm, yyyy] = dateMatch;
          currentDate = formatISODate(dd, mm, yyyy);
        }

        // Only rows with a "Period N" token are attendance records.
        const periodFrom = row.items.find(i => /^Period\s*\d+$/.test(i.str.trim()));
        if (!periodFrom) continue;

        const cols = classifyItemsByColumn(row.items);
        const fromMatch = cols.periodFrom && cols.periodFrom.str.trim().match(/^Period\s*(\d+)$/);
        const toMatch = cols.periodTo && cols.periodTo.str.trim().match(/^Period\s*(\d+)$/);
        if (!fromMatch) continue;

        const hoursStr = parseStatusValue(cols.hours ? cols.hours.str : null);
        const statusStr = parseStatusValue(cols.status ? cols.status.str : null);
        const hours = hoursStr !== null ? parseFloat(hoursStr) : 0;
        const status = normalizeStatus(statusStr) || (hours > 0 ? 'Present' : 'Absent');

        if (!currentDate) continue;

        records.push({
          date: currentDate,
          period: parseInt(fromMatch[1], 10),
          periodTo: toMatch ? parseInt(toMatch[1], 10) : parseInt(fromMatch[1], 10),
          hours,
          status,
          rawStatus: status
        });
      }

      text += pageText;
    }
  } finally {
    doc.destroy();
  }

  return {
    courseCode,
    courseName,
    attendanceType,
    records
  };
}

export default parseCourseAttendancePdf;
