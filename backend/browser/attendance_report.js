import path from 'path';
import fs from 'fs';

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

      await new Promise(r => setTimeout(r, 1000));

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
      }, { timeout: 15000 });
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
      const semesterDropdown = attendanceFrame.locator('#htmlPageTopContainer_selectSem');
      await semesterDropdown.selectOption({ value: String(semesterId) });

      // Wait for semester change to complete using content-based signal
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
        return Array.from(courseSelect.options).some(o => o.value && o.value !== '0');
      }, { targetSemester: String(semesterId), previousSerial: beforeSerial }, { timeout: 20000 });

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

    // Wait for table with stability check
    let tablePopulated = false;
    let previousCodes = null;
    let stableCount = 0;

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));

      let currentFrame = null;
      for (const frame of page.frames()) {
        if (frame.url().includes('AttendanceReportStudent.jsp')) { currentFrame = frame; break; }
      }
      if (!currentFrame) { await new Promise(r => setTimeout(r, 300)); continue; }

      let snapshot;
      try {
        snapshot = await currentFrame.evaluate(() => {
          const table = document.querySelector('#fieldset-arrearreport table, #arrearreport table');
          if (!table) return { exists: false, codes: [] };
          const codes = [];
          const rows = table.querySelectorAll('tr');
          for (let i = 1; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length >= 8) {
              const code = cells[0].textContent.trim();
              if (/^[0-9]{2}[A-Z]{3}[0-9]{3}$/.test(code)) codes.push(code);
            }
          }
          return { exists: true, codes };
        });
      } catch (e) {
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      if (snapshot.exists && snapshot.codes.length > 0) {
        const key = snapshot.codes.join(',');
        if (key === previousCodes) {
          stableCount++;
          if (stableCount >= 3) { tablePopulated = true; break; }
        } else {
          stableCount = 1;
          previousCodes = key;
        }
      } else {
        stableCount = 0;
        previousCodes = null;
      }
    }

    // Re-acquire frame for content extraction
    attendanceFrame = null;
    for (const frame of page.frames()) {
      if (frame.url().includes('AttendanceReportStudent.jsp')) { attendanceFrame = frame; break; }
    }
    if (!attendanceFrame) throw new Error('Attendance frame lost');

    const html = await attendanceFrame.content();
    return { success: true, html, courseLookup };
  } catch (error) {
    console.error('fetchAttendanceReport error:', error);
    return { success: false, error: error.message || 'Failed to fetch attendance report' };
  }
}

export default fetchAttendanceReport;
