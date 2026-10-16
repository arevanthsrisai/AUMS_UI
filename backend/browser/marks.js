import { logTiming } from '../services/timing.js';
import { parseMarksPage } from '../parsers/marksParser.js';

/**
 * Playwright-backed fallback for published marks (browser-mode sessions only).
 * The HTTP path in services/aumsHttp.js is the default; this mirrors the
 * proven fetchGPA frame flow so both modes return the identical shape.
 */
export async function fetchMarks(page, semester) {
  const t0 = Date.now();
  let navigated = false;
  let changed = false;
  let fastPath = false;
  try {
    // Step 1: Navigate to the marks screen via the menu (preserves frameset).
    if (!page.url().includes('ViewPublishedMark.jsp')) {
      const mainFrame = page.frames().find((f) => f.url().includes('index.jsp')) || page;

      const menuItem = await mainFrame.evaluate(() => {
        const items = document.querySelectorAll('li[data-url]');
        for (const item of items) {
          const url = item.getAttribute('data-url');
          if (url && url.includes('ViewPublishedMark.jsp')) return { dataUrl: url };
        }
        return null;
      });

      if (!menuItem) return { success: false, error: 'Marks menu not found' };

      navigated = true;
      await mainFrame.evaluate((url) => {
        const mf = document.getElementById('maincontentframe');
        if (mf) mf.src = url;
      }, menuItem.dataUrl);

      await page.waitForFunction(() => {
        return Array.from(window.frames).some((f) => {
          try { return f.location.href.includes('ViewPublishedMark.jsp'); } catch { return false; }
        });
      }, undefined, { timeout: 15000, polling: 250 });
    }

    // Step 2: Find the marks frame.
    let marksFrame = page.frames().find((f) => f.url().includes('ViewPublishedMark.jsp'));
    if (!marksFrame) return { success: false, error: 'Marks frame not found' };

    await marksFrame.waitForSelector('#htmlPageTopContainer_selectStep', { timeout: 15000 });

    // Step 3: Compare the rendered semester with the requested one.
    const dropdown = marksFrame.locator('#htmlPageTopContainer_selectStep');
    const options = await dropdown.evaluate((select) =>
      Array.from(select.querySelectorAll('option')).map((opt) => ({
        value: opt.value || 'none',
        text: (opt.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(),
        selected: opt.selected,
      }))
    );
    if (options.length === 0) return { success: false, error: 'No semesters in marks dropdown' };

    const requested = semester ? String(semester).trim() : '';
    const selectedOption = options.find((o) => o.selected);
    const matchingOption = requested ? options.find((o) => o.text === requested) : selectedOption;

    if (!requested || (selectedOption && selectedOption.text === requested)) {
      fastPath = true; // AUMS already pre-rendered the requested semester.
    } else if (matchingOption) {
      if (!selectedOption || selectedOption.value !== matchingOption.value) {
        await dropdown.selectOption({ value: matchingOption.value });
      }
      changed = true;

      // Trigger the AUMS-internal SELSEM POST.
      await marksFrame.evaluate(() => {
        if (typeof formSubmit === 'function') formSubmit('UMS-EVAL_STUDMARKVIEW_SELSEM_SCREEN');
      });

      try {
        await waitForMarksPost(page, matchingOption.text, 20000);
      } catch {
        try { await marksFrame.waitForSelector('#marks table tr:nth-child(2)', { timeout: 3000 }); }
        catch { /* parse whatever is rendered below */ }
      }

      // Frame may have been recreated by the POST.
      marksFrame = page.frames().find((f) => f.url().includes('ViewPublishedMark.jsp'));
      if (!marksFrame) return { success: false, error: 'Marks frame lost after formSubmit' };
    }

    // Step 4: Parse the live DOM with the exact same parser as the HTTP path.
    const html = await marksFrame.content();
    const parsed = parseMarksPage(html);
    logTiming('marks', null, Date.now() - t0, {
      path: fastPath ? 'fast' : 'full',
      navigated,
      changed,
      courses: (parsed.courses || []).length,
      exams: (parsed.exams || []).length,
    });
    return parsed;
  } catch (error) {
    console.error('[MARKS] Error:', error.message);
    logTiming('marks', null, Date.now() - t0, { error: error.message });
    return { success: false, error: 'Unable to fetch marks: ' + error.message };
  }
}

// Completion signal for the SELSEM POST: pagePostSerialID must bump and the
// dropdown must show the target semester (event-based, not a fixed sleep).
async function waitForMarksPost(page, targetSemesterText, timeoutMs) {
  const frameBefore = page.frames().find((f) => f.url().includes('ViewPublishedMark.jsp'));
  const before = frameBefore
    ? ((frameBefore.url().match(/pagePostSerialID=(\d+)/) || [])[1] || null)
    : null;

  await page.waitForFunction(
    ({ target, prevSerial }) => {
      const frame = Array.from(window.frames).find((f) => {
        try { return f.location.href.includes('ViewPublishedMark.jsp'); } catch { return false; }
      });
      if (!frame) return false;
      try {
        const m = frame.location.href.match(/pagePostSerialID=(\d+)/);
        if (!m) return false;
        if (prevSerial !== null && m[1] === prevSerial) return false;
        const sel = frame.document.querySelector('#htmlPageTopContainer_selectStep');
        if (!sel || !sel.selectedOptions || !sel.selectedOptions[0]) return false;
        return (sel.selectedOptions[0].textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim() === String(target);
      } catch { return false; }
    },
    { target: String(targetSemesterText), prevSerial: before },
    { timeout: timeoutMs, polling: 250 }
  );
}

export default fetchMarks;
