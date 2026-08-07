export interface RollNumberInfo {
  campusCode: string;
  campus: string;
  branch: string;
  batch: string;
  section: string;
  sectionIndex: number | null;
}

// Amrita campus code -> display name. The app currently targets the
// Amaravati campus (AV); other campuses map to their known names.
const CAMPUS_NAMES: Record<string, string> = {
  AV: 'Amaravati',
  CO: 'Coimbatore',
  BL: 'Bengaluru',
  CH: 'Chennai',
  KL: 'Kochi',
};

const SECTION_LETTERS = 'ABCDEFGHIJ';

/**
 * Decode an AUMS roll number of the form AV.XX.UX.BBBZZYXX:
 *   AV  -> campus code (Amaravati)
 *   BBB -> branch code (e.g. CSE)
 *   ZZ  -> joining year suffix (25 -> 2025)
 *   Y   -> section index (0 = A, 1 = B, 2 = C ...)
 */
export function decodeRollNumber(roll: string | undefined | null): RollNumberInfo | null {
  if (!roll) return null;
  const m = String(roll)
    .trim()
    .toUpperCase()
    .match(/^([A-Z]{2})\.([A-Z]{2})\.([A-Za-z]\d)\.?([A-Z]{3})(\d{2})(\d)(\d{2})$/);
  if (!m) return null;
  const [, campusCode, , , branch, yy, sectionIdx] = m;
  const index = Number(sectionIdx);
  return {
    campusCode,
    campus: CAMPUS_NAMES[campusCode] || campusCode,
    branch,
    batch: '20' + yy,
    section: SECTION_LETTERS[index] || '',
    sectionIndex: index,
  };
}
