export async function fetchAttendanceSemesters(page) {
  try {
    await page.waitForLoadState('networkidle');

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

    if (!menuItem) return { success: false, error: 'Attendance menu item not found' };

    if (menuItem.onclick) {
      await mainFrame.evaluate((funcName) => { if (window[funcName]) window[funcName](); }, menuItem.functionName);
    } else {
      await mainFrame.evaluate((url) => {
        const mainFrame = document.getElementById('maincontentframe');
        if (mainFrame) mainFrame.src = url;
      }, menuItem.dataUrl);
    }

    await page.waitForFunction(() => {
      return Array.from(window.frames).some(frame => {
        try { return frame.location.href.includes('AttendanceReportStudent.jsp'); } catch { return false; }
      });
    }, { timeout: 15000 });

    let attendanceFrame = null;
    for (const frame of page.frames()) {
      if (frame.url().includes('AttendanceReportStudent.jsp')) { attendanceFrame = frame; break; }
    }
    if (!attendanceFrame) return { success: false, error: 'Attendance frame not found' };

    await attendanceFrame.waitForSelector('#htmlPageTopContainer_selectSem', { timeout: 15000 });
    await page.waitForLoadState('networkidle');

    const semesters = await attendanceFrame.evaluate(() => {
      const options = document.querySelectorAll('#htmlPageTopContainer_selectSem option');
      const list = [];
      options.forEach(opt => {
        const val = opt.value;
        if (val && val !== '0') list.push({ id: val, name: opt.textContent.trim() });
      });
      return list;
    });

    if (semesters.length === 0) return { success: false, error: 'No semesters available in dropdown' };
    return { success: true, semesters };
  } catch (error) {
    return { success: false, error: error.message || 'Failed to fetch attendance semesters' };
  }
}

export default fetchAttendanceSemesters;
