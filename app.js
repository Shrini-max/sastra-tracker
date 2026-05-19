// Data is stored locally in the browser (localStorage). No cloud sync.

// ── Grades ────────────────────────────────────────────────────────
const GS = [
  {min:91, g:'S',  p:10, d:'Outstanding',   c:'#a78bfa'},
  {min:86, g:'A+', p:9,  d:'Excellent',     c:'#60a5fa'},
  {min:75, g:'A',  p:8,  d:'Very Good',     c:'#34d399'},
  {min:66, g:'B',  p:7,  d:'Good',          c:'#4ade80'},
  {min:55, g:'C',  p:6,  d:'Satisfactory',  c:'#facc15'},
  {min:50, g:'D',  p:5,  d:'Pass',          c:'#fb923c'},
  {min:0,  g:'F',  p:0,  d:'Fail',          c:'#f87171'},
];
const PROGRAMMES = {
  btech: {label:'B.Tech', totalCredits:180, semesters:8},
  mtech: {label:'Integrated M.Tech', totalCredits:225, semesters:10}
};
const gfm = m => GS.find(x => m >= x.min) || GS[GS.length-1];
const gfp = p => GS.find(x => x.p === p)  || GS[GS.length-1];
const cc  = v => v>=8.5?'#a78bfa':v>=7.5?'#60a5fa':v>=6.5?'#34d399':v>=6?'#facc15':v>=5?'#fb923c':'#f87171';
const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const programmeRules = programme => PROGRAMMES[programme] || PROGRAMMES.btech;

function classify(cgpa, arr) {
  if (cgpa >= 7.5 && !arr) return {l:'First Class with Distinction', b:'bg'};
  if (cgpa >= 6)            return {l:'First Class',                  b:'bb'};
  if (cgpa >= 5)            return {l:'Second Class',                 b:'bp'};
  return                          {l:'Pass',                          b:'bn'};
}

// ── Data Layer ────────────────────────────────────────────────────
const KEY = 'sastra_v2';
const DATA_VERSION = 3;
const SYNC_DELAY = 900;
let syncTimer = null;

const uid = () =>
  globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);

const mk = () => ({
  version: DATA_VERSION,
  updatedAt: null,
  profile: {name:'', branch:'Electronics & Communication Engineering', batch:'', programme:'btech'},
  semesters: [],
  templates: null,
  tmplVer: null,
  plannedCourses: [],
  arrearOverrides: {},
  arrearCIA: {}
});

const clampNum = (value, min, max, fallback = 0) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
};

const normalizeCourse = course => {
  const credits = Math.round(clampNum(course?.credits, 1, 30, 1));
  const pt = Math.round(clampNum(course?.pt, 0, 10, 0));
  const marks = course?.marks === null || course?.marks === undefined || course?.marks === ''
    ? null
    : clampNum(course.marks, 0, 100, null);
  return {
    id: String(course?.id || uid()),
    name: String(course?.name || 'Untitled Course').trim() || 'Untitled Course',
    credits,
    pt,
    marks,
    grade: gfp(pt).g
  };
};

const normalizeTemplate = tmpl => {
  if (!tmpl || typeof tmpl !== 'object') return null;
  const components = Array.isArray(tmpl.components) ? tmpl.components.map(comp => ({
    id: String(comp?.id || uid()),
    name: String(comp?.name || 'Component').trim() || 'Component',
    ciaMarks: clampNum(comp?.ciaMarks, 0, 50, 0),
    bestOf: comp?.bestOf ? Math.max(1, Math.round(Number(comp.bestOf))) : null,
    entries: Array.isArray(comp?.entries) && comp.entries.length
      ? comp.entries.map(entry => ({
          label: String(entry?.label || 'Entry').trim() || 'Entry',
          max: clampNum(entry?.max, 1, 500, 50)
        }))
      : [{label:'Entry', max:50}]
  })) : [];
  return {
    id: String(tmpl.id || uid()),
    name: String(tmpl.name || 'Template').trim() || 'Template',
    isDefault: !!tmpl.isDefault,
    components
  };
};

const normalizeData = raw => {
  const base = mk();
  const data = raw && typeof raw === 'object' ? raw : {};
  const profile = data.profile && typeof data.profile === 'object' ? data.profile : {};
  base.version = DATA_VERSION;
  base.updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null;
  const programme = profile.programme === 'mtech' ? 'mtech' : 'btech';
  const rules = programmeRules(programme);
  base.profile = {
    name: String(profile.name || '').trim(),
    branch: String(profile.branch || base.profile.branch).trim() || base.profile.branch,
    batch: String(profile.batch || '').trim(),
    programme,
    currentSem: profile.currentSem ? Math.round(clampNum(profile.currentSem, 1, rules.semesters, 1)) : undefined
  };
  base.semesters = Array.isArray(data.semesters) ? data.semesters.map(sem => {
    const courses = Array.isArray(sem?.courses) ? sem.courses.map(normalizeCourse) : [];
    return {
      id: String(sem?.id || uid()),
      name: String(sem?.name || 'Semester').trim() || 'Semester',
      courses,
      sgpa: sgpa(courses),
      tc: courses.reduce((a,c) => a + c.credits, 0)
    };
  }) : [];
  base.templates = Array.isArray(data.templates) ? data.templates.map(normalizeTemplate).filter(Boolean) : null;
  base.tmplVer = data.tmplVer || null;
  base.plannedCourses = Array.isArray(data.plannedCourses) ? data.plannedCourses.map(normalizeCourse) : [];
  base.arrearOverrides = data.arrearOverrides && typeof data.arrearOverrides === 'object'
    ? Object.fromEntries(Object.entries(data.arrearOverrides).map(([key, value]) => [key, Math.round(clampNum(value, 0, 10, 5))]))
    : {};
  base.arrearCIA = data.arrearCIA && typeof data.arrearCIA === 'object'
    ? Object.fromEntries(Object.entries(data.arrearCIA).map(([key, value]) => [key, clampNum(value, 0, 50, 0)]))
    : {};
  return base;
};

const persistLocal = (data, {touch = true} = {}) => {
  const clean = normalizeData(data);
  if (touch) clean.updatedAt = new Date().toISOString();
  localStorage.setItem(KEY, JSON.stringify(clean));
  return clean;
};

const gd = () => {
  try { return normalizeData(JSON.parse(localStorage.getItem(KEY)) || mk()); }
  catch { return mk(); }
};

const sd = (data, opts = {}) => persistLocal(data, {touch: opts.touch !== false});

// ── User Area (sidebar + settings) ───────────────────────────────
function renderUserArea() {
  const d = gd(), p = d.profile;
  const name = p.name || 'Student';
  const el = document.getElementById('sb-user-area');
  if (!el) return;
  el.innerHTML = `
    <div class="sb-user-row">
      <div class="avatar">${esc(name[0].toUpperCase())}</div>
      <div><div class="user-name">${esc(name)}</div><div class="user-sub">Local storage</div></div>
    </div>`;
  renderSyncCard();
}

function renderSyncCard() {
  const el = document.getElementById('sync-card');
  if (!el) return;
  el.innerHTML = `
    <div class="ct">Data Storage</div>
    <div class="al ai">ℹ Your data is saved locally in this browser. Use Export JSON to back it up.</div>`;
}

// ── Default Templates ─────────────────────────────────────────────
const TMPL_VER = 4;
const DEFTMPLS = [
  {
    id:'tmpl_theory', name:'Theory (Standard)', isDefault:true,
    components:[
      {id:'tc1', name:'1st Mid-Term Test',             ciaMarks:20, bestOf:null, entries:[{label:'Marks (out of 50)', max:50}]},
      {id:'tc2', name:'2nd Mid-Term Test',             ciaMarks:20, bestOf:null, entries:[{label:'Marks (out of 50)', max:50}]},
      {id:'tc3', name:'Assignment / Seminar / Quiz',   ciaMarks:10, bestOf:null, entries:[{label:'Assignment (out of 10)', max:10}]}
    ]
  },
  {
    id:'tmpl_lab', name:'Lab (Standard)', isDefault:true,
    components:[
      {id:'lc1', name:'Practical Internal Mark', ciaMarks:50, bestOf:null, entries:[{label:'Lab Internal Mark (out of 50)', max:50}]}
    ]
  },
  {
    id:'tmpl_slst', name:'Semi-Lab Semi-Theory (SLST)', isDefault:true,
    components:[
      {id:'sc1', name:'CIA - First Test',  ciaMarks:15, bestOf:null, entries:[{label:'Marks (out of 50)', max:50}]},
      {id:'sc2', name:'CIA - Second Test', ciaMarks:15, bestOf:null, entries:[{label:'Marks (out of 50)', max:50}]},
      {id:'sc3', name:'Lab / Viva',        ciaMarks:20, bestOf:null, entries:[{label:'Lab / Viva Marks (out of 20)', max:20}]}
    ]
  }
];

function getTmpls() {
  const d = gd();
  if (!d.templates || d.templates.length === 0 || d.tmplVer !== TMPL_VER) {
    const custom = (d.templates || []).filter(t => !t.isDefault);
    d.templates = [...DEFTMPLS, ...custom];
    d.tmplVer   = TMPL_VER;
    sd(d);
  }
  return d.templates;
}

// ── Toast ─────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, type='ok') {
  const el = document.getElementById('toast');
  clearTimeout(toastTimer);
  el.classList.remove('show', 'sticky');
  el.style.borderColor = type==='err'?'var(--er)':type==='warn'?'var(--wn)':'var(--ok)';

  if (type === 'err') {
    // Errors stay until the user dismisses them
    el.innerHTML = '';
    const span = document.createElement('span'); span.textContent = msg; el.appendChild(span);
    const btn = document.createElement('button');
    btn.className = 'toast-close'; btn.textContent = '×';
    btn.onclick = () => el.classList.remove('show', 'sticky');
    el.appendChild(btn);
    el.classList.add('show', 'sticky');
  } else {
    el.textContent = msg;
    el.classList.add('show');
    toastTimer = setTimeout(() => el.classList.remove('show'), 2700);
  }
}

// ── GPA Calculation ───────────────────────────────────────────────
const sgpa = cs => { const s = cs.reduce((a,c) => a+c.credits, 0); return s>0 ? cs.reduce((a,c) => a+c.credits*c.pt, 0)/s : 0; };
const cgpa = ss => { const n = ss.reduce((a,s) => a+s.tc, 0); return n>0 ? ss.reduce((a,s) => a+s.sgpa*s.tc, 0)/n : 0; };

// ── Navigation ────────────────────────────────────────────────────
const TAB_TITLES = {dashboard:'Dashboard', internals:'Internals Calc', semester:'Add Semester', predictor:'CGPA Predictor', settings:'Settings'};

// ── PDF Export ────────────────────────────────────────────────────
function exportPDF() {
  const d = gd(), ss = d.semesters;
  if (!ss.length) { toast('No semester data to export', 'warn'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const cg = cgpa(ss);
  const tc = ss.reduce((a,s) => a+s.tc, 0);
  const hasArr = ss.some(s => s.courses.some(c => c.pt === 0));
  const cls = classify(cg, hasArr);
  const p = d.profile;
  const W = 210, M = 15;

  // Header
  doc.setFillColor(99, 102, 241);
  doc.rect(0, 0, W, 32, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('SASTRA Academic Transcript', M, 13);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(`Generated: ${new Date().toLocaleDateString('en-IN', {day:'numeric',month:'long',year:'numeric'})}`, M, 22);
  doc.text('SASTRA Deemed University', W - M, 22, { align: 'right' });

  // Profile block
  let y = 42;
  doc.setTextColor(30, 30, 30);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(p.name || 'Student', M, y); y += 7;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  if (p.branch) { doc.text(p.branch, M, y); y += 5; }
  if (p.batch)  { doc.text(`Batch: ${p.batch}`, M, y); y += 5; }
  doc.text(`Programme: ${p.programme === 'mtech' ? 'Integrated M.Tech' : 'B.Tech'} · Credits Earned: ${tc}`, M, y); y += 10;

  // Summary box
  doc.setFillColor(240, 240, 255);
  doc.roundedRect(M, y, W - 2*M, 18, 2, 2, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(99, 102, 241);
  doc.text(`CGPA: ${cg.toFixed(2)}`, M + 6, y + 7);
  doc.setTextColor(30, 30, 30);
  doc.setFont('helvetica', 'normal');
  doc.text(`Classification: ${cls.l}`, M + 6, y + 13);
  doc.text(`Arrears: ${hasArr ? 'Yes' : 'None'}`, W - M - 30, y + 7);
  y += 24;

  // Semester breakdown
  ss.forEach((sem, si) => {
    if (y > 255) { doc.addPage(); y = 15; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(30, 30, 30);
    doc.text(`${sem.name}  —  SGPA: ${sem.sgpa.toFixed(2)}  ·  Credits: ${sem.tc}`, M, y); y += 6;
    // Column headers
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(100, 100, 100);
    doc.text('Course', M, y);
    doc.text('Cr', M + 90, y, { align: 'right' });
    doc.text('Grade', M + 110, y, { align: 'right' });
    doc.text('Pts', M + 125, y, { align: 'right' });
    doc.text('Marks', M + 145, y, { align: 'right' });
    y += 2;
    doc.setDrawColor(200, 200, 200);
    doc.line(M, y, W - M, y); y += 4;
    // Rows
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(30, 30, 30);
    sem.courses.forEach(c => {
      if (y > 270) { doc.addPage(); y = 15; }
      const name = c.name.length > 52 ? c.name.slice(0, 49) + '…' : c.name;
      doc.text(name, M, y);
      doc.text(String(c.credits), M + 90, y, { align: 'right' });
      doc.text(c.grade, M + 110, y, { align: 'right' });
      doc.text(String(c.pt), M + 125, y, { align: 'right' });
      doc.text(c.marks != null ? `${c.marks}/100` : '—', M + 145, y, { align: 'right' });
      y += 5;
    });
    y += 4;
  });

  // Footer
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text(`Page ${i} of ${pageCount} · SASTRA Academic Tracker`, W / 2, 290, { align: 'center' });
  }

  const filename = `${(p.name || 'transcript').replace(/\s+/g,'-').toLowerCase()}-transcript.pdf`;
  doc.save(filename);
  toast('PDF exported!');
}

function goTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
  document.getElementById('tab-' + name).classList.add('on');
  document.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('on', el.dataset.tab === name));
  const tbTitle = document.getElementById('tb-title');
  if (tbTitle) tbTitle.textContent = TAB_TITLES[name] || '';
  if (name === 'dashboard') renderDash();
  if (name === 'internals') renderInternals();
  if (name === 'predictor') renderPred();
  if (name === 'settings')  { loadProfile(); renderUserArea(); renderTmplSettings(); }
}

// ════════════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════════════
let gChart = null, pieChart = null;

function renderDash() {
  const d = gd(), ss = d.semesters;
  const cg = cgpa(ss);
  const tc = ss.reduce((a,s) => a+s.tc, 0);
  const hasArr = ss.some(s => s.courses.some(c => c.pt === 0));
  const rules = programmeRules(d.profile.programme);
  const prog  = rules.totalCredits;
  const tsems = rules.semesters;
  const last  = ss[ss.length-1];
  const cls   = classify(cg, hasArr);
  const runCG = ss.map((_,i) => +cgpa(ss.slice(0,i+1)).toFixed(2));
  const name  = d.profile.name || 'Student';

  if (!ss.length) {
    document.getElementById('dash').innerHTML = `
      <div class="al ai">👋 Welcome, <strong>${esc(name)}</strong>! Add your semester data to get started.</div>
      <div class="card" style="text-align:center;padding:56px 24px">
        <div style="font-size:56px;margin-bottom:18px;opacity:.65">🎓</div>
        <div style="font-size:19px;font-weight:800;margin-bottom:8px">No data yet</div>
        <p style="color:var(--txm);font-size:13px;max-width:340px;margin:0 auto 22px;line-height:1.7">
          Add your semester grades to see your CGPA, performance trends, and graduation predictions.
        </p>
        <button class="btn bp2" onclick="goTab('semester')">+ Add First Semester</button>
      </div>`;
    return;
  }

  const pct = Math.min(tc / prog * 100, 100);

  document.getElementById('dash').innerHTML = `
    <div class="mcards">
      <div class="mcard">
        <div class="mcard-accent" style="background:linear-gradient(90deg,var(--pri),var(--sec))"></div>
        <div class="mcard-label">Cumulative GPA</div>
        <div class="mcard-val" style="color:${cc(cg)}">${cg.toFixed(2)}</div>
        <div class="mcard-sub"><span class="bdg ${cls.b}">${cls.l}</span></div>
      </div>
      <div class="mcard">
        <div class="mcard-accent" style="background:linear-gradient(90deg,#818cf8,#60a5fa)"></div>
        <div class="mcard-label">Last SGPA</div>
        <div class="mcard-val" style="color:${cc(last.sgpa)}">${last.sgpa.toFixed(2)}</div>
        <div class="mcard-sub">${esc(last.name)}</div>
      </div>
      <div class="mcard">
        <div class="mcard-accent" style="background:linear-gradient(90deg,#34d399,#22c55e)"></div>
        <div class="mcard-label">Credits Earned</div>
        <div class="mcard-val" style="font-size:26px;letter-spacing:-.5px">${tc}<span style="font-size:16px;color:var(--txm);font-weight:600"> / ${prog}</span></div>
        <div class="mcard-sub">
          <div class="pbar" style="margin:6px 0 4px"><div class="pfill" style="width:${pct.toFixed(1)}%;background:var(--ok)"></div></div>
          ${pct.toFixed(0)}% complete
        </div>
      </div>
      <div class="mcard">
        <div class="mcard-accent" style="background:linear-gradient(90deg,#f59e0b,#fb923c)"></div>
        <div class="mcard-label">Semesters Done</div>
        <div class="mcard-val" style="font-size:26px;letter-spacing:-.5px">${ss.length}<span style="font-size:16px;color:var(--txm);font-weight:600"> / ${tsems}</span></div>
        <div class="mcard-sub">${hasArr ? '<span style="color:var(--er)">⚠ Has arrears</span>' : '<span style="color:var(--ok)">✓ No arrears</span>'} · Distinction eligible: ${cg>=7.5&&!hasArr?'<span style="color:var(--ok)">Yes</span>':'<span style="color:var(--er)">No</span>'}</div>
      </div>
    </div>

    <div class="g2" style="margin-bottom:14px">
      <div class="card" style="margin-bottom:0">
        <div class="ct">GPA Trend</div>
        <canvas id="gc" height="160"></canvas>
      </div>
      <div class="card" style="margin-bottom:0">
        <div class="ct">Grade Distribution</div>
        <canvas id="pc" height="160"></canvas>
      </div>
    </div>

    <div class="card">
      <div class="ct">Performance Heatmap <span style="font-size:11px;font-weight:400;color:var(--txm)">— grade points by course × semester</span></div>
      <div style="overflow-x:auto">
        <table id="heatmap-tbl" style="width:auto;min-width:100%;table-layout:auto;border-collapse:separate;border-spacing:3px">
          <thead><tr><th style="text-align:left;white-space:nowrap;padding:4px 8px">Course / Sem</th>
            ${ss.map(s => `<th style="white-space:nowrap;padding:4px 8px;font-size:11px">${esc(s.name)}</th>`).join('')}
          </tr></thead>
          <tbody>
            ${(()=>{
              const allNames = [...new Set(ss.flatMap(s => s.courses.map(c => c.name)))].sort();
              return allNames.map(name => {
                const cells = ss.map(s => {
                  const c = s.courses.find(x => x.name === name);
                  if (!c) return `<td style="padding:4px 8px;border-radius:4px;background:rgba(255,255,255,.04);color:var(--txm);font-size:12px;text-align:center">—</td>`;
                  const g = gfp(c.pt);
                  return `<td style="padding:4px 8px;border-radius:4px;background:${g.c}22;color:${g.c};font-weight:700;font-size:12px;text-align:center" title="${esc(c.name)}: ${c.grade} (${c.pt} pts)">${c.grade}</td>`;
                }).join('');
                return `<tr><td style="white-space:nowrap;padding:4px 8px;font-size:12px;font-weight:500">${esc(name)}</td>${cells}</tr>`;
              }).join('');
            })()}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="ct">Semester History</div>
      <table>
        <thead><tr><th>Semester</th><th>Courses</th><th>Credits</th><th>SGPA</th><th>CGPA</th><th></th></tr></thead>
        <tbody>
          ${ss.map((s,i) => `
            <tr>
              <td style="font-weight:600">${esc(s.name)}</td>
              <td>${s.courses.length}</td>
              <td>${s.tc}</td>
              <td><span style="font-weight:700;color:${cc(s.sgpa)}">${s.sgpa.toFixed(2)}</span></td>
              <td><span style="font-weight:700">${runCG[i].toFixed(2)}</span></td>
              <td>
                <div style="display:flex;gap:6px">
                  <button class="btn bs bsm" onclick="expandSem('${s.id}')">↕</button>
                  <button class="btn bs bsm" onclick="loadSemForEdit('${s.id}')">✎</button>
                  <button class="btn bd bsm" onclick="delSem('${s.id}')">×</button>
                </div>
              </td>
            </tr>
            <tr id="sx-${s.id}" style="display:none">
              <td colspan="6" style="background:rgba(0,0,0,.2);padding:0">
                <div style="padding:12px">
                  <table>
                    <thead><tr><th>Course</th><th>Credits</th><th>Grade</th><th>Pts</th><th>Marks</th></tr></thead>
                    <tbody>${s.courses.map(c => {
                      const g = gfp(c.pt);
                      return `<tr>
                        <td>${esc(c.name)}</td><td>${c.credits}</td>
                        <td><span style="color:${g.c};font-weight:700">${c.grade}</span></td>
                        <td>${c.pt}</td><td>${c.marks!=null?c.marks+'/100':'—'}</td>
                      </tr>`;
                    }).join('')}</tbody>
                  </table>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    ${cg>=7.5&&!hasArr
      ? `<div class="al as">✓ On track for <strong>First Class with Distinction</strong> (CGPA ≥ 7.5, no arrears)</div>`
      : cg>=6
        ? `<div class="al ai">📈 First Class standing. To get Distinction, reach CGPA ≥ 7.5 with no arrears.</div>`
        : `<div class="al aw">⚠ CGPA is ${cg.toFixed(2)} — use the <strong>CGPA Predictor</strong> to plan your improvement path.</div>`}
  `;

  if (gChart)  { gChart.destroy();  gChart  = null; }
  if (pieChart){ pieChart.destroy(); pieChart = null; }

  const ctx = document.getElementById('gc');
  if (ctx) {
    gChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: ss.map(s => s.name),
        datasets: [
          {label:'SGPA', data:ss.map(s=>+s.sgpa.toFixed(2)), borderColor:'#818cf8', backgroundColor:'rgba(129,140,248,.1)', tension:.4, fill:true, pointRadius:5, pointHoverRadius:7, pointBackgroundColor:'#818cf8'},
          {label:'CGPA', data:runCG, borderColor:'#34d399', backgroundColor:'rgba(52,211,153,.06)', tension:.4, fill:true, pointRadius:5, pointHoverRadius:7, pointBackgroundColor:'#34d399', borderDash:[6,3]}
        ]
      },
      options: {
        responsive:true,
        scales: {
          y: {min:0, max:10, grid:{color:'rgba(255,255,255,.05)'}, ticks:{color:'#64748b', font:{family:'Inter',size:11}}},
          x: {grid:{color:'rgba(255,255,255,.05)'}, ticks:{color:'#64748b', font:{family:'Inter',size:11}}}
        },
        plugins: { legend:{labels:{color:'#94a3b8', font:{family:'Inter',size:12}, boxWidth:12}} }
      }
    });
  }

  // Grade distribution pie
  const pCtx = document.getElementById('pc');
  if (pCtx) {
    const allCourses = ss.flatMap(s => s.courses);
    const gradeCounts = GS.map(g => ({ grade: g.g, color: g.c, count: allCourses.filter(c => c.grade === g.g).length }))
                          .filter(x => x.count > 0);
    pieChart = new Chart(pCtx, {
      type: 'doughnut',
      data: {
        labels: gradeCounts.map(x => `${x.grade} (${x.count})`),
        datasets: [{
          data: gradeCounts.map(x => x.count),
          backgroundColor: gradeCounts.map(x => x.color + 'cc'),
          borderColor: gradeCounts.map(x => x.color),
          borderWidth: 2,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'right', labels: { color: '#94a3b8', font: { family: 'Inter', size: 11 }, boxWidth: 12, padding: 10 } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.label} — ${ctx.raw} course${ctx.raw!==1?'s':''}` } }
        },
        cutout: '62%'
      }
    });
  }
}

function expandSem(id) { const r=document.getElementById('sx-'+id); if(r) r.style.display=r.style.display==='none'?'table-row':'none'; }

function delSem(id) {
  if (!confirm('Delete this semester?')) return;
  const d = gd(); d.semesters = d.semesters.filter(s => s.id !== id); sd(d);
  renderDash(); toast('Semester deleted');
}

// ════════════════════════════════════════════════════════════════════
// INTERNALS CALCULATOR
// ════════════════════════════════════════════════════════════════════
let curTmplId = 'tmpl_theory';
let iCache = {};

function renderInternals() {
  const tmpls = getTmpls();
  let tmpl = tmpls.find(t => t.id === curTmplId) || tmpls[0];
  if (!tmpl) return;
  curTmplId = tmpl.id;

  const sel = document.getElementById('tmpl-sel');
  sel.innerHTML = tmpls.map(t => `<option value="${t.id}" ${t.id===curTmplId?'selected':''}>${esc(t.name)}${t.isDefault?' ★':''}</option>`).join('');

  const totalCIA = tmpl.components.reduce((a,c) => a+(c.ciaMarks||0), 0);
  document.getElementById('tmpl-desc').innerHTML =
    `${tmpl.components.length} component(s) · CIA total: ${totalCIA}/50 · ` +
    tmpl.components.map(c => `${esc(c.name)} (${c.ciaMarks} marks${c.bestOf?`, best ${c.bestOf} of ${c.entries.length}`:''})`).join(' · ');

  document.getElementById('edit-tmpl-btn').disabled = false;
  document.getElementById('del-tmpl-btn').disabled  = !!tmpl.isDefault;

  renderCIAInputs(tmpl);
  computeCIA();
}

function changeTmpl(id) {
  curTmplId = id; iCache = {}; renderInternals();
  document.getElementById('endsem').value = '';
  document.getElementById('int-result').innerHTML = '';
}

function renderCIAInputs(tmpl) {
  const html = tmpl.components.map((comp, ci) => {
    const hasBestOf = comp.bestOf && comp.entries.length > comp.bestOf;
    return `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
          <div>
            <div style="font-weight:700;font-size:14px;margin-bottom:3px">${esc(comp.name)}</div>
            <div style="font-size:11.5px;color:var(--txm)">
              ${hasBestOf?`Best <strong style="color:var(--prl)">${comp.bestOf}</strong> of ${comp.entries.length} counted · `:'All entries counted · '}
              Contributes <strong style="color:var(--prl)">${comp.ciaMarks}</strong> CIA marks
            </div>
          </div>
          <div id="cr-${ci}" style="text-align:right;min-width:90px"></div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${comp.entries.map((e,ei) => `
            <div class="ebox" id="eb-${ci}-${ei}" style="min-width:120px;flex:1">
              <div class="etag" id="et-${ci}-${ei}"></div>
              <div style="font-size:11px;color:var(--txm);font-weight:600;margin-bottom:8px">${esc(e.label)}</div>
              <input type="number" min="0" max="${e.max}" step=".5" placeholder="0–${e.max}"
                id="ei-${ci}-${ei}"
                style="text-align:center;font-size:16px;font-weight:700;background:var(--bg2)"
                value="${iCache[ci+'-'+ei]!==undefined?iCache[ci+'-'+ei]:''}"
                oninput="iCache['${ci}-${ei}']=this.value===''?null:parseFloat(this.value);computeCIA()">
              <div class="emarks" id="em-${ci}-${ei}">—</div>
              <div style="font-size:10px;color:var(--txd);text-align:center">% (out of ${e.max})</div>
            </div>
          `).join('')}
        </div>
      </div>`;
  }).join('');
  document.getElementById('cia-inputs-area').innerHTML = html;
}

function computeComponentContrib(comp, ci) {
  const valid = comp.entries.map((e,ei) => {
    const v = iCache[ci+'-'+ei];
    if (v===null||v===undefined||isNaN(v)) return null;
    return {pct: Math.min(v, e.max)/e.max*100, ei};
  });
  const nonNull = valid.filter(v => v !== null);
  if (!nonNull.length) return null;

  nonNull.forEach(v => {
    const el = document.getElementById('em-'+ci+'-'+v.ei);
    if (el) el.textContent = v.pct.toFixed(1)+'%';
  });
  valid.forEach((v,ei) => {
    if (v === null) { const el = document.getElementById('em-'+ci+'-'+ei); if(el) el.textContent='—'; }
  });

  let selected = nonNull, countedSet = new Set(nonNull.map(v => v.ei));
  if (comp.bestOf && nonNull.length > comp.bestOf) {
    selected    = [...nonNull].sort((a,b) => b.pct-a.pct).slice(0, comp.bestOf);
    countedSet  = new Set(selected.map(v => v.ei));
  }

  comp.entries.forEach((_,ei) => {
    const box = document.getElementById('eb-'+ci+'-'+ei);
    const tag = document.getElementById('et-'+ci+'-'+ei);
    if (!box) return;
    const hasVal = iCache[ci+'-'+ei]!==undefined && iCache[ci+'-'+ei]!==null && !isNaN(iCache[ci+'-'+ei]);
    box.className = 'ebox'; tag.textContent = ''; tag.style.color = '';
    if (hasVal && countedSet.has(ei)) {
      box.className = 'ebox counted';
      if (comp.bestOf && nonNull.length > comp.bestOf) { tag.textContent='✓ counted'; tag.style.color='var(--ok)'; }
    } else if (hasVal && !countedSet.has(ei)) {
      box.className = 'ebox dropped'; tag.textContent='✗ dropped'; tag.style.color='var(--txm)';
    }
  });

  const avgPct = selected.reduce((a,v) => a+v.pct, 0) / selected.length;
  return {contrib: avgPct/100*comp.ciaMarks, avgPct, countedSet};
}

function computeCIA() {
  const tmpls = getTmpls();
  const tmpl  = tmpls.find(t => t.id === curTmplId);
  if (!tmpl) return;

  let totalCIA = 0, anyFilled = false;
  tmpl.components.forEach((comp, ci) => {
    const r  = computeComponentContrib(comp, ci);
    const el = document.getElementById('cr-'+ci);
    if (el) {
      if (r !== null) {
        el.innerHTML = `<span style="font-size:22px;font-weight:800;color:var(--prl)">${r.contrib.toFixed(1)}</span><span style="color:var(--txm);font-size:11px"> / ${comp.ciaMarks}</span>`;
        totalCIA += r.contrib; anyFilled = true;
      } else {
        el.innerHTML = `<span style="color:var(--txm);font-size:11px">— / ${comp.ciaMarks}</span>`;
      }
    }
  });

  const endV  = parseFloat(document.getElementById('endsem')?.value);
  const end   = isNaN(endV) ? null : Math.min(endV, 50);
  const total = anyFilled && end!==null ? totalCIA+end : null;
  const g     = total !== null ? gfm(total) : null;

  let html = '';
  if (anyFilled) {
    html = `<div class="div"></div>
    <div class="g${total!==null?'3':'2'}" style="text-align:center">
      <div>
        <div style="font-size:11px;color:var(--txm);margin-bottom:5px">CIA Total</div>
        <div style="font-size:34px;font-weight:800;color:var(--ok)">${totalCIA.toFixed(1)}</div>
        <div style="font-size:11px;color:var(--txm)">out of 50</div>
      </div>
      ${end!==null?`<div>
        <div style="font-size:11px;color:var(--txm);margin-bottom:5px">End Semester</div>
        <div style="font-size:34px;font-weight:800;color:var(--wn)">${end.toFixed(1)}</div>
        <div style="font-size:11px;color:var(--txm)">out of 50</div>
      </div>`:''}
      ${total!==null?`<div>
        <div style="font-size:11px;color:var(--txm);margin-bottom:5px">Total → Grade</div>
        <div style="font-size:34px;font-weight:800;color:${g.c}">${total.toFixed(1)}</div>
        <div style="font-size:11px;color:${g.c};font-weight:700">${g.g} · ${g.p} pts · ${g.d}</div>
      </div>`:''}
    </div>
    ${total!==null?`
    <div class="pbar" style="margin-top:16px;height:7px">
      <div class="pfill" style="width:${Math.min(total,100)}%;background:${g.c}"></div>
    </div>
    <div style="font-size:11px;color:var(--txm);text-align:center;margin-top:4px">${total.toFixed(1)} / 100</div>`:''}`;
  }
  document.getElementById('int-result').innerHTML = html;
  computeEndNeed(totalCIA, anyFilled);
}

function computeEndNeed(cia, filled) {
  if (cia === undefined) {
    const tmpls = getTmpls(), tmpl = tmpls.find(t => t.id === curTmplId); if (!tmpl) return;
    let tot = 0, f = false;
    tmpl.components.forEach((comp,ci) => { const r=computeComponentContrib(comp,ci); if(r){tot+=r.contrib;f=true} });
    cia = tot; filled = f;
  }
  const tgt = parseInt(document.getElementById('tgt-grade')?.value || 5);
  const tg  = gfp(tgt);
  const needed = Math.max(0, tg.min - cia);
  let html = '';
  if (needed > 50) {
    html = `<div class="al ae">❌ <strong>${tg.g} (${tg.d})</strong> is not achievable — would require ${needed.toFixed(1)}/50 (exceeds maximum). ${filled?`Your CIA: ${cia.toFixed(1)}/50.`:''}</div>`;
  } else {
    const col = needed<=20?'var(--ok)':needed<=38?'var(--wn)':'var(--er)';
    html = `<div class="al ai">
      For <strong>${tg.g} — ${tg.d}</strong>, you need at least <strong style="color:${col}">${needed.toFixed(1)} / 50</strong> in End Sem.
      ${filled?`<br><small style="opacity:.75">CIA: ${cia.toFixed(1)} + End Sem: ${needed.toFixed(1)} = ${(cia+needed).toFixed(1)} ≥ ${tg.min}</small>`:'<br><small style="opacity:.75">Enter your CIA marks above for a personalised calculation.</small>'}
    </div>`;
  }
  document.getElementById('endsem-need').innerHTML = html;
}

// ── Template Modal ────────────────────────────────────────────────
let eTmpl = null;

function openNewTmpl() {
  eTmpl = {id:'tmpl_'+uid(), name:'', isDefault:false, components:[]};
  document.getElementById('modal-title').textContent = 'New Subject Template';
  renderTmplEditor();
  document.getElementById('tmpl-modal').classList.add('open');
}

function openEditTmpl() {
  const t = getTmpls().find(t => t.id === curTmplId); if (!t) return;
  eTmpl = JSON.parse(JSON.stringify(t));
  document.getElementById('modal-title').textContent = 'Edit Template: ' + t.name;
  renderTmplEditor();
  document.getElementById('tmpl-modal').classList.add('open');
}

function closeModal() { document.getElementById('tmpl-modal').classList.remove('open'); eTmpl = null; }

function renderTmplEditor() {
  const total = eTmpl.components.reduce((a,c) => a+(c.ciaMarks||0), 0);
  const tOk   = total === 50;
  document.getElementById('tmpl-editor').innerHTML = `
    <div class="al ${tOk?'as':'aw'}" id="cia-ind">
      CIA components total: <strong>${total} / 50</strong> ${tOk?'✓ Correct':'⚠ Must equal exactly 50'}
    </div>
    <div class="fg">
      <label>Template Name *</label>
      <input type="text" id="te-name" value="${esc(eTmpl.name)}" placeholder="e.g. EC Theory + Lab" oninput="eTmpl.name=this.value">
    </div>
    ${eTmpl.components.map((comp,ci) => `
      <div style="background:var(--sur2);border-radius:var(--rs);padding:14px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span style="font-size:11px;font-weight:700;color:var(--txd)">COMPONENT ${ci+1}</span>
          <button class="btn bd bsm" onclick="rmComp(${ci})">Remove</button>
        </div>
        <div class="g2" style="margin-bottom:10px">
          <div class="fg" style="margin-bottom:0">
            <label>Name</label>
            <input type="text" value="${esc(comp.name)}" placeholder="e.g. Lab Work" oninput="eTmpl.components[${ci}].name=this.value">
          </div>
          <div class="fg" style="margin-bottom:0">
            <label>CIA Marks contributed (must sum to 50)</label>
            <input type="number" min="0" max="50" step="1" value="${comp.ciaMarks}" oninput="eTmpl.components[${ci}].ciaMarks=parseFloat(this.value)||0;refreshCIAInd()">
          </div>
        </div>
        <div class="fg" style="margin-bottom:10px">
          <label>Take best N entries (blank = count all)</label>
          <input type="number" min="1" max="${comp.entries.length}" step="1" value="${comp.bestOf||''}" placeholder="e.g. 2 = best 2 of 3 tests" oninput="eTmpl.components[${ci}].bestOf=this.value?parseInt(this.value):null">
        </div>
        <div style="font-size:10.5px;color:var(--txd);font-weight:700;margin-bottom:7px;text-transform:uppercase;letter-spacing:.07em">Entries (inputs the user fills in)</div>
        ${comp.entries.map((e,ei) => `
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:7px">
            <input type="text" value="${esc(e.label)}" placeholder="Label" oninput="eTmpl.components[${ci}].entries[${ei}].label=this.value" style="flex:2">
            <span style="color:var(--txm);font-size:12px;white-space:nowrap">out of</span>
            <input type="number" min="1" value="${e.max}" oninput="eTmpl.components[${ci}].entries[${ei}].max=parseFloat(this.value)||50" style="flex:1;max-width:80px">
            ${comp.entries.length>1?`<button class="btn bd bsm" onclick="rmEntry(${ci},${ei})">×</button>`:'<span style="width:36px"></span>'}
          </div>
        `).join('')}
        <button class="btn bs bsm" style="margin-top:4px" onclick="eTmpl.components[${ci}].entries.push({label:'Entry '+(eTmpl.components[${ci}].entries.length+1),max:50});renderTmplEditor()">+ Add Entry</button>
      </div>
    `).join('')}
    <button class="btn bs bfw" style="margin-top:4px" onclick="eTmpl.components.push({id:'c'+uid(),name:'New Component',ciaMarks:0,bestOf:null,entries:[{label:'Entry 1',max:50}]});renderTmplEditor()">+ Add Component</button>`;
}

function refreshCIAInd() {
  const total = eTmpl.components.reduce((a,c) => a+(c.ciaMarks||0), 0);
  const el    = document.getElementById('cia-ind');
  if (el) { const ok=total===50; el.className='al '+(ok?'as':'aw'); el.innerHTML=`CIA components total: <strong>${total} / 50</strong> ${ok?'✓ Correct':'⚠ Must equal exactly 50'}`; }
}

function rmComp(ci)       { eTmpl.components.splice(ci,1); renderTmplEditor(); }
function rmEntry(ci,ei)   { eTmpl.components[ci].entries.splice(ei,1); renderTmplEditor(); }

function saveTmpl() {
  if (!eTmpl.name.trim())              { toast('Template name is required','err'); return; }
  const tot = eTmpl.components.reduce((a,c) => a+(c.ciaMarks||0), 0);
  if (tot !== 50)                      { toast(`CIA marks must total 50 (currently ${tot})`,'err'); return; }
  if (!eTmpl.components.length)        { toast('Add at least one component','err'); return; }
  for (const comp of eTmpl.components) {
    if (!comp.entries.length)          { toast(`Component "${comp.name}" has no entries`,'err'); return; }
    if (comp.bestOf && comp.bestOf >= comp.entries.length) { toast(`"${comp.name}": Best-of N must be < number of entries`,'err'); return; }
  }
  const d = gd(); if (!d.templates) d.templates = [];
  const idx = d.templates.findIndex(t => t.id === eTmpl.id);
  if (idx >= 0) d.templates[idx] = {...eTmpl}; else d.templates.push({...eTmpl});
  sd(d); curTmplId = eTmpl.id; iCache = {};
  closeModal(); renderInternals(); renderTmplSettings(); toast('Template saved!');
}

function delTmpl() {
  const t = getTmpls().find(x => x.id === curTmplId);
  if (!t || t.isDefault) { toast("Can't delete built-in templates",'warn'); return; }
  if (!confirm('Delete template "'+t.name+'"?')) return;
  const d = gd(); d.templates = d.templates.filter(x => x.id !== curTmplId);
  curTmplId = (d.templates[0]||{}).id || 'tmpl_theory'; iCache = {};
  sd(d); renderInternals(); renderTmplSettings(); toast('Template deleted');
}

function renderTmplSettings() {
  const tmpls = getTmpls();
  document.getElementById('tmpl-list-settings').innerHTML = `
    <table>
      <thead><tr><th>Template</th><th>Components</th><th>Type</th><th></th></tr></thead>
      <tbody>${tmpls.map(t => `<tr>
        <td style="font-weight:600">${esc(t.name)}</td>
        <td style="font-size:12px;color:var(--txm)">${t.components.map(c=>`${esc(c.name)} (${c.ciaMarks}m)`).join(', ')}</td>
        <td>${t.isDefault?'<span class="bdg bn">Built-in</span>':'<span class="bdg bk">Custom</span>'}</td>
        <td>${!t.isDefault?`<button class="btn bd bsm" onclick="delTmplById('${t.id}')">Delete</button>`:'—'}</td>
      </tr>`).join('')}</tbody>
    </table>
    <button class="btn bp2" style="margin-top:13px" onclick="goTab('internals');openNewTmpl()">+ New Template</button>`;
}

function delTmplById(id) {
  const d = gd(), t = d.templates?.find(x => x.id === id);
  if (!t || t.isDefault) { toast("Can't delete built-in templates",'warn'); return; }
  if (!confirm('Delete "'+t.name+'"?')) return;
  d.templates = d.templates.filter(x => x.id !== id);
  if (curTmplId === id) curTmplId = (d.templates[0]||{}).id || 'tmpl_theory';
  sd(d); renderTmplSettings(); toast('Deleted');
}

// ════════════════════════════════════════════════════════════════════
// SEMESTER MANAGER
// ════════════════════════════════════════════════════════════════════
let courses = [];
let editingSemId = null;
let editingCourseId = null;

function loadSemForEdit(id) {
  const d = gd(), sem = d.semesters.find(s => s.id === id);
  if (!sem) return;
  editingSemId = id;
  courses = sem.courses.map(c => ({...c}));
  goTab('semester');
  const sel = document.getElementById('sem-sel');
  if (sel) sel.value = sem.name;
  renderCourseList();
  renderEditBanner();
}

function renderEditBanner() {
  const existing = document.getElementById('edit-banner');
  if (existing) existing.remove();
  if (!editingSemId) return;
  const d = gd(), sem = d.semesters.find(s => s.id === editingSemId);
  if (!sem) return;
  const banner = document.createElement('div');
  banner.id = 'edit-banner';
  banner.className = 'al aw';
  banner.style.marginBottom = '14px';
  banner.innerHTML = `✎ Editing <strong>${esc(sem.name)}</strong> — modify courses below, then click Save Semester.
    <button class="btn bs bsm" style="margin-left:10px;vertical-align:middle" onclick="cancelEdit()">Cancel</button>`;
  const semTab = document.getElementById('tab-semester');
  semTab.insertBefore(banner, semTab.querySelector('.card'));
}

function cancelEdit() {
  editingSemId = null;
  courses = [];
  renderCourseList();
  const b = document.getElementById('edit-banner');
  if (b) b.remove();
}

function toggleCM() {
  const m = document.getElementById('cm').value;
  document.getElementById('cm-marks').style.display = m==='marks'?'block':'none';
  document.getElementById('cm-grade').style.display = m==='grade'?'block':'none';
}

function prevGrade() {
  const v = parseFloat(document.getElementById('cmk').value);
  if (isNaN(v)) { document.getElementById('gprev').innerHTML=''; return; }
  const g = gfm(Math.min(v,100));
  document.getElementById('gprev').innerHTML = `
    <div style="display:inline-flex;align-items:center;gap:9px;background:var(--sur2);padding:7px 14px;border-radius:var(--rs);margin-top:6px;margin-bottom:6px">
      <span style="font-size:22px;font-weight:800;color:${g.c}">${g.g}</span>
      <span style="color:var(--txm);font-size:12px">${g.p} pts · ${g.d}</span>
    </div>`;
}

function addCourse() {
  const name = document.getElementById('cn').value.trim();
  const cred = parseInt(document.getElementById('cc').value);
  const meth = document.getElementById('cm').value;
  if (!name)            { toast('Enter course name','err'); return; }
  if (!cred || cred<1) { toast('Enter valid credits','err'); return; }
  let pt, marks=null, grade;
  if (meth === 'marks') {
    marks = parseFloat(document.getElementById('cmk').value);
    if (isNaN(marks)||marks<0||marks>100) { toast('Enter valid marks (0–100)','err'); return; }
    const g = gfm(marks); pt=g.p; grade=g.g;
  } else {
    pt = parseInt(document.getElementById('cgs').value); grade = gfp(pt).g;
  }
  courses.push({id:uid(), name, credits:cred, pt, marks, grade});
  document.getElementById('cn').value=''; document.getElementById('cmk').value='';
  document.getElementById('gprev').innerHTML='';
  renderCourseList();
}

function rmCourse(id) { courses = courses.filter(c => c.id !== id); renderCourseList(); }

function renderCourseList() {
  const el = document.getElementById('clist');
  if (!courses.length) {
    el.innerHTML = '<p style="color:var(--txm);font-size:13px;padding:8px 0">No courses added yet.</p>';
    document.getElementById('sgpa-prev').innerHTML = '';
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>Course</th><th>Credits</th><th>Grade</th><th>Pts</th><th>Marks</th><th></th></tr></thead>
      <tbody>${courses.map(c => {
        const g = gfp(c.pt);
        if (editingCourseId === c.id) {
          const gradeOpts = GS.map(gs => `<option value="${gs.p}" ${c.pt===gs.p?'selected':''}>${gs.g} — ${gs.p} pts</option>`).join('');
          return `<tr style="background:rgba(99,102,241,.07)">
            <td><input type="text" id="ec-name" value="${esc(c.name)}" style="font-size:12px;padding:5px 8px;width:100%"></td>
            <td><input type="number" id="ec-cred" value="${c.credits}" min="1" max="6" style="font-size:12px;padding:5px 8px;width:60px"></td>
            <td colspan="3">
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <select id="ec-mode" onchange="toggleEditMode()" style="font-size:12px;padding:5px 8px;width:auto">
                  <option value="marks" ${c.marks!=null?'selected':''}>Marks (/100)</option>
                  <option value="grade" ${c.marks==null?'selected':''}>Grade</option>
                </select>
                <div id="ec-marks-area" style="${c.marks!=null?'display:flex;align-items:center;gap:8px':'display:none'}">
                  <input type="number" id="ec-marks" value="${c.marks!=null?c.marks:''}" min="0" max="100" step=".5" style="font-size:12px;padding:5px 8px;width:75px" oninput="previewEditGrade()">
                  <span id="ec-grade-preview" style="font-size:12px"></span>
                </div>
                <div id="ec-grade-area" style="${c.marks==null?'':'display:none'}">
                  <select id="ec-grade" style="font-size:12px;padding:5px 8px;width:auto">${gradeOpts}</select>
                </div>
              </div>
            </td>
            <td>
              <div style="display:flex;gap:5px">
                <button class="btn bp2 bsm" onclick="saveEditCourse('${c.id}')">✓</button>
                <button class="btn bs bsm" onclick="cancelEditCourse()">✕</button>
              </div>
            </td>
          </tr>`;
        }
        return `<tr>
          <td style="font-weight:500">${esc(c.name)}</td>
          <td>${c.credits}</td>
          <td><span style="color:${g.c};font-weight:700">${c.grade}</span></td>
          <td>${c.pt}</td>
          <td>${c.marks!=null?c.marks+'/100':'—'}</td>
          <td>
            <div style="display:flex;gap:5px">
              <button class="btn bs bsm" onclick="startEditCourse('${c.id}')">✎</button>
              <button class="btn bd bsm" onclick="rmCourse('${c.id}')">×</button>
            </div>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  const s   = sgpa(courses), tc = courses.reduce((a,c) => a+c.credits, 0);
  const cls = classify(s, courses.some(c => c.pt === 0));
  document.getElementById('sgpa-prev').innerHTML = `
    <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap">
      <div>
        <div style="font-size:10px;color:var(--txd);font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">SGPA</div>
        <div style="font-size:36px;font-weight:800;letter-spacing:-1px;color:${cc(s)}">${s.toFixed(2)}</div>
      </div>
      <div>
        <div style="font-size:10px;color:var(--txd);font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Credits</div>
        <div style="font-size:28px;font-weight:700">${tc}</div>
      </div>
      <span class="bdg ${cls.b}">${cls.l}</span>
    </div>`;
}

function startEditCourse(id) {
  editingCourseId = id;
  renderCourseList();
  previewEditGrade();
}

function cancelEditCourse() {
  editingCourseId = null;
  renderCourseList();
}

function toggleEditMode() {
  const mode = document.getElementById('ec-mode').value;
  document.getElementById('ec-marks-area').style.display = mode==='marks' ? 'flex' : 'none';
  document.getElementById('ec-grade-area').style.display = mode==='grade' ? ''    : 'none';
}

function previewEditGrade() {
  const v  = parseFloat(document.getElementById('ec-marks')?.value);
  const el = document.getElementById('ec-grade-preview');
  if (!el) return;
  if (isNaN(v)) { el.textContent=''; return; }
  const g = gfm(Math.min(v, 100));
  el.innerHTML = `→ <span style="color:${g.c};font-weight:700">${g.g}</span> (${g.p} pts)`;
}

function saveEditCourse(id) {
  const name = document.getElementById('ec-name')?.value.trim();
  const cred = parseInt(document.getElementById('ec-cred')?.value);
  const mode = document.getElementById('ec-mode')?.value;
  if (!name)           { toast('Course name required','err'); return; }
  if (!cred || cred<1) { toast('Invalid credits','err'); return; }
  let pt, marks=null, grade;
  if (mode === 'marks') {
    marks = parseFloat(document.getElementById('ec-marks')?.value);
    if (isNaN(marks)||marks<0||marks>100) { toast('Enter valid marks (0–100)','err'); return; }
    const g = gfm(marks); pt=g.p; grade=g.g;
  } else {
    pt = parseInt(document.getElementById('ec-grade')?.value); grade=gfp(pt).g;
  }
  const idx = courses.findIndex(c => c.id === id);
  if (idx >= 0) courses[idx] = {...courses[idx], name, credits:cred, pt, marks, grade};
  editingCourseId = null;
  renderCourseList();
  toast('Course updated');
}

function saveSem() {
  if (!courses.length) { toast('Add at least one course','err'); return; }
  const nm = document.getElementById('sem-sel').value;
  const d  = gd();
  const keepId = editingSemId || null;
  d.semesters = d.semesters.filter(s => editingSemId ? s.id !== editingSemId : s.name !== nm);
  d.semesters.push({id: keepId || uid(), name:nm, courses:[...courses], sgpa:sgpa(courses), tc:courses.reduce((a,c)=>a+c.credits,0)});
  d.semesters.sort((a,b) => (parseInt(a.name.replace(/\D/g,''))||0) - (parseInt(b.name.replace(/\D/g,''))||0));
  sd(d);
  editingSemId = null;
  courses = [];
  renderCourseList();
  const b = document.getElementById('edit-banner');
  if (b) b.remove();
  toast(nm + ' saved!');
}

function clearSem() { courses=[]; renderCourseList(); }

// ════════════════════════════════════════════════════════════════════
// CGPA PREDICTOR
// ════════════════════════════════════════════════════════════════════
let plannedCourses = [];
let arrearOverrides = {}; // key: `${semId}-${courseId}` → gradePoint override
let arrearCIA = {};       // key: `${semId}-${courseId}` → CIA marks entered

function renderPred() {
  const d   = gd(), ss = d.semesters, cg = cgpa(ss);
  const tc  = ss.reduce((a,s) => a+s.tc, 0);
  const tsems = programmeRules(d.profile.programme).semesters;
  const curSem = d.profile.currentSem || Math.min(ss.length+1, tsems);
  const rem  = Math.max(0, tsems - curSem);

  plannedCourses  = d.plannedCourses  || [];
  arrearOverrides = d.arrearOverrides || {};

  if (!ss.length) {
    document.getElementById('pred-cur').innerHTML   = '<p style="color:var(--txm)">No semester data yet.</p>';
    document.getElementById('pred-res').innerHTML   = '';
    document.getElementById('arrear-sim').innerHTML = '';
    document.getElementById('sem-planner').innerHTML= '';
    return;
  }

  // ── Current Standing ──────────────────────────────────────────
  const semOpts = Array.from({length:tsems},(_,i) =>
    `<option value="${i+1}" ${curSem===i+1?'selected':''}>Semester ${i+1}</option>`
  ).join('');

  document.getElementById('pred-cur').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px">
      <div>
        <div style="font-size:10px;color:var(--txd);font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Current CGPA</div>
        <div style="font-size:42px;font-weight:800;letter-spacing:-1.5px;color:${cc(cg)}">${cg.toFixed(2)}</div>
      </div>
      <div style="display:flex;gap:20px">
        <div><div style="color:var(--txd);font-size:11px;margin-bottom:2px">Credits earned</div><div style="font-weight:700;font-size:13px">${tc}</div></div>
        <div><div style="color:var(--txd);font-size:11px;margin-bottom:2px">Semesters left</div><div style="font-weight:700;font-size:13px">${rem}</div></div>
      </div>
      <div>
        <label style="margin-bottom:6px">You are currently in</label>
        <select onchange="saveCurrentSem(this.value)" style="width:auto">${semOpts}</select>
      </div>
    </div>`;

  renderArrearSim(ss, cg, tc);
  renderSemPlanner(d, ss, curSem, cg, tc);
  computePred();
}

function saveCurrentSem(val) {
  const d = gd(); d.profile.currentSem = parseInt(val); sd(d); renderPred();
}

// ── Arrear Clearance Simulator ─────────────────────────────────
function renderArrearSim(ss, baseCG, baseTC) {
  const el = document.getElementById('arrear-sim');
  const d  = gd();
  arrearCIA = d.arrearCIA || {};

  const arrears = [];
  ss.forEach(sem => sem.courses.forEach(c => {
    if (c.pt === 0) arrears.push({semId:sem.id, semName:sem.name, courseId:c.id, courseName:c.name, credits:c.credits});
  }));

  if (!arrears.length) { el.innerHTML=''; return; }

  const simCG = computeSimCGPA(ss, arrearOverrides);
  const diff  = simCG - baseCG;
  const hasOverrides = Object.keys(arrearOverrides).length > 0;

  el.innerHTML = `
    <div class="card">
      <div class="ct">Arrear Clearance Simulator</div>
      <div class="al ai" style="margin-bottom:14px">
        ℹ <strong>SASTRA rule:</strong> CIA marks below 25/50 are automatically raised to 25 for your arrear attempt.
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:16px">
        ${arrears.map(a => {
          const key     = `${a.semId}-${a.courseId}`;
          const on      = arrearOverrides[key] !== undefined;
          const gpt     = arrearOverrides[key] || 5;
          const entered = arrearCIA[key];
          const gradeOpts = GS.filter(g=>g.p>0).map(g=>`<option value="${g.p}" ${gpt===g.p?'selected':''}>${g.g} — ${g.p} pts</option>`).join('');
          return `
            <div style="background:${on?'rgba(34,197,94,.04)':'rgba(255,255,255,.025)'};border:1px solid ${on?'rgba(34,197,94,.25)':'var(--bdr)'};border-radius:var(--r);padding:14px;transition:all .2s">
              <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">
                <input type="checkbox" ${on?'checked':''} style="width:16px;height:16px;accent-color:var(--ok);cursor:pointer;flex-shrink:0"
                  onchange="toggleArrear('${key}',this.checked)">
                <div style="flex:1;min-width:120px">
                  <div style="font-size:13px;font-weight:600">${esc(a.courseName)}</div>
                  <div style="font-size:11px;color:var(--txm)">${esc(a.semName)} · ${a.credits} credits</div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;${on?'':'opacity:.35;pointer-events:none'}">
                  <span style="font-size:12px;color:var(--er);font-weight:700">F →</span>
                  <select style="font-size:12px;padding:5px 8px;width:auto" ${on?'':'disabled'}
                    onchange="setArrearGrade('${key}',parseInt(this.value))">${gradeOpts}</select>
                </div>
              </div>
              <div style="background:rgba(0,0,0,.2);border-radius:var(--rs);padding:12px">
                <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                  <div>
                    <label style="font-size:10px;color:var(--txd);text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px">CIA Marks (out of 50)</label>
                    <input type="number" min="0" max="50" step=".5" placeholder="0–50"
                      value="${entered !== undefined ? entered : ''}"
                      style="width:80px;font-size:14px;font-weight:700;padding:7px 10px;background:var(--bg2)"
                      oninput="updateArrearCIA('${key}',this.value)">
                  </div>
                  <div id="cia-disp-${key}" style="flex:1;min-width:180px">
                    ${entered !== undefined ? ciaPillsHTML(entered) : '<span style="font-size:12px;color:var(--txd)">Enter CIA marks to see End Sem requirements</span>'}
                  </div>
                </div>
              </div>
            </div>`;
        }).join('')}
      </div>
      ${hasOverrides ? `
        <div style="display:flex;align-items:center;gap:20px;padding:14px;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.2);border-radius:var(--rs);flex-wrap:wrap">
          <div>
            <div style="font-size:10px;color:var(--txd);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Current CGPA</div>
            <div style="font-size:30px;font-weight:800;color:${cc(baseCG)}">${baseCG.toFixed(2)}</div>
          </div>
          <div style="font-size:22px;color:var(--txd)">→</div>
          <div>
            <div style="font-size:10px;color:var(--txd);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">If toggled arrears cleared</div>
            <div style="font-size:30px;font-weight:800;color:${cc(simCG)}">${simCG.toFixed(2)}</div>
          </div>
          <div>
            <span class="bdg ${diff>0?'bk':diff<0?'br':'bn'}">${diff>0?'▲ +':'▼ '}${Math.abs(diff).toFixed(2)} pts</span>
            ${simCG>=7.5&&baseCG<7.5?`<div style="font-size:11px;color:var(--ok);margin-top:5px">🎉 Distinction becomes achievable!</div>`:''}
          </div>
        </div>` : ''}
    </div>`;
}

// Build the "effective CIA + End Sem needed" display HTML
function ciaPillsHTML(entered) {
  const effective = Math.max(parseFloat(entered), 25);
  const applied   = parseFloat(entered) < 25;
  const pills = GS.filter(g=>g.p>0).map(g => {
    const need = g.min - effective;
    if (need > 50) return `<span style="color:var(--txd);font-size:11px;opacity:.6">${g.g}: —</span>`;
    if (need <= 0) return `<span style="background:var(--oka);color:var(--ok);padding:2px 7px;border-radius:999px;font-size:11px;font-weight:600">${g.g} ✓</span>`;
    const col = need<=25?'var(--ok)':need<=40?'var(--wn)':'var(--er)';
    return `<span style="background:rgba(255,255,255,.05);padding:2px 7px;border-radius:999px;font-size:11px;font-weight:600"><span style="color:${g.c}">${g.g}</span>: <span style="color:${col}">${Math.ceil(need)}/50</span></span>`;
  }).join('');
  return `
    <div style="display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap">
      <div>
        <div style="font-size:10px;color:var(--txd);text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px">Effective CIA</div>
        <div style="font-size:20px;font-weight:800;color:${applied?'var(--wn)':'var(--ok)'}">
          ${effective}/50
          ${applied?`<span style="font-size:10px;color:var(--wn);font-weight:400;margin-left:5px">↑ raised to 25</span>`:''}
        </div>
      </div>
      <div style="flex:1;min-width:160px">
        <div style="font-size:10px;color:var(--txd);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">End Sem needed for each grade</div>
        <div style="display:flex;flex-wrap:wrap;gap:5px">${pills}</div>
      </div>
    </div>`;
}

// Called on every keystroke — only updates the display div, no re-render (preserves input focus)
function updateArrearCIA(key, val) {
  const d = gd();
  if (!d.arrearCIA) d.arrearCIA = {};
  const num = parseFloat(val);
  const disp = document.getElementById('cia-disp-'+key);
  if (val==='' || isNaN(num)) {
    delete d.arrearCIA[key];
    delete arrearCIA[key];
    if (disp) disp.innerHTML = '<span style="font-size:12px;color:var(--txd)">Enter CIA marks to see End Sem requirements</span>';
  } else {
    const v = Math.min(Math.max(num, 0), 50);
    d.arrearCIA[key] = v;
    arrearCIA[key]   = v;
    if (disp) disp.innerHTML = ciaPillsHTML(v);
  }
  sd(d);
}

function computeSimCGPA(ss, overrides) {
  if (!Object.keys(overrides).length) return cgpa(ss);
  return cgpa(ss.map(sem => {
    const modCourses = sem.courses.map(c => {
      const key = `${sem.id}-${c.id}`;
      if (overrides[key] !== undefined) { const p=overrides[key]; return {...c, pt:p, grade:gfp(p).g}; }
      return c;
    });
    return {...sem, courses:modCourses, sgpa:sgpa(modCourses)};
  }));
}

function toggleArrear(key, checked) {
  if (checked) arrearOverrides[key]=5; else delete arrearOverrides[key];
  const d=gd(); d.arrearOverrides=arrearOverrides; sd(d);
  const ss=d.semesters; renderArrearSim(ss,cgpa(ss),ss.reduce((a,s)=>a+s.tc,0));
}
function setArrearGrade(key, pt) {
  arrearOverrides[key]=pt;
  const d=gd(); d.arrearOverrides=arrearOverrides; sd(d);
  const ss=d.semesters; renderArrearSim(ss,cgpa(ss),ss.reduce((a,s)=>a+s.tc,0));
}

// ── Next Semester Planner ──────────────────────────────────────
function renderSemPlanner(d, ss, curSem, baseCG, baseTC) {
  const el = document.getElementById('sem-planner');
  const tsems = programmeRules(d.profile.programme).semesters;
  const planSemNum = ss.some(s=>s.name===`Semester ${curSem}`) ? curSem+1 : curSem;
  if (planSemNum > tsems) { el.innerHTML=''; return; }

  const pc = plannedCourses;
  let projSGPA=null, projCGPA=null, projTC=0;
  if (pc.length) {
    projSGPA = sgpa(pc);
    projTC   = pc.reduce((a,c)=>a+c.credits,0);
    projCGPA = (baseCG*baseTC + projSGPA*projTC)/(baseTC+projTC);
  }

  const gradeOpts = GS.map(g=>`<option value="${g.p}">${g.g} — ${g.p} pts (${g.d})</option>`).join('');

  el.innerHTML = `
    <div class="card">
      <div class="ct">Semester ${planSemNum} Planner</div>
      <p style="font-size:13px;color:var(--txm);margin-bottom:14px">
        Add expected courses to project your SGPA and CGPA for Semester ${planSemNum}.
      </p>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px">
        <div style="flex:2;min-width:150px">
          <label>Course Name</label>
          <input type="text" id="plan-cn" placeholder="e.g. VLSI Design">
        </div>
        <div>
          <label>Credits</label>
          <input type="number" id="plan-cc" min="1" max="6" value="3" style="width:70px">
        </div>
        <div>
          <label>Expected Grade</label>
          <select id="plan-cg" style="width:auto">${gradeOpts}</select>
        </div>
        <button class="btn bp2" onclick="addPlannedCourse()">+ Add</button>
      </div>
      ${pc.length ? `
        <table style="margin-bottom:14px">
          <thead><tr><th>Course</th><th>Credits</th><th>Expected Grade</th><th>Pts</th><th></th></tr></thead>
          <tbody>${pc.map(c=>{const g=gfp(c.pt);return`<tr>
            <td style="font-weight:500">${esc(c.name)}</td><td>${c.credits}</td>
            <td><span style="color:${g.c};font-weight:700">${g.g}</span></td><td>${c.pt}</td>
            <td><button class="btn bd bsm" onclick="rmPlannedCourse('${c.id}')">×</button></td>
          </tr>`;}).join('')}</tbody>
        </table>
        <div style="padding:16px;background:rgba(99,102,241,.07);border:1px solid rgba(99,102,241,.2);border-radius:var(--rs);display:flex;gap:24px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
          <div>
            <div style="font-size:10px;color:var(--txd);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Projected SGPA (Sem ${planSemNum})</div>
            <div style="font-size:30px;font-weight:800;color:${cc(projSGPA)}">${projSGPA.toFixed(2)}</div>
          </div>
          <div style="font-size:20px;color:var(--txd)">→</div>
          <div>
            <div style="font-size:10px;color:var(--txd);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Projected CGPA</div>
            <div style="font-size:30px;font-weight:800;color:${cc(projCGPA)}">${projCGPA.toFixed(2)}</div>
            <div style="margin-top:5px"><span class="bdg ${classify(projCGPA,false).b}">${classify(projCGPA,false).l}</span></div>
          </div>
        </div>
        <button class="btn bs bsm" onclick="clearPlannedCourses()">Clear Plan</button>
      ` : '<p style="font-size:13px;color:var(--txm)">Add expected courses above to see your projected CGPA.</p>'}
    </div>`;
}

function addPlannedCourse() {
  const name = document.getElementById('plan-cn')?.value.trim();
  const cred = parseInt(document.getElementById('plan-cc')?.value);
  const pt   = parseInt(document.getElementById('plan-cg')?.value);
  if (!name)           { toast('Enter course name','err'); return; }
  if (!cred || cred<1) { toast('Invalid credits','err'); return; }
  plannedCourses.push({id:uid(), name, credits:cred, pt, grade:gfp(pt).g});
  const d=gd(); d.plannedCourses=plannedCourses; sd(d);
  document.getElementById('plan-cn').value='';
  renderPred();
}
function rmPlannedCourse(id) {
  plannedCourses=plannedCourses.filter(c=>c.id!==id);
  const d=gd(); d.plannedCourses=plannedCourses; sd(d); renderPred();
}
function clearPlannedCourses() {
  plannedCourses=[];
  const d=gd(); d.plannedCourses=[]; sd(d); renderPred();
}

// ── Target CGPA Section ────────────────────────────────────────
function computePred() {
  const d = gd(), ss = d.semesters; if (!ss.length) return;
  const cg  = cgpa(ss), tc = ss.reduce((a,s)=>a+s.tc,0);
  const tsems = programmeRules(d.profile.programme).semesters;
  const curSem = d.profile.currentSem || Math.min(ss.length+1, tsems);
  const rem  = Math.max(0, tsems-curSem);
  const tgt  = parseFloat(document.getElementById('tgt-cgpa')?.value||7.5);
  const cps  = parseInt(document.getElementById('cps')?.value||22);

  if (rem === 0) {
    document.getElementById('pred-res').innerHTML=`<div class="al ai">All semesters done! Final CGPA: <strong>${cg.toFixed(2)}</strong></div>`;
    return;
  }
  const remC=rem*cps, needed=(tgt*(tc+remC)-cg*tc)/remC;
  const nCol = needed>10?'var(--er)':needed<=7?'var(--ok)':needed<=8.5?'var(--wn)':'var(--er)';
  const nBdg = needed>10?'<span class="bdg br">Not achievable</span>':
    needed<=7 ?'<span class="bdg bk">✓ Very achievable</span>':
    needed<=8.5?'<span class="bdg bb">Achievable with effort</span>':
    needed<=9.5?'<span class="bdg bg">Challenging</span>':'<span class="bdg br">Extremely difficult</span>';

  const scenarios=[{t:7.5,l:'First Class with Distinction',b:'bg'},{t:6.0,l:'First Class',b:'bb'},{t:5.0,l:'Second Class',b:'bp'}];
  const scRows=scenarios.map(sc=>{
    const r=(sc.t*(tc+remC)-cg*tc)/remC, ok=r<=10;
    const col=ok?(r<=7?'var(--ok)':r<=8.5?'var(--wn)':'var(--er)'):'var(--er)';
    return`<tr>
      <td><span class="bdg ${sc.b}">${sc.l}</span></td><td>≥ ${sc.t}</td>
      <td style="font-weight:700;color:${col}">${ok?r.toFixed(2)+' avg SGPA':'Not achievable'}</td>
      <td>${!ok?'✗':r<=7?'✓ Easy':r<=8.5?'⚠ Manageable':r<=10?'⚠ Very hard':'✗'}</td>
    </tr>`;
  }).join('');

  const planRows=Array.from({length:rem},(_,i)=>{
    const sc=tc+(i+1)*cps;
    const pCG=Math.min((cg*tc+Math.min(needed,10)*(i+1)*cps)/sc,10);
    const cls=classify(pCG,false);
    return`<tr>
      <td>Semester ${curSem+i+1}</td>
      <td style="font-weight:700;color:${needed>10?'var(--er)':nCol}">${Math.min(needed,10).toFixed(2)}</td>
      <td style="font-weight:700">${pCG.toFixed(2)}</td>
      <td><span class="bdg ${cls.b}">${cls.l}</span></td>
    </tr>`;
  }).join('');

  document.getElementById('pred-res').innerHTML=`
    <div class="card">
      <div class="ct">Required for CGPA ${tgt} — ${rem} semesters left</div>
      ${needed>10
        ?`<div class="al ae">❌ CGPA ${tgt} is <strong>mathematically impossible</strong> — would need ${needed.toFixed(2)} avg SGPA across ${rem} remaining sems at ${cps} credits each.</div>`
        :`<div style="text-align:center;padding:16px 0">
            <div style="font-size:11px;color:var(--txd);text-transform:uppercase;letter-spacing:.09em;margin-bottom:10px">Average SGPA Needed</div>
            <div style="font-size:62px;font-weight:900;letter-spacing:-2px;color:${nCol}">${needed.toFixed(2)}</div>
            <div style="color:var(--txm);font-size:12px;margin-top:6px">across ${rem} remaining semester(s) at ${cps} credits/sem</div>
            <div style="margin-top:12px">${nBdg}</div>
           </div>`}
    </div>
    <div class="card">
      <div class="ct">All Classifications</div>
      <table><thead><tr><th>Classification</th><th>Requirement</th><th>Avg SGPA Needed</th><th>Feasibility</th></tr></thead>
      <tbody>${scRows}</tbody></table>
    </div>
    <div class="card">
      <div class="ct">Semester-by-Semester Projection</div>
      <table><thead><tr><th>Semester</th><th>Target SGPA</th><th>Projected CGPA</th><th>Classification</th></tr></thead>
      <tbody>${planRows}</tbody></table>
    </div>`;
}

// ════════════════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════════════════
function loadProfile() {
  const p = gd().profile;
  document.getElementById('pn').value = p.name   || '';
  document.getElementById('pb').value = p.branch  || 'Electronics & Communication Engineering';
  document.getElementById('py').value = p.batch   || '';
  document.getElementById('pp').value = p.programme || 'btech';
}

function saveProfile() {
  const d = gd();
  d.profile.name      = document.getElementById('pn').value.trim();
  d.profile.branch    = document.getElementById('pb').value.trim();
  d.profile.batch     = document.getElementById('py').value.trim();
  d.profile.programme = document.getElementById('pp').value;
  sd(d);
  renderUserArea();
  toast('Profile saved!');
}

function exportData() {
  const b = new Blob([JSON.stringify(gd(),null,2)], {type:'application/json'});
  const url = URL.createObjectURL(b);
  const a = document.createElement('a'); a.href=url;
  a.download='sastra_tracker_backup.json'; a.click();
  URL.revokeObjectURL(url);
}

function importData(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    try {
      const imported = normalizeData(JSON.parse(ev.target.result));
      if (!Array.isArray(imported.semesters)) throw new Error('Missing semester data');
      sd(imported);
      toast('Imported!');
      renderDash();
      renderUserArea();
      if (document.getElementById('tab-settings').classList.contains('on')) {
        loadProfile(); renderTmplSettings();
      }
    } catch(e) {
      toast('Invalid backup file', 'err');
    } finally {
      e.target.value = '';
    }
  };
  r.readAsText(f);
}

function clearAll() {
  if (!confirm('Delete ALL data? This cannot be undone.')) return;
  sd(mk());
  toast('Cleared');
  renderDash();
  renderUserArea();
}

// ── Init ──────────────────────────────────────────────────────────
renderUserArea();
renderDash();
renderCourseList();
