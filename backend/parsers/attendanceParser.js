import * as cheerio from 'cheerio';

const COURSE_CODE_REGEX = /^[0-9]{2}[A-Z]{3}[0-9]{3}$/;

export function parseAttendance(html, courseLookup) {
  const $ = cheerio.load(html);
  const subjects = [];

  $('table tr').each((index, element) => {
    const cells = $(element).find('td');
    if (cells.length !== 8) return;

    const code = $(cells[0]).text().trim();
    if (!COURSE_CODE_REGEX.test(code)) return;

    const courseId = courseLookup[code];
    const name = $(cells[1]).text().trim();
    const totalClasses = parseInt($(cells[5]).text().trim()) || 0;
    const attendedClasses = parseFloat($(cells[6]).text().trim()) || 0;
    const attendance = parseFloat($(cells[7]).text().trim()) || 0;

    subjects.push({ courseId, courseCode: code, name, totalClasses, attendedClasses, attendance });
  });

  let semester = '';
  $('#htmlPageTopContainer_selectSem option:selected').each((i, el) => {
    semester = $(el).text().trim();
  });

  return {
    semester: semester ? `Semester ${semester}` : 'Unknown',
    subjects
  };
}

export default parseAttendance;
