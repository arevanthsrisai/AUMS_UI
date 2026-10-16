import * as cheerio from 'cheerio';

/**
 * Parse the AUMS "View Published Marks" screen (ViewPublishedMark.jsp).
 *
 * The page carries a semester dropdown (htmlPageTopContainer_selectStep) and,
 * inside <div id="marks">, a matrix table:
 *
 *   Row 0 (header): Exam Name | Academic Period | Exam Type | <course codes…>
 *   Row N (body):   <exam name> | <period> | <exam type> | <one cell per course>
 *
 * A course cell is a numeric mark ("15.0"), "NP" (not published), or blank
 * (component not applicable / not yet entered).
 *
 * @param {string} html
 * @returns {{ success: boolean, error?: string, semester?: string,
 *             semesters?: Array<{id: string, name: string}>,
 *             courses?: string[],
 *             exams?: Array<{ name: string, period: string, type: string,
 *                             marks: Record<string, number | 'NP' | null> }> }}
 */
export function parseMarksPage(html) {
  const $ = cheerio.load(html);
  const clean = (v) => String(v ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  // Semester dropdown (id AND name are htmlPageTopContainer_selectStep on the
  // live portal).
  const semesters = [];
  $('select[id="htmlPageTopContainer_selectStep"] option, select[name="htmlPageTopContainer_selectStep"] option').each((_, el) => {
    const id = ($(el).attr('value') || '').trim();
    const name = clean($(el).text());
    if (id && id !== '0' && name) semesters.push({ id, name });
  });
  const selected = clean($('select option:selected').first().text());

  const table = $('#marks table').first();
  if (!table.length) {
    return { success: false, error: 'Marks table not found', semester: selected, semesters };
  }

  const rows = table.find('tr').toArray();
  if (!rows.length) return { success: false, error: 'Marks table is empty', semester: selected, semesters };

  // Header row: first three columns are fixed labels, the rest are course codes.
  const headerCells = $(rows[0]).find('td').toArray().map((td) => clean($(td).text()));
  const courses = headerCells.slice(3).filter(Boolean);
  if (!courses.length) return { success: false, error: 'No courses found in marks table', semester: selected, semesters };

  const exams = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = $(rows[r]).find('td').toArray().map((td) => clean($(td).text()));
    if (cells.length < 4) continue; // layout / spacer rows
    const name = cells[0];
    if (!name) continue;
    const marks = {};
    courses.forEach((code, i) => {
      const raw = cells[i + 3] ?? '';
      if (!raw) { marks[code] = null; return; }
      if (/^NP$/i.test(raw)) { marks[code] = 'NP'; return; }
      const num = Number.parseFloat(raw);
      marks[code] = Number.isFinite(num) ? num : null;
    });
    exams.push({ name, period: cells[1] || '', type: cells[2] || '', marks });
  }

  if (!exams.length) return { success: false, error: 'Marks table has no exam rows', semester: selected, semesters };

  return { success: true, semester: selected, semesters, courses, exams };
}

export default parseMarksPage;
