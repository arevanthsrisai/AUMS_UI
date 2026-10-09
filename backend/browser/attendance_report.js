import path from 'path';
import fs from 'fs';
import { logTiming } from '../services/timing.js';

const ATTENDANCE_PAGE = 'AttendanceReportStudent.jsp';

export async function fetchAttendanceReport(page, semesterId) {
  try {
    let attendanceFrame = null;
    for (const frame of page.frames()) {
      if (frame.url().includes('AttendanceReportStudent.jsp')) { attendanceFrame = frame; break; }
    }

    if (!attendanceFrame) {
      let mainFrame = page;
      for (const frame of page.frames()) {
        if (frame.url().includes('index.jsp')) { mainFrame = frame; break; }
      }

      const menuItem = await mainFrame.evaluate(() => {
        const item = document.querySelector('li[data-url*="AttendanceReportStudent.jsp"]');
        if (!item) return null;
        return {
          dataUrl: item.getAttribute('data-url'),
          onclick: item.onclick?.toString() || null,
          functionName: item.onclick?.name || null
        };
      });

      if (!menuItem) throw new Error('Attendance menu item not found');

      if (menuItem.onclick) {
        await mainFrame.evaluate((funcName) => { if (window[funcName]) window[funcName](); }, menuItem.functionName);
      } else {
        await mainFrame.evaluate((url) => {
          const mf = document.getElementById('maincontentframe');
          if (mf) mf.src = url;
        }, menuItem.dataUrl);
      }

      await new Promise((r) => setTimeout(r, 1000));

      for (const frame of page.frames()) {
        if (frame.url().includes('AttendanceReportStudent.jsp')) { attendanceFrame = frame; break; }
      }
    }

    // Wait for semester dropdown to be populated
    try {
      await attendanceFrame.waitForFunction(() => {
        const semSelect = document.getElementById('htmlPageTopContainer_selectSem');
        if (!semSelect) return false;
        return Array.from(semSelect.options).some(option => option.value && option.value !== '0');
      }, undefined, { timeout: 15000, polling: 250 });
    } catch (e) {
      return { success: false, error: 'Semester dropdown never populated' };
    }

    // Check if semester change is needed
    const currentSemesterValue = await attendanceFrame.evaluate(() => {
      const sel = document.getElementById('htmlPageTopContainer_selectSem');
      return sel ? sel.value : null;
    });

    if (currentSemesterValue === String(semesterId)) {
      // Semester already selected
    } else {
      await attendanceFrame.locator('#htmlPageTopContainer_selectSem').selectOption({ value: String(semesterId) });

      // Wait for the semester change to complete via the pagePostSerialID delta
      // — the same content+URL-serial event signal used across the attendance
      // modules. (The previous fixed-delay polling was removed entirely.)
      const serialMatch = attendanceFrame.url().match(/pagePostSerialID=(\d+)/);
      const beforeSerial = serialMatch ? serialMatch[1] : null;
      await attendanceFrame.waitForFunction(({ targetSemester, previousSerial }) => {
        const url = window.location.href;
        const m = url.match(/pagePostSerialID=(\d+)/);
        if (!m) return false;
        if (previousSerial !== null && m[1] === previousSerial) return false;
        const semSelect = document.getElementById('htmlPageTopContainer_selectSem');
        if (!semSelect || semSelect.value !== String(targetSemester)) return false;
        const courseSelect = document.getElementById('htmlPageTopContainer_selectCourse');
        if (!courseSelect) return false;
        return Array.from(courseSelect.options).some((o) => o.value && o.value !== '0');
      }, { targetSemester: String(semesterId), previousSerial: beforeSerial }, { timeout: 20000, polling: 250 });

      // Re-acquire frame after reload
      attendanceFrame = null;
      for (const frame of page.frames()) {
        if (frame.url().includes('AttendanceReportStudent.jsp')) { attendanceFrame = frame; break; }
      }
      if (!attendanceFrame) throw new Error('Attendance frame lost after semester change');
    }

    // Wait for course dropdown
    await attendanceFrame.locator('#htmlPageTopContainer_selectCourse').waitFor({ state: 'visible', timeout: 15000 });

    const courseOptions = await attendanceFrame.locator('#htmlPageTopContainer_selectCourse option').evaluateAll(options =>
      options.map(option => ({ value: option.value, text: option.textContent.trim() }))
    );

    const courseLookup = {};
    for (const option of courseOptions) {
      if (!option.value || option.value === '0') continue;
      const code = option.text.split(':')[0].trim();
      courseLookup[code] = option.value;
    }

    // Check if a course is already selected
    const selectedCourse = await attendanceFrame.evaluate(() => {
      const sel = document.getElementById('htmlPageTopContainer_selectCourse');
      return sel ? sel.value : null;
    });

    if (selectedCourse && selectedCourse !== '0') {
      // Course already selected, just get the HTML
      const html = await attendanceFrame.content();
      return { success: true, html, courseLookup };
    }

    // Click Attendance Summary
    await attendanceFrame.locator('#htmlPageTopContainer_submitSummary').waitFor({ state: 'visible', timeout: 15000 });
    await attendanceFrame.locator('#htmlPageTopContainer_submitSummary').click();
    const tSummary = Date.now();

    // Remember the summary frame's pagePostSerialID before the POST so we can
    // detect the re-render precisely.
    const beforeSummarySerial = (attendanceFrame.url().match(/pagePostSerialID=(\d+)/) || [])[1] || null;

    // Wait for the summary POST to complete via the pagePostSerialID delta in
    // the attendance frame URL — a real re-render signal (AUMS bumps the
    // serial on every POST navigation). Replaces the previous fixed 500ms
    // poll loop: we stop the moment the new frame is in place, then verify
    // content directly instead of sleeping to a stability threshold.
    try {
      await page.waitForFunction((previousSerial) => {
        const frame = Array.from(window.frames).find((f) => {
          try { return f.location.href.includes('AttendanceReportStudent.jsp'); } catch { return false; }
        });
        if (!frame) return false;
        try {
          const m = frame.location.href.match(/pagePostSerialID=(\d+)/);
          if (!m) return false;
          return previousSerial === null || m[1] !== previousSerial;
        } catch { return false; }
      }, beforeSummarySerial, { timeout: 15000, polling: 250 });
    } catch {
      // Serial did not increment (unusual rendering variation); fall through
      // and let the content check below decide.
    }

    // Re-acquire frame — AUMS recreates it on the summary POST.
    attendanceFrame = null;
    for (const frame of page.frames()) {
      if (frame.url().includes('AttendanceReportStudent.jsp')) { attendanceFrame = frame; break; }
    }
    if (!attendanceFrame) throw new Error('Attendance frame lost');

    // Bounded content check: table cells must exist before we hand the HTML to
    // the parser (data correctness). Typically resolves immediately since the
    // serial-delta wait already proved the re-render.
    try {
      await attendanceFrame.waitForSelector('#fieldset-arrearreport table tr td, #arrearreport table tr td', { timeout: 10000 });
    } catch {
      // No table rendered — the parser will find no subjects and the service
      // layer returns a clean "Attendance table not found or empty" error.
    }

    logTiming('attendance_report', null, Date.now() - tSummary, { phase: 'summary_post_to_table_ready' });

    const html = await attendanceFrame.content();
    return { success: true, html, courseLookup };
  } catch (error) {
    console.error('fetchAttendanceReport error:', error);
    return { success: false, error: error.message || 'Failed to fetch attendance report' };
  }
}

export default fetchAttendanceReport;
