/**
 * Lazy browser runtime.
 *
 * Every Playwright-backed module is imported on first use instead of at server
 * boot, so the default (HTTP-only) path never loads the `playwright` package,
 * never pays its module cost, and never launches Chromium. Modules are loaded
 * once and cached for the lifetime of the process.
 */

let runtimePromise = null;

export function loadBrowserRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const [browser, pageState, profile, gpa, marks, attendanceService, courseAttendanceService] = await Promise.all([
        import('./browser.js'),
        import('./pageState.js'),
        import('./profile.js'),
        import('./gpa.js'),
        import('./marks.js'),
        import('../services/attendanceService.js'),
        import('../services/courseAttendanceService.js'),
      ]);
      return {
        getBrowser: browser.getBrowser,
        closeBrowser: browser.closeBrowser,
        inspectPageState: pageState.inspectPageState,
        recoverAumsSession: pageState.recoverAumsSession,
        reloginInContext: pageState.reloginInContext,
        performAumsLogout: pageState.performAumsLogout,
        fetchProfile: profile.fetchProfile,
        fetchGPA: gpa.fetchGPA,
        fetchMarks: marks.fetchMarks,
        getAttendanceSemesters: attendanceService.getAttendanceSemesters,
        getAttendanceReport: attendanceService.getAttendanceReport,
        getCourseAttendance: courseAttendanceService.getCourseAttendance,
      };
    })().catch((error) => {
      runtimePromise = null; // allow a later retry if the import failed transiently
      throw error;
    });
  }
  return runtimePromise;
}

export default { loadBrowserRuntime };
