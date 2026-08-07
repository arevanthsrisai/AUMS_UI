import { fetchAttendancePage } from '../browser/attendance.js';
import { fetchAttendanceSemesters } from '../browser/attendance_semesters.js';
import { fetchAttendanceReport } from '../browser/attendance_report.js';
import { parseAttendance } from '../parsers/attendanceParser.js';

export async function getAttendanceSemesters(page) {
  try {
    const result = await fetchAttendanceSemesters(page);
    if (result.success) return { success: true, semesters: result.semesters };
    return { success: false, error: result.error || 'Failed to fetch attendance semesters' };
  } catch (error) {
    return { success: false, error: error.message || 'Failed to fetch attendance semesters' };
  }
}

export async function getAttendanceReport(page, semesterId) {
  try {
    const result = await fetchAttendanceReport(page, semesterId);
    if (!result.success) return { success: false, error: result.error || 'Failed to fetch attendance report' };
    const data = parseAttendance(result.html, result.courseLookup);
    if (data.subjects.length === 0) return { success: false, error: 'Attendance table not found or empty' };
    return { success: true, semester: data.semester, subjects: data.subjects };
  } catch (error) {
    return { success: false, error: error.message || 'Failed to fetch attendance report' };
  }
}

export async function fetchAttendance(page, semesterId = null) {
  try {
    if (!semesterId) {
      const semResult = await getAttendanceSemesters(page);
      if (semResult.success && semResult.semesters.length > 0) {
        semesterId = semResult.semesters.reduce((max, s) => parseInt(s.id) > parseInt(max.id) ? s : max).id;
      }
    }
    const { html, courseLookup } = await fetchAttendancePage(page, semesterId);
    const data = parseAttendance(html, courseLookup);
    const subjectsWithIds = data.subjects.map(subject => ({ ...subject, courseId: subject.code }));
    if (subjectsWithIds.length === 0) return { success: false, error: 'Attendance table not found' };
    return { success: true, semester: data.semester, subjects: subjectsWithIds };
  } catch (error) {
    console.error('Attendance fetch error:', error.message);
    return { success: false, error: 'Unable to fetch attendance' };
  }
}

export default fetchAttendance;
