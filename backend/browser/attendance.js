const ATTENDANCE_PAGE = 'AttendanceReportStudent.jsp';

export function getAttendanceFrame(page) {
  return page.frames().find(frame => frame.url().includes(ATTENDANCE_PAGE)) || null;
}

async function waitForAttendanceFrame(page, timeout = 15000) {
  await page.waitForFunction((attendancePage) => {
    return Array.from(window.frames).some(frame => {
      try { return frame.location.href.includes(attendancePage); } catch { return false; }
    });
  }, ATTENDANCE_PAGE, { timeout });
  const frame = getAttendanceFrame(page);
  if (!frame) throw new Error('Attendance frame not found');
  return frame;
}

export async function getSemesterOptions(frame) {
  return frame.locator('#htmlPageTopContainer_selectSem option').evaluateAll(options =>
    options.map(option => ({ id: option.value, name: option.textContent.trim(), selected: option.selected })).filter(option => option.id && option.id !== '0')
  );
}

export async function waitForAttendanceControls(page, semesterId) {
  await page.waitForFunction(({ attendancePage, semesterSelector, courseSelector, selectedSemester }) => {
    return Array.from(window.frames).some(frame => {
      try {
        if (!frame.location.href.includes(attendancePage)) return false;
        const semester = frame.document.querySelector(semesterSelector);
        const course = frame.document.querySelector(courseSelector);
        return Boolean(semester && course && semester.value === selectedSemester);
      } catch { return false; }
    });
  }, {
    attendancePage: ATTENDANCE_PAGE,
    semesterSelector: '#htmlPageTopContainer_selectSem',
    courseSelector: '#htmlPageTopContainer_selectCourse',
    selectedSemester: String(semesterId)
  }, { timeout: 15000 });

  const frame = getAttendanceFrame(page);
  if (!frame) throw new Error('Attendance frame not found after semester selection');
  return frame;
}

export function resolveSemesterId(semesters, requestedSemesterId) {
  if (requestedSemesterId) {
    const requested = String(requestedSemesterId);
    if (!semesters.some(semester => semester.id === requested)) throw new Error(`Requested semester ${requested} is not available`);
    return requested;
  }
  const selectedSemester = semesters.find(semester => semester.selected);
  if (selectedSemester) return selectedSemester.id;
  const highestSemester = semesters.reduce((max, semester) => Number(semester.id) > Number(max.id) ? semester : max);
  return highestSemester.id;
}

export async function fetchAttendancePage(page, semesterId) {
  console.log('Opening attendance...');

  await page.waitForLoadState('networkidle');

  let mainFrame = page;
  for (const frame of page.frames()) {
    if (frame.url().includes('index.jsp')) { mainFrame = frame; break; }
  }

  const menuItem = await mainFrame.evaluate(() => {
    const item = document.querySelector('li[data-url*="AttendanceReportStudent.jsp"]');
    if (!item) return null;
    return {
      outerHTML: item.outerHTML,
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
      const mainFrame = document.getElementById('maincontentframe');
      if (mainFrame) mainFrame.src = url;
    }, menuItem.dataUrl);
  }

  await page.waitForFunction(() => {
    const frames = window.frames;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].location.href.includes('AttendanceReportStudent.jsp')) return true;
    }
    return false;
  }, { timeout: 15000 });

  let attendanceFrame = await waitForAttendanceFrame(page);
  await attendanceFrame.locator('#htmlPageTopContainer_selectSem').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForLoadState('networkidle');

  const semesters = await getSemesterOptions(attendanceFrame);
  if (semesters.length === 0) throw new Error('No semesters available in dropdown');

  semesterId = resolveSemesterId(semesters, semesterId);

  await attendanceFrame.locator('#htmlPageTopContainer_selectSem').selectOption({ value: String(semesterId) });

  const newAttendanceFrame = await waitForAttendanceControls(page, semesterId);
  await newAttendanceFrame.locator('#htmlPageTopContainer_selectCourse').waitFor({ state: 'visible', timeout: 15000 });

  const courseOptions = await newAttendanceFrame.locator('#htmlPageTopContainer_selectCourse option').evaluateAll(options =>
    options.map(option => ({ value: option.value, text: option.textContent.trim() }))
  );

  const courseLookup = {};
  for (const option of courseOptions) {
    if (!option.value || option.value === '0') continue;
    const code = option.text.split(':')[0].trim();
    courseLookup[code] = option.value;
  }

  await newAttendanceFrame.locator('#htmlPageTopContainer_submitSummary').waitFor({ state: 'visible', timeout: 15000 });
  await newAttendanceFrame.locator('#htmlPageTopContainer_submitSummary').click();

  try {
    await newAttendanceFrame.locator('#fieldset-arrearreport, #arrearreport').waitFor({ state: 'attached', timeout: 15000 });
  } catch (e) {
    console.log('Attendance table not found after summary click');
  }

  const html = await newAttendanceFrame.content();
  return { html, courseLookup };
}

export default fetchAttendancePage;
