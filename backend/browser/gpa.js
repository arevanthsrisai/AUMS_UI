import * as cheerio from 'cheerio';

const HOME_URL = 'https://aumscn.amrita.edu/aums/Jsp/Common/index.jsp';

export async function fetchGPA(page, semester = 1) {
  try {
    // Step 1: Navigate to GPA via menu click (preserves frameset)
    if (!page.url().includes('StudentPerformanceWithSurvey.jsp')) {
      let mainFrame = page.frames().find(f => f.url().includes('index.jsp')) || page;

      const menuItem = await mainFrame.evaluate(() => {
        const items = document.querySelectorAll('li[data-url]');
        for (const item of items) {
          const url = item.getAttribute('data-url');
          if (url && url.includes('StudentPerformanceWithSurvey.jsp')) {
            return { dataUrl: url };
          }
        }
        return null;
      });

      if (!menuItem) return { success: false, error: 'GPA menu not found' };

      await mainFrame.evaluate((url) => {
        const mf = document.getElementById('maincontentframe');
        if (mf) mf.src = url;
      }, menuItem.dataUrl);

      await page.waitForFunction(() => {
        return Array.from(window.frames).some(f =>
          f.location.href.includes('StudentPerformanceWithSurvey.jsp')
        );
      }, { timeout: 15000 });
    }

    // Step 2: Find the GPA frame
    let gpaFrame = page.frames().find(f => f.url().includes('StudentPerformanceWithSurvey.jsp'));
    if (!gpaFrame) return { success: false, error: 'GPA frame not found' };

    await gpaFrame.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Step 3: Find and interact with the semester dropdown
    let dropdown = gpaFrame.locator('#htmlPageTopContainer_selectStep');
    const options = await dropdown.evaluate(select => {
      return Array.from(select.querySelectorAll('option')).map(opt => ({
        value: opt.value || 'none',
        text: opt.textContent.trim(),
        selected: opt.selected
      }));
    });

    if (options.length === 0) {
      return { success: false, error: 'No semesters in GPA dropdown' };
    }

    // Find the matching semester option
    const semesterText = semester.toString();
    const matchingOption = options.find(opt => opt.text === semesterText) || options.find(opt => opt.selected) || options[0];

    console.log('[GPA] Selecting semester:', matchingOption.text, '(value:', matchingOption.value, ')');

    // Step 4: Select the semester
    await dropdown.selectOption({ value: matchingOption.value });

    // Wait for the selection to register
    await page.waitForTimeout(3000);

    // Step 5: Trigger formSubmit to load grade data (THIS IS THE KEY!)
    console.log('[GPA] Triggering formSubmit...');
    await gpaFrame.evaluate(() => {
      if (typeof formSubmit === 'function') {
        formSubmit('UMS-EVAL_STUDPERFORMSURVEY_CHANGESEM_SCREEN');
      }
    });

    // Step 6: Wait for grade data to appear
    try {
      await Promise.race([
        gpaFrame.waitForSelector('#fieldset-Grades table tr:nth-child(2)', { timeout: 15000 }),
        gpaFrame.waitForFunction(() => {
          const labels = document.querySelectorAll('label');
          for (const l of labels) {
            if (l.textContent.includes('Semester SGPA')) return true;
          }
          return false;
        }, { timeout: 15000 })
      ]);
    } catch (e) {
      await gpaFrame.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    }

    // Step 7: Re-acquire frame in case it was recreated
    gpaFrame = page.frames().find(f => f.url().includes('StudentPerformanceWithSurvey.jsp'));
    if (!gpaFrame) return { success: false, error: 'GPA frame lost after formSubmit' };

    // Step 8: Extract data from live DOM
    const result = await gpaFrame.evaluate(() => {
      const out = { currentCgpa: null, semesterSgpa: null, semester: null, grades: [] };

      const orphanLabels = document.querySelectorAll('label[data-component="orphan-label"]');
      for (let i = 0; i < orphanLabels.length; i++) {
        const text = orphanLabels[i].textContent.trim();
        if (text === 'Current CGPA' && i + 1 < orphanLabels.length) {
          const val = parseFloat(orphanLabels[i + 1].textContent.trim());
          if (!isNaN(val)) { out.currentCgpa = orphanLabels[i + 1].textContent.trim(); break; }
        }
      }

      const semSelect = document.querySelector('#htmlPageTopContainer_selectStep');
      if (semSelect) {
        const sel = semSelect.querySelector('option[selected]') || semSelect.querySelector('option:checked');
        if (sel) out.semester = sel.textContent.trim();
      }

      const fieldset = document.querySelector('#fieldset-Grades');
      if (fieldset) {
        const table = fieldset.querySelector('table');
        if (table) {
          const rows = table.querySelectorAll('tr');
          for (let i = 1; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length >= 6) {
              const semText = cells[0].textContent.trim();
              const courseCode = cells[1].textContent.trim();
              const courseName = cells[2].textContent.trim();
              const academicTermPeriod = cells[3].textContent.trim();
              const type = cells[4].textContent.trim();
              const grade = cells[5].textContent.trim();
              if (type === 'SGPA' && grade) out.semesterSgpa = grade;
              else if (courseCode && courseName) out.grades.push({
                semester: semText, courseCode, courseName, academicTermPeriod, type, grade
              });
            }
          }
        }
      }

      return out;
    });

    console.log('[GPA] CGPA:', result.currentCgpa, '| SGPA:', result.semesterSgpa, '| Grades:', result.grades.length);

    if (result.currentCgpa === null) return { success: false, error: 'Current CGPA not found on page' };
    return {
      success: true,
      currentCgpa: result.currentCgpa,
      semesterSgpa: result.semesterSgpa,
      semester: result.semester || 'Unknown',
      grades: result.grades
    };
  } catch (error) {
    console.error('[GPA] Error:', error.message);
    return { success: false, error: 'Unable to fetch GPA: ' + error.message };
  }
}

export function parseGPAPage(html) {
  const $ = cheerio.load(html);
  const isGPAPage = html.includes('htmlPageTopContainer') && html.includes('Current CGPA') &&
    html.includes('htmlPageTopContainer_selectStep') && html.includes('fieldset-Grades');
  if (!isGPAPage) return { success: false, error: 'Not a GPA page' };

  let currentCgpa = null;
  const orphanLabels = $('label[data-component="orphan-label"]');
  for (let i = 0; i < orphanLabels.length; i++) {
    const text = $(orphanLabels[i]).text().trim();
    if (text === 'Current CGPA' && i + 1 < orphanLabels.length) {
      const cgpaText = $(orphanLabels[i + 1]).text().trim();
      if (!isNaN(parseFloat(cgpaText))) { currentCgpa = cgpaText; break; }
    }
  }

  let semester = null;
  const semesterSelect = $('#htmlPageTopContainer_selectStep');
  if (semesterSelect.length > 0) {
    const selectedOption = semesterSelect.find('option[selected]').first();
    if (selectedOption.length > 0) semester = selectedOption.text().trim();
  }

  let semesterSgpa = null;
  const grades = [];
  const gradesFieldset = $('#fieldset-Grades');
  if (gradesFieldset.length > 0) {
    const table = gradesFieldset.find('table').first();
    if (table.length > 0) {
      const rows = table.find('tr');
      for (let i = 1; i < rows.length; i++) {
        const cells = $(rows[i]).find('td');
        if (cells.length >= 6) {
          const type = $(cells[4]).text().trim();
          const grade = $(cells[5]).text().trim();
          if (type === 'SGPA' && grade) semesterSgpa = grade;
          else if ($(cells[1]).text().trim() && $(cells[2]).text().trim()) {
            grades.push({
              semester: $(cells[0]).text().trim(),
              courseCode: $(cells[1]).text().trim(),
              courseName: $(cells[2]).text().trim(),
              academicTermPeriod: $(cells[3]).text().trim(),
              type, grade
            });
          }
        }
      }
    }
  }

  if (currentCgpa === null) return { success: false, error: 'Current CGPA not found on page' };
  return { success: true, currentCgpa, semesterSgpa, semester: semester || 'Unknown', grades };
}

export default fetchGPA;
