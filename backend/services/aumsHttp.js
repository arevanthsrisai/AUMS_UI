import * as cheerio from 'cheerio';
import { parseAttendance } from '../parsers/attendanceParser.js';
import { parseCourseAttendancePdf } from '../parsers/courseAttendancePdf.js';
import { buildCourseAttendanceResult } from './courseAttendanceService.js';
import { parseGPAPage } from '../browser/gpa.js';
import { parseMarksPage } from '../parsers/marksParser.js';

/**
 * Direct-HTTP AUMS data clients (no Playwright).
 *
 * Ported from the proven AUMS-NATIVE axios+cheerio flow and adapted to return
 * EXACTLY the shapes the existing browser-backed services return, so the
 * Express routes, caches, and frontend stay untouched.
 *
 * Auth for every call is the per-session cookie jar on the AuthenticatedHttpClient
 * handed in — complete per-user session isolation.
 */

// Overridable so contract tests can point the whole HTTP flow at a local stub
// AUMS server; production always uses the real portal.
const AUMS_ORIGIN = (process.env.AUMS_ORIGIN || 'https://aumscn.amrita.edu').replace(/\/+$/, '');
const ATTENDANCE_URL = `${AUMS_ORIGIN}/aums/Jsp/Attendance/AttendanceReportStudent.jsp`;
const ATTENDANCE_INIT_URL = `${ATTENDANCE_URL}?action=UMS-ATD_INIT_ATDREPORTSTUD_SCREEN&isMenu=true`;
const ATTENDANCE_SUMMARY_URL = `${ATTENDANCE_URL}?action=UMS-ATD_SHOW_ATDSUMMARY_SCREEN&isMenu=true&pagePostSerialID=1`;
const ATTENDANCE_CHANGESEM_URL = `${ATTENDANCE_URL}?action=UMS-ATD_CHANGESEM_ATDREPORTSTUD_SCREEN&isMenu=true&pagePostSerialID=1`;
const ATTENDANCE_COURSE_REPORT_URL = `${ATTENDANCE_URL}?action=UMS-ATD_SHOW_ATDREPORTSTUD_SCREEN&isMenu=true&pagePostSerialID=2`;

// NOTE: the portal menu points at StudentGrade/, not Student/ — the Student/
// path answers with a JBoss 404 (verified live against the real portal).
const GPA_URL = `${AUMS_ORIGIN}/aums/Jsp/StudentGrade/StudentPerformanceWithSurvey.jsp`;
const GPA_INIT_URL = `${GPA_URL}?action=UMS-EVAL_STUDPERFORMSURVEY_INIT_SCREEN&isMenu=true`;
const GPA_CHANGESEM_URL = `${GPA_URL}?action=UMS-EVAL_STUDPERFORMSURVEY_CHANGESEM_SCREEN&isMenu=true`;

// Marks (published exam marks matrix) — pre-rendered-semester pattern like GPA.
const MARKS_URL = `${AUMS_ORIGIN}/aums/Jsp/Marks/ViewPublishedMark.jsp`;
const MARKS_INIT_URL = `${MARKS_URL}?action=UMS-EVAL_STUDMARKVIEW_INIT_SCREEN&isMenu=true`;
const MARKS_SELSEM_URL = `${MARKS_URL}?action=UMS-EVAL_STUDMARKVIEW_SELSEM_SCREEN&isMenu=true&pagePostSerialID=1`;

const PROFILE_URL = `${AUMS_ORIGIN}/aums/Jsp/Student/Student.jsp?action=UMS-SRM_INIT_STUDENTPROFILE_SCREEN&isMenu=true`;
const PROFILE_REFERER = `${AUMS_ORIGIN}/aums/Jsp/Core_Common/index.jsp?task=off`;

function isLoginBody(body) {
  return typeof body === 'string' &&
    /<title[^>]*>\s*CAS\s*Login|name=["'](?:username|password)["']/i.test(body);
}

function sessionExpiredError() {
  const err = new Error('AUMS session expired');
  err.code = 'SESSION_EXPIRED';
  return err;
}

function ensureNotLogin(body) {
  if (isLoginBody(body)) throw sessionExpiredError();
}

/**
 * Build an application/x-www-form-urlencoded payload from the page's own form
 * controls (hidden state fields like pagePostSerialID included), with overrides
 * applied last — the same generic formBody the reference implementation uses.
 */
function formControls(html, overrides = {}) {
  const $ = cheerio.load(html);
  const values = new URLSearchParams();
  let form = $('form').first();
  if (!form.length || form.find('input[name], select[name], textarea[name]').length === 0) {
    form = $.root(); // some AUMS screens render controls outside a <form>
  }

  form.find('input[name], select[name], textarea[name]').each((_, element) => {
    const control = $(element);
    const name = control.attr('name');
    if (!name || control.is(':disabled')) return;
    if (control.is('input')) {
      const type = (control.attr('type') || 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'file' || type === 'image') return;
      if ((type === 'checkbox' || type === 'radio') && !control.is(':checked')) return;
      values.append(name, control.attr('value') ?? '');
      return;
    }
    if (control.is('select')) {
      control.find('option:selected').each((_, option) => values.append(name, $(option).attr('value') ?? $(option).text()));
      return;
    }
    values.append(name, control.val()?.toString() ?? '');
  });

  for (const [name, value] of Object.entries(overrides)) values.set(name, value);
  return Object.fromEntries(values);
}

/** { code -> courseId } lookup from a page's course dropdown (option text "CODE: Name"). */
function courseLookupFromHtml(html) {
  const $ = cheerio.load(html);
  const lookup = {};
  $('#htmlPageTopContainer_selectCourse option').each((_, el) => {
    const value = ($(el).attr('value') || '').trim();
    if (!value || value === '0') return;
    const code = $(el).text().trim().split(':')[0].trim();
    if (code) lookup[code] = value;
  });
  return lookup;
}

// --- Attendance semesters -----------------------------------------------------

export async function getAttendanceSemestersHttp(client) {
  const res = await client.get(ATTENDANCE_INIT_URL);
  ensureNotLogin(res.body);
  const $ = cheerio.load(res.body);
  const semesters = [];
  $('#htmlPageTopContainer_selectSem option').each((_, el) => {
    const val = ($(el).attr('value') || '').trim();
    if (val && val !== '0') semesters.push({ id: val, name: $(el).text().trim() });
  });
  if (semesters.length === 0) return { success: false, error: 'No semesters available in dropdown' };
  return { success: true, semesters };
}

// --- Attendance report (summary table) ---------------------------------------

export async function getAttendanceReportHttp(client, semesterId) {
  const init = await client.get(ATTENDANCE_INIT_URL);
  ensureNotLogin(init.body);

  const summary = await client.post(
    ATTENDANCE_SUMMARY_URL,
    formControls(init.body, {
      htmlPageTopContainer_selectSem: String(semesterId),
      htmlPageTopContainer_submitSummary: 'Attendance Summary ',
      htmlPageTopContainer_action: 'UMS-ATD_SHOW_ATDSUMMARY_SCREEN'
    }),
    { headers: { Referer: ATTENDANCE_INIT_URL } }
  );
  ensureNotLogin(summary.body);

  // Merge the course dropdown from both the pre- and post-summary page.
  //
  // CRITICAL: on the live portal these pages carry the dropdown for the
  // DEFAULT-selected semester, NOT the one just requested — the per-semester
  // list only appears on the CHANGESEM response. So a lookup built from
  // init+summary alone looks non-empty yet contains the wrong semester's
  // course codes, and every requested subject fails to match (courseId gets
  // stripped → the calendar has nothing to drill into). Detect that case by
  // parsing first, then fetch the correct dropdown with one cheap POST and
  // re-parse. Semesters whose codes already match (e.g. the default one) skip
  // the extra round-trip.
  const baseLookup = { ...courseLookupFromHtml(init.body), ...courseLookupFromHtml(summary.body) };
  let data = parseAttendance(summary.body, baseLookup);

  if (data.subjects.length > 0 && data.subjects.some((s) => !s.courseId)) {
    const changed = await client.post(
      ATTENDANCE_CHANGESEM_URL,
      formControls(init.body, {
        htmlPageTopContainer_selectSem: String(semesterId),
        htmlPageTopContainer_action: 'UMS-ATD_CHANGESEM_ATDREPORTSTUD_SCREEN'
      }),
      { headers: { Referer: ATTENDANCE_INIT_URL } }
    );
    ensureNotLogin(changed.body);
    const semesterLookup = courseLookupFromHtml(changed.body);
    data = parseAttendance(summary.body, { ...baseLookup, ...semesterLookup });
  }

  if (data.subjects.length === 0) return { success: false, error: 'Attendance table not found or empty' };
  return { success: true, semester: data.semester, subjects: data.subjects };
}

// --- Course attendance (PDF -> JSON events) ----------------------------------

export async function getCourseAttendanceHttp(client, semesterId, courseId) {
  if (!courseId) return { success: false, error: 'Course ID is required' };

  const init = await client.get(ATTENDANCE_INIT_URL);
  ensureNotLogin(init.body);

  const changed = await client.post(
    ATTENDANCE_CHANGESEM_URL,
    formControls(init.body, {
      htmlPageTopContainer_selectSem: String(semesterId),
      htmlPageTopContainer_action: 'UMS-ATD_CHANGESEM_ATDREPORTSTUD_SCREEN'
    }),
    { headers: { Referer: ATTENDANCE_INIT_URL } }
  );
  ensureNotLogin(changed.body);

  const $ = cheerio.load(changed.body);
  // Callers may pass the numeric course id OR the human course code (the
  // frontend falls back to the code when a stale cached report has no id).
  // Accept either: match the option's value first, then its "CODE: Name" label.
  const wanted = String(courseId).trim();
  const courseOptions = $('#htmlPageTopContainer_selectCourse option').filter((_, el) => {
    const v = ($(el).attr('value') || '').trim();
    return v && v !== '0';
  });
  const courseOption = courseOptions.filter((_, el) => {
    const value = ($(el).attr('value') || '').trim();
    const code = $(el).text().trim().split(':')[0].trim();
    return value === wanted || code.toUpperCase() === wanted.toUpperCase();
  }).first();
  if (!courseOption.length) {
    const availableCourseIds = [];
    courseOptions.each((_, el) => availableCourseIds.push(($(el).attr('value') || '').trim()));
    return { success: false, error: `Course ${courseId} is not available for semester ${semesterId}`, availableCourseIds };
  }
  // Always submit the numeric id AUMS expects, never the code.
  const resolvedCourseId = (courseOption.attr('value') || '').trim();

  const typeValue = $('#htmlPageTopContainer_selectType option')
    .filter((_, el) => { const v = ($(el).attr('value') || '').trim(); return v && v !== '0'; })
    .first().attr('value') || '';
  if (!typeValue) return { success: false, error: 'Attendance type not selected in AUMS form' };

  const report = await client.post(
    ATTENDANCE_COURSE_REPORT_URL,
    formControls(changed.body, {
      htmlPageTopContainer_selectSem: String(semesterId),
      htmlPageTopContainer_selectCourse: resolvedCourseId,
      htmlPageTopContainer_selectType: String(typeValue),
      htmlPageTopContainer_action: 'UMS-ATD_SHOW_ATDREPORTSTUD_SCREEN'
    }),
    { headers: { Referer: ATTENDANCE_INIT_URL } }
  );

  const pdf = report.buffer;
  if (!pdf || pdf.length === 0 || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') {
    ensureNotLogin(report.body);
    return { success: false, error: 'AUMS did not return a course attendance PDF' };
  }
  if (pdf.length > 5_000_000) return { success: false, error: 'AUMS course attendance report exceeded the size limit' };

  let parsed;
  try {
    parsed = await parseCourseAttendancePdf(pdf);
  } catch (parseError) {
    return { success: false, error: 'Failed to parse course attendance PDF: ' + parseError.message };
  }
  // Report the resolved numeric id back, so callers that sent a course code
  // (stale cache fallback) end up with the canonical id for future requests.
  return buildCourseAttendanceResult(parsed, pdf, resolvedCourseId);
}

// --- GPA ----------------------------------------------------------------------

export async function getGpaHttp(client, semester = 1) {
  const init = await client.get(GPA_INIT_URL);
  ensureNotLogin(init.body);

  const parsedInit = parseGPAPage(init.body);
  const $ = cheerio.load(init.body);
  const selectedText = ($('#htmlPageTopContainer_selectStep option:selected').text() || '').trim();

  // AUMS pre-rendered the requested semester — no CHANGESEM round-trip needed.
  if (parsedInit.success && selectedText === String(semester)) return parsedInit;

  const option = $('#htmlPageTopContainer_selectStep option')
    .filter((_, el) => ($(el).text() || '').trim() === String(semester))
    .first();
  const value = option.attr('value');
  if (!value) {
    if (parsedInit.success) return parsedInit;
    return { success: false, error: parsedInit.error || `Semester ${semester} not available` };
  }

  const changed = await client.post(
    GPA_CHANGESEM_URL,
    { htmlPageTopContainer_selectStep: value, Page_refIndex_hidden: '1' },
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: GPA_INIT_URL } }
  );
  ensureNotLogin(changed.body);
  return parseGPAPage(changed.body);
}

// --- Profile ------------------------------------------------------------------

// --- Marks (published exam marks) -------------------------------------------

export async function getMarksHttp(client, semester) {
  const init = await client.get(MARKS_INIT_URL);
  ensureNotLogin(init.body);

  const parsedInit = parseMarksPage(init.body);
  const requested = semester ? String(semester).trim() : '';

  // Fast path: AUMS already rendered a REAL table for the asked-for semester
  // (verified live, the INIT page usually ships "Select" selected + an empty
  // table, which fails parseMarksPage and falls through to the POST below).
  if (parsedInit.success && (!requested || parsedInit.semester === requested)) return parsedInit;

  const $ = cheerio.load(init.body);
  const options = [];
  $('select[id="htmlPageTopContainer_selectStep"] option, select[name="htmlPageTopContainer_selectStep"] option').each((_, el) => {
    const value = ($(el).attr('value') || '').trim();
    const text = ($(el).text() || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (value && value !== '0' && text) options.push({ value, text }); // skip the "Select" placeholder
  });

  // Explicit semester → its option; no explicit ask (or a semester the
  // student doesn't have yet) → the first available one, so the UI always
  // gets a real table plus an honest `semester` label instead of a dead end.
  const target = (requested ? options.find((o) => o.text === requested) : null) || options[0];
  if (!target) {
    // No semester options at all — fall back to whatever AUMS rendered rather
    // than failing outright; the response keeps its own semester label so the
    // UI can tell the user what is actually shown.
    return parsedInit.success
      ? parsedInit
      : { success: false, error: parsedInit.error || 'No semesters available on the marks screen' };
  }

  const changed = await client.post(
    MARKS_SELSEM_URL,
    formControls(init.body, { htmlPageTopContainer_selectStep: target.value }),
    { headers: { Referer: MARKS_INIT_URL } }
  );
  ensureNotLogin(changed.body);
  return parseMarksPage(changed.body);
}

export async function getProfileHttp(client) {
  const res = await client.get(PROFILE_URL, { headers: { Referer: PROFILE_REFERER } });
  ensureNotLogin(res.body);

  const $ = cheerio.load(res.body);
  const out = { name: '', rollNumber: '', registrationNumber: '', programme: '', branch: '', semester: '', batch: '', section: '', campus: '', email: '', phone: '', mentor: '', photo: '' };
  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const assign = (key, value) => { const v = clean(value); if (v && v.toLowerCase() !== 'select' && !out[key]) out[key] = v; };
  const splitProgramme = (v) => { const t = clean(v); const m = t.match(/^([A-Za-z.\s]+?)\s*(\d{4})?$/); return { name: (m && m[1] ? m[1] : t).trim(), year: m && m[2] ? m[2] : '' }; };

  // Same walk the browser extractor performs: orphan-label pairs give the
  // display values first, then form controls fill any gaps.
  const labels = [];
  $('fieldset[id^="fieldset-orphan-label-"] label').each((_, el) => {
    labels.push(clean($(el).text().replace(/\u00a0/g, ' ')));
  });
  for (let i = 0; i < labels.length - 1; i++) {
    const label = labels[i].toLowerCase();
    const value = labels[i + 1];
    if (/first name/.test(label)) assign('name', value);
    if (/academic program/.test(label)) { const p = splitProgramme(value); assign('programme', p.name); if (p.year) assign('batch', p.year); }
    if (/branch/.test(label)) assign('branch', value);
  }

  assign('name', $('input[name="htmlPageTopContainer_addst_txteditfirstName"]').val());
  assign('rollNumber', $('input[name="htmlPageTopContainer_addst_txteditapplicationNo"]').val());
  assign('registrationNumber', $('input[name="htmlPageTopContainer_addst_txteditadmissionNo"]').val());
  assign('programme', $('select[name="htmlPageTopContainer_addst_selectProgram"] option:selected').val());
  assign('branch', $('select[name="htmlPageTopContainer_addst_selectBranch"] option:selected').val());
  assign('batch', $('select[name="htmlPageTopContainer_addst_selectYear"] option:selected').val());
  assign('email', $('input[name="htmlPageTopContainer_addst_txtPersonalEmail"]').val());
  assign('phone', $('input[name="htmlPageTopContainer_addst_txtPersonalPhone"]').val());

  // Student photo — same servlet the browser path fetches.
  const encoded = $('input[name="htmlPageTopContainer_encodedenrollmentId"]').val() || '';
  if (encoded) {
    try {
      const photoRes = await client.get(
        `${AUMS_ORIGIN}/aums/FileUploadServlet?action=SHOW_STUDENT_PHOTO&encodedenrollmentId=${encodeURIComponent(encoded)}&flag=photo`,
        { headers: { Referer: PROFILE_URL } }
      );
      const contentType = photoRes.headers['content-type'] || '';
      if (photoRes.status === 200 && photoRes.buffer && photoRes.buffer.length > 0 && !/text\/html/i.test(contentType)) {
        const normalized = /jpe?g/i.test(contentType) ? 'image/jpeg' : (contentType || 'image/jpeg');
        out.photo = 'data:' + normalized + ';base64,' + photoRes.buffer.toString('base64');
      }
    } catch { /* photo is best-effort */ }
  }

  return { success: true, ...out };
}

export default {
  getAttendanceSemestersHttp,
  getAttendanceReportHttp,
  getCourseAttendanceHttp,
  getGpaHttp,
  getMarksHttp,
  getProfileHttp
};
