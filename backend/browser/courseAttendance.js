import path from 'path';
import fs from 'fs';
import { getAttendanceFrame } from './attendance.js';

const ATTENDANCE_PAGE = 'AttendanceReportStudent.jsp';
const SEMESTER_SELECTOR = '#htmlPageTopContainer_selectSem';
const COURSE_SELECTOR = '#htmlPageTopContainer_selectCourse';
const COURSE_REPORT_BUTTON_SELECTOR = '#htmlPageTopContainer_submitSave';

async function waitForSemesterChange(page, attendanceFrame, semesterId, previousSerial) {
  await attendanceFrame.waitForFunction(({ targetSemester, prevSerial }) => {
    const url = window.location.href;
    const m = url.match(/pagePostSerialID=(\d+)/);
    if (!m) return false;
    if (prevSerial !== null && m[1] === prevSerial) return false;
    const semSelect = document.getElementById('htmlPageTopContainer_selectSem');
    if (!semSelect || semSelect.value !== String(targetSemester)) return false;
    const courseSelect = document.getElementById('htmlPageTopContainer_selectCourse');
    if (!courseSelect) return false;
    return Array.from(courseSelect.options).some(o => o.value && o.value !== '0');
  }, { targetSemester: String(semesterId), prevSerial: previousSerial }, { timeout: 20000 });

  for (const frame of page.frames()) {
    if (frame.url().includes(ATTENDANCE_PAGE)) return frame;
  }
  throw new Error('Attendance frame lost after semester change');
}

export async function fetchCourseAttendancePdf(page, semesterId, courseId) {
  if (!courseId) return { success: false, error: 'Course ID is required' };

  try {
    let attendanceFrame = getAttendanceFrame(page);
    if (!attendanceFrame) return { success: false, error: 'Attendance frame not found. Open the Attendance page first.' };

    await attendanceFrame.waitForSelector(COURSE_SELECTOR, { timeout: 15000 });

    const currentSemester = await attendanceFrame.evaluate(() => {
      const sel = document.getElementById('htmlPageTopContainer_selectSem');
      return sel ? sel.value : null;
    });

    if (currentSemester !== String(semesterId)) {
      const serialMatch = attendanceFrame.url().match(/pagePostSerialID=(\d+)/);
      const beforeSerial = serialMatch ? serialMatch[1] : null;
      await attendanceFrame.locator(SEMESTER_SELECTOR).selectOption({ value: String(semesterId) });
      attendanceFrame = await waitForSemesterChange(page, attendanceFrame, semesterId, beforeSerial);
    }

    const courseOptionCount = await attendanceFrame.locator(`${COURSE_SELECTOR} option[value="${courseId}"]`).count();
    if (courseOptionCount === 0) {
      const available = await attendanceFrame.evaluate(() => {
        const cs = document.getElementById('htmlPageTopContainer_selectCourse');
        return Array.from(cs.options).filter(o => o.value && o.value !== '0').map(o => o.value);
      });
      return { success: false, error: `Course ${courseId} is not available for semester ${semesterId}`, availableCourseIds: available };
    }

    await attendanceFrame.locator(COURSE_SELECTOR).selectOption({ value: courseId });

    const typeValue = await attendanceFrame.evaluate(() => {
      const sel = document.getElementById('htmlPageTopContainer_selectType');
      return sel ? sel.value : null;
    });
    if (!typeValue || typeValue === '0') return { success: false, error: 'Attendance type not selected in AUMS form' };

    let downloadPromise = null;
    let popupPromise = null;
    try {
      downloadPromise = page.waitForEvent('download', { timeout: 30000 });
      popupPromise = page.waitForEvent('popup', { timeout: 30000 }).catch(() => null);
    } catch (e) {}

    await attendanceFrame.locator(COURSE_REPORT_BUTTON_SELECTOR).click();

    let download = null;
    try { download = await downloadPromise; } catch (e) {}
    let popup = null;
    try { popup = await popupPromise; } catch (e) {}

    if (!download && popup) {
      try { await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch {}
      try {
        const resp = await popup.waitForResponse(
          r => r.url().includes('AUMSReportServlet') || (r.headers()['content-type'] || '').includes('application/pdf'),
          { timeout: 15000 }
        );
        const body = await resp.body();
        if (body && body.length > 0) return { success: true, pdfBuffer: Buffer.from(body), source: 'response' };
      } catch (e) {}
    }

    if (!download && popup) {
      try { download = await popup.waitForEvent('download', { timeout: 15000 }); } catch (e) {}
    }

    if (!download) return { success: false, error: 'Course-wise report PDF was not produced by AUMS' };

    const tmpPath = path.join(process.cwd(), `course-report-${courseId}-${Date.now()}.pdf`);
    await download.saveAs(tmpPath);
    const pdfBuffer = fs.readFileSync(tmpPath);
    try { fs.unlinkSync(tmpPath); } catch {}

    if (popup && !popup.isClosed()) await popup.close().catch(() => {});

    return { success: true, pdfBuffer, source: 'download' };
  } catch (error) {
    console.error('[COURSE-PDF] Error:', error.message);
    return { success: false, error: error.message || 'Failed to fetch course attendance PDF' };
  }
}

export default fetchCourseAttendancePdf;
