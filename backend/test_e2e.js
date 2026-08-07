const BASE = 'http://localhost:3001';
let sessionId = null;

async function test(name, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    console.log('? ' + name + ' (' + (Date.now() - start) + 'ms)');
    return result;
  } catch (e) {
    console.log('? ' + name + ': ' + e.message);
    throw e;
  }
}

async function login() {
  return test('Login', async () => {
    const res = await fetch(BASE + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: process.env.AUMS_USERNAME, password: process.env.AUMS_PASSWORD })
    });
    const data = await res.json();
    if (!data.success || !data.sessionId) throw new Error('Login failed: ' + data.error);
    sessionId = data.sessionId;
    console.log('   Session: ' + sessionId.substring(0, 8) + '...');
    return sessionId;
  });
}

async function getProfile() {
  return test('Profile', async () => {
    const res = await fetch(BASE + '/profile', {
      headers: { 'x-session-id': sessionId }
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    console.log('   Name: ' + data.name + ', Roll: ' + data.rollNumber);
    return data;
  });
}

async function getGPA() {
  return test('GPA', async () => {
    const res = await fetch(BASE + '/gpa?semester=1', {
      headers: { 'x-session-id': sessionId }
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    console.log('   CGPA: ' + data.currentCgpa + ', SGPA: ' + data.semesterSgpa + ', Courses: ' + (data.grades?.length || 0));
    return data;
  });
}

async function getAttendanceSemesters() {
  return test('Attendance Semesters', async () => {
    const res = await fetch(BASE + '/attendance', {
      headers: { 'x-session-id': sessionId }
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    console.log('   Semesters: ' + data.semesters.map(s => s.name).join(', '));
    return data.semesters;
  });
}

async function getAttendanceReport(semesterId) {
  return test('Attendance Report (sem=' + semesterId + ')', async () => {
    const res = await fetch(BASE + '/attendance/report', {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ semesterId })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    console.log('   Semester: ' + data.semester + ', Subjects: ' + data.subjects.length);
    return data;
  });
}

async function getCourseAttendance(semesterId, courseId) {
  return test('Course Attendance (course=' + courseId + ')', async () => {
    const res = await fetch(BASE + '/attendance/course', {
      method: 'POST',
      headers: { 'x-session-id': sessionId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ semesterId, courseId })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    console.log('   Subject: ' + data.subject.name + ', %: ' + data.stats.percentage + ', Events: ' + data.events.length);
    return data;
  });
}

async function logout() {
  return test('Logout', async () => {
    const res = await fetch(BASE + '/logout', {
      method: 'POST',
      headers: { 'x-session-id': sessionId }
    });
    const data = await res.json();
    if (!data.success) throw new Error('Logout failed');
    sessionId = null;
    return data;
  });
}

async function runSingleUser() {
  console.log('\n========== SINGLE USER E2E ==========\n');
  await login();
  await getProfile();
  await getGPA();
  const semesters = await getAttendanceSemesters();
  if (semesters.length > 0) {
    await getAttendanceReport(semesters[0].id);
    const report = await getAttendanceReport(semesters[0].id);
    if (report.subjects.length > 0 && report.subjects[0].courseId) {
      await getCourseAttendance(semesters[0].id, report.subjects[0].courseId);
    }
  }
  await logout();
  console.log('\n? Single user E2E passed\n');
}

async function runConcurrent() {
  console.log('\n========== CONCURRENT REQUESTS ==========\n');
  await login();
  const semesters = await getAttendanceSemesters();
  const semesterId = semesters[0]?.id;
  
  if (!semesterId) throw new Error('No semesters');
  
  console.log('   Firing 3 concurrent requests...');
  const [p, g, a] = await Promise.allSettled([
    getProfile(),
    getGPA(),
    getAttendanceReport(semesterId)
  ]);
  
  if (p.status === 'rejected') throw p.reason;
  if (g.status === 'rejected') throw g.reason;
  if (a.status === 'rejected') throw a.reason;
  
  console.log('   ? All 3 concurrent requests succeeded');
  
  const report = a.value;
  if (report.subjects.length > 0 && report.subjects[0].courseId) {
    const courseId = report.subjects[0].courseId;
    console.log('   Firing 3 concurrent requests (with course attendance)...');
    const [p2, g2, c] = await Promise.allSettled([
      getProfile(),
      getGPA(),
      getCourseAttendance(semesterId, courseId)
    ]);
    if (p2.status === 'rejected') throw p2.reason;
    if (g2.status === 'rejected') throw g2.reason;
    if (c.status === 'rejected') throw c.reason;
    console.log('   ? All 3 concurrent requests succeeded');
  }
  
  await logout();
  console.log('\n? Concurrent requests passed\n');
}

async function runMultiUser() {
  console.log('\n========== MULTI-USER ==========\n');
  
  console.log('   User A: Login...');
  const resA = await fetch(BASE + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.AUMS_USERNAME, password: process.env.AUMS_PASSWORD })
  });
  const dataA = await resA.json();
  if (!dataA.success) throw new Error('User A login failed: ' + dataA.error);
  const sessionA = dataA.sessionId;
  console.log('   User A session: ' + sessionA.substring(0, 8) + '...');
  
  console.log('   User B: Login...');
  const resB = await fetch(BASE + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.AUMS_USERNAME, password: process.env.AUMS_PASSWORD })
  });
  const dataB = await resB.json();
  if (!dataB.success) throw new Error('User B login failed: ' + dataB.error);
  const sessionB = dataB.sessionId;
  console.log('   User B session: ' + sessionB.substring(0, 8) + '...');
  
  console.log('   User A: Profile + Attendance...');
  const [pa, aa] = await Promise.allSettled([
    fetch(BASE + '/profile', { headers: { 'x-session-id': sessionA } }).then(r => r.json()),
    fetch(BASE + '/attendance', { headers: { 'x-session-id': sessionA } }).then(r => r.json())
  ]);
  if (pa.status === 'rejected' || !pa.value.success) throw pa.reason || new Error(pa.value.error);
  if (aa.status === 'rejected' || !aa.value.success) throw aa.reason || new Error(aa.value.error);
  console.log('   User A: Profile OK (' + pa.value.name + '), Semesters: ' + aa.value.semesters.length);
  
  console.log('   User B: GPA + Attendance...');
  const [gb, ab] = await Promise.allSettled([
    fetch(BASE + '/gpa?semester=1', { headers: { 'x-session-id': sessionB } }).then(r => r.json()),
    fetch(BASE + '/attendance', { headers: { 'x-session-id': sessionB } }).then(r => r.json())
  ]);
  if (gb.status === 'rejected' || !gb.value.success) throw gb.reason || new Error(gb.value.error);
  if (ab.status === 'rejected' || !ab.value.success) throw ab.reason || new Error(ab.value.error);
  console.log('   User B: GPA OK (' + gb.value.currentCgpa + '), Semesters: ' + ab.value.semesters.length);
  
  if (pa.value.sessionId === sessionB) throw new Error('Cross-contamination: User A got User B session');
  if (gb.value.sessionId === sessionA) throw new Error('Cross-contamination: User B got User A session');
  console.log('   ? No cross-user data leakage');
  
  await Promise.all([
    fetch(BASE + '/logout', { method: 'POST', headers: { 'x-session-id': sessionA } }),
    fetch(BASE + '/logout', { method: 'POST', headers: { 'x-session-id': sessionB } })
  ]);
  console.log('   ? Both logged out');
  
  const checkA = await fetch(BASE + '/profile', { headers: { 'x-session-id': sessionA } }).then(r => r.json());
  const checkB = await fetch(BASE + '/profile', { headers: { 'x-session-id': sessionB } }).then(r => r.json());
  if (checkA.success) throw new Error('User A session still valid after logout');
  if (checkB.success) throw new Error('User B session still valid after logout');
  console.log('   ? Sessions properly cleaned up');
  
  console.log('\n? Multi-user passed\n');
}

async function runStress() {
  console.log('\n========== STRESS TEST (5 cycles) ==========\n');
  for (let i = 1; i <= 5; i++) {
    console.log('   Cycle ' + i + '/5...');
    await login();
    await getProfile();
    await getGPA();
    const semesters = await getAttendanceSemesters();
    if (semesters.length > 0) {
      await getAttendanceReport(semesters[0].id);
    }
    await logout();
    console.log('   Cycle ' + i + ' complete');
  }
  console.log('\n? Stress test passed\n');
}

async function main() {
  console.log('--------------------------------------');
  console.log('   PRODUCTION VALIDATION TEST');
  console.log('--------------------------------------\n');
  
  if (!process.env.AUMS_USERNAME || !process.env.AUMS_PASSWORD) {
    console.log('? Set AUMS_USERNAME and AUMS_PASSWORD environment variables');
    process.exit(1);
  }
  
  try {
    await runSingleUser();
    await runConcurrent();
    await runMultiUser();
    await runStress();
    
    console.log('--------------------------------------');
    console.log('   ALL VERIFICATIONS PASSED ?');
    console.log('--------------------------------------');
  } catch (e) {
    console.log('\n--------------------------------------');
    console.log('   VERIFICATION FAILED ?');
    console.log('--------------------------------------');
    console.error(e);
    process.exit(1);
  }
}

main();
