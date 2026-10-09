// Throwaway verification script for attendanceMath edge cases (not part of the
// app build). Run: node scripts/check_attendance_math.mjs
import assert from 'node:assert';
import {
  attendancePercent, classesToReachTarget, bunkableToStayAbove,
  projectAfterAttending, projectAfterBunking, riskLevel,
} from '../frontend/src/lib/attendanceMath.ts';

const eq = (a, b, m) => assert.strictEqual(a, b, m);

// Basic percentage
eq(attendancePercent({ attended: 72, total: 100 }), 72);
eq(attendancePercent({ attended: 0, total: 0 }), 0);

// 72% < 75% → ceil((0.75*100 - 72)/0.25) = 12
eq(classesToReachTarget({ attended: 72, total: 100 }, 75), 12);
// Exactly at target → 0
eq(classesToReachTarget({ attended: 75, total: 100 }, 75), 0);
// Above target → 0
eq(classesToReachTarget({ attended: 90, total: 100 }, 75), 0);
// No classes yet → null (undefined, not 0)
eq(classesToReachTarget({ attended: 0, total: 0 }, 75), null);
// Impossible target: has absences, wants 100%
eq(classesToReachTarget({ attended: 16, total: 20 }, 100), null);
// Already perfect with 100% target → 0
eq(classesToReachTarget({ attended: 20, total: 20 }, 100), 0);
// Fractional attended (OD hours): 16.5/22 = 75% exactly → 0
eq(classesToReachTarget({ attended: 16.5, total: 22 }, 75), 0);
// Fractional need rounds up: 40/60 ≈ 66.7% → ceil((45-40)/0.25)=ceil(20)=20 (60/80=75%)
eq(classesToReachTarget({ attended: 40, total: 60 }, 75), 20);

// Bunkable: exactly at target → letting one slip drops below → 0
eq(bunkableToStayAbove({ attended: 75, total: 100 }, 75), 0);
// 90/100 @ 75% → floor(120-100) = 20
eq(bunkableToStayAbove({ attended: 90, total: 100 }, 75), 20);
// Below target → 0
eq(bunkableToStayAbove({ attended: 40, total: 100 }, 75), 0);
// No classes → 0 (nothing to protect)
eq(bunkableToStayAbove({ attended: 0, total: 0 }, 75), 0);
// Fractional headroom: 56.25/70 = 80.36% @75% → floor(56.25/0.75-70)=floor(5)=5
eq(bunkableToStayAbove({ attended: 56.25, total: 70 }, 75), 5);
// 100% attendance: 40/40 @75% → floor(53.33-40)=13
eq(bunkableToStayAbove({ attended: 40, total: 40 }, 75), 13);

// Projections
eq(projectAfterAttending({ attended: 72, total: 100 }, 8), 74.1); // 80/108 = 74.074 → 74.1
eq(projectAfterBunking({ attended: 90, total: 100 }, 20), 75);   // 90/120
eq(projectAfterBunking({ attended: 40, total: 60 }, 15), 53.3);  // 40/75 = 53.33 → 53.3

// Risk levels
eq(riskLevel(85), 'SAFE');
eq(riskLevel(84.9), 'WATCH');
eq(riskLevel(75), 'WATCH');
eq(riskLevel(74.9), 'AT_RISK');
eq(riskLevel(65), 'AT_RISK');
eq(riskLevel(64.9), 'CRITICAL');
eq(riskLevel(0), 'CRITICAL');

console.log('attendanceMath: all edge cases pass');
