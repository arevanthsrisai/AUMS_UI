import { fetchCourseAttendancePdf } from '../browser/courseAttendance.js';
import { parseCourseAttendancePdf } from '../parsers/courseAttendancePdf.js';

/**
 * Turn a parsed course-attendance PDF into the app's canonical JSON shape.
 * Shared by the Playwright path (fetchCourseAttendancePdf) and the direct-HTTP
 * path (aumsHttp.getCourseAttendanceHttp) so both return identical payloads.
 */
export function buildCourseAttendanceResult(parsed, pdfBuffer, fallbackCourseId = '') {
  const events = parsed.records
    .filter((record, index, self) => {
      const firstIndex = self.findIndex(r => r.date === record.date && r.period === record.period && r.status === record.status);
      return firstIndex === index;
    })
    .map(record => ({ date: record.date, period: record.period, periodTo: record.periodTo, hours: record.hours, status: record.status }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.period - b.period));

  const hoursFor = (e) => e.hours || (e.periodTo - e.period + 1);
  const presentHours = events.filter(e => e.status === 'Present').reduce((s, e) => s + hoursFor(e), 0);
  const absentHours = events.filter(e => e.status === 'Absent').reduce((s, e) => s + hoursFor(e), 0);
  const odHours = events.filter(e => e.status === 'OD').reduce((s, e) => s + hoursFor(e), 0);
  const totalHours = presentHours + absentHours + odHours;
  const presentWithOd = presentHours + odHours;
  const percentage = totalHours > 0 ? Math.round((presentWithOd / totalHours) * 1000) / 10 : 0;

  return {
    success: true,
    subject: { code: parsed.courseCode || fallbackCourseId, name: parsed.courseName || '', percentage },
    stats: { total: totalHours, present: presentWithOd, absent: absentHours, od: odHours, percentage },
    events,
    rawPdfBase64: pdfBuffer.toString('base64')
  };
}

export async function getCourseAttendance(page, semesterId, courseId) {
  if (!courseId) return { success: false, error: 'Course ID is required' };

  try {
    const result = await fetchCourseAttendancePdf(page, semesterId, courseId);
    if (!result.success || !result.pdfBuffer) return { success: false, error: result.error || 'Failed to fetch course attendance PDF' };

    let parsed;
    try { parsed = await parseCourseAttendancePdf(result.pdfBuffer); }
    catch (parseError) { return { success: false, error: 'Failed to parse course attendance PDF: ' + parseError.message }; }

    return buildCourseAttendanceResult(parsed, result.pdfBuffer, courseId);
  } catch (error) {
    console.error('[COURSE-SVC] Error:', error.message);
    return { success: false, error: error.message || 'Failed to fetch course attendance' };
  }
}

export default getCourseAttendance;
