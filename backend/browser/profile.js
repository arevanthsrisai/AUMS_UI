const PROFILE_PAGE = 'Student.jsp';
const PROFILE_SELECTOR = 'input[name="htmlPageTopContainer_addst_txteditfirstName"]';

export function getProfileFrame(page) {
  return page.frames().find(frame => frame.url().includes(PROFILE_PAGE)) || null;
}

async function waitForProfileFrame(page, timeout = 15000) {
  await page.waitForFunction((profilePage) => {
    return Array.from(window.frames).some(frame => {
      try { return frame.location.href.includes(profilePage); } catch { return false; }
    });
  }, PROFILE_PAGE, { timeout });
  const frame = getProfileFrame(page);
  if (!frame) throw new Error('Profile frame not found');
  return frame;
}

export async function openProfilePage(page) {
  await page.waitForLoadState('networkidle');

  let mainFrame = page;
  for (const frame of page.frames()) {
    if (frame.url().includes('index.jsp')) { mainFrame = frame; break; }
  }

  const menuItem = await mainFrame.evaluate(() => {
    const item = document.querySelector('li[data-url*="UMS-SRM_INIT_STUDENTPROFILE_SCREEN"]');
    if (!item) return null;
    return {
      dataUrl: item.getAttribute('data-url'),
      onclick: item.onclick ? item.onclick.toString() : null,
      functionName: item.onclick ? item.onclick.name : null
    };
  });

  if (!menuItem) throw new Error('Student Profile menu item not found');

  if (menuItem.onclick) {
    await mainFrame.evaluate((funcName) => { if (window[funcName]) window[funcName](); }, menuItem.functionName);
  } else {
    await mainFrame.evaluate((url) => {
      const mainContent = document.getElementById('maincontentframe');
      if (mainContent) mainContent.src = url;
      else window.location.href = url;
    }, menuItem.dataUrl);
  }

  return waitForProfileFrame(page);
}

async function openProfilePageFallback(page) {
  const currentUrl = page.url();
  const base = currentUrl.split('/aums/')[0] + '/aums/';
  const absolute = base + 'Jsp/Student/Student.jsp?action=UMS-SRM_INIT_STUDENTPROFILE_SCREEN&isMenu=true';
  await page.goto(absolute, { waitUntil: 'domcontentloaded', timeout: 20000 });
  return waitForProfileFrame(page);
}

export async function extractProfileFromFrame(frame) {
  return frame.evaluate(() => {
    const out = { name: '', rollNumber: '', registrationNumber: '', programme: '', branch: '', semester: '', batch: '', section: '', campus: '', email: '', phone: '', mentor: '', photo: '' };
    const clean = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const assign = (key, value) => { const v = clean(value); if (v && v !== 'Select' && v.toLowerCase() !== 'select' && !out[key]) out[key] = v; };
    const splitProgramme = (v) => { const t = clean(v); const m = t.match(/^([A-Za-z.\s]+?)\s*(\d{4})?$/); return { name: (m && m[1] ? m[1] : t).trim(), year: m && m[2] ? m[2] : '' }; };
    const orphanLabels = Array.from(document.querySelectorAll('fieldset[id^="fieldset-orphan-label-"] label'));
    const text = (el) => (el.textContent || '').replace(/&nbsp;/g, ' ').trim();
    for (let i = 0; i < orphanLabels.length - 1; i++) {
      const label = text(orphanLabels[i]).toLowerCase();
      const value = text(orphanLabels[i + 1]);
      if (/first name/.test(label)) assign('name', value);
      if (/academic program/.test(label)) { const p = splitProgramme(value); assign('programme', p.name); if (p.year) assign('batch', p.year); }
      if (/branch/.test(label)) assign('branch', value);
    }
    assign('name', document.querySelector('input[name="htmlPageTopContainer_addst_txteditfirstName"]')?.value);
    assign('rollNumber', document.querySelector('input[name="htmlPageTopContainer_addst_txteditapplicationNo"]')?.value);
    assign('registrationNumber', document.querySelector('input[name="htmlPageTopContainer_addst_txteditadmissionNo"]')?.value);
    assign('programme', document.querySelector('select[name="htmlPageTopContainer_addst_selectProgram"]')?.value);
    assign('branch', document.querySelector('select[name="htmlPageTopContainer_addst_selectBranch"]')?.value);
    assign('batch', document.querySelector('select[name="htmlPageTopContainer_addst_selectYear"]')?.value);
    assign('email', document.querySelector('input[name="htmlPageTopContainer_addst_txtPersonalEmail"]')?.value);
    assign('phone', document.querySelector('input[name="htmlPageTopContainer_addst_txtPersonalPhone"]')?.value);
    return out;
  });
}

async function extractPhoto(profileFrame, context) {
  try {
    const encoded = await profileFrame.locator('input[name="htmlPageTopContainer_encodedenrollmentId"]').inputValue().catch(() => '');
    if (!encoded) return null;
    const absolute = 'https://aumscn.amrita.edu/aums/FileUploadServlet?action=SHOW_STUDENT_PHOTO&encodedenrollmentId=' + encodeURIComponent(encoded) + '&flag=photo';
    let response;
    if (context && context.request) response = await context.request.get(absolute);
    else response = await profileFrame.request.get(absolute);
    if (!response.ok()) return null;
    const buffer = await response.body();
    if (!buffer || buffer.length === 0) return null;
    const rawType = response.headers()['content-type'] || 'image/jpeg';
    const contentType = /jpe?g/i.test(rawType) ? 'image/jpeg' : rawType;
    return 'data:' + contentType + ';base64,' + buffer.toString('base64');
  } catch { return null; }
}

export async function fetchProfile(page, context) {
  try {
    let profileFrame = null;
    try { profileFrame = await openProfilePage(page); }
    catch (menuError) {
      console.log('Menu navigation failed, falling back to direct URL:', menuError.message);
      profileFrame = await openProfilePageFallback(page);
    }
    await profileFrame.locator(PROFILE_SELECTOR).waitFor({ state: 'attached', timeout: 15000 });
    const profile = await extractProfileFromFrame(profileFrame);
    const photo = await extractPhoto(profileFrame, context);
    if (photo) profile.photo = photo;
    // NOTE: Skip the personal details tab click — it reloads the page and
    // destroys the frameset, breaking all subsequent requests.
    // Email/phone will be empty; the frontend handles this gracefully.
    return { success: true, ...profile };
  } catch (error) {
    console.error('Profile fetch error:', error.message);
    return { success: false, error: 'Unable to fetch profile' };
  }
}

export default fetchProfile;
