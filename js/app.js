/* ============================================================
   ⚽ مونديال العيلة 26 — منطق التطبيق
   ============================================================ */
'use strict';

/* ---------- أدوات مساعدة ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const dtDay = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });
const dtTime = new Intl.DateTimeFormat('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (iso) => dtDay.format(new Date(iso));
const fmtTime = (iso) => dtTime.format(new Date(iso));

const STAGES = { group: 'دور المجموعات', r32: 'دور الـ32', r16: 'دور الـ16', qf: 'ربع النهائي', sf: 'نصف النهائي', third: 'المركز الثالث', final: 'النهائي' };
const LOCK_MARGIN_MS = 60 * 1000;          // الواجهة تقفل قبل البداية بدقيقة (والسيرفر يقفل عند البداية)
const LIVE_WINDOW_MS = 165 * 60 * 1000;    // بعدها المباراة "بانتظار النتيجة" بدل "جارية"
const CACHE_KEY = 'wc26-cache-v1';

/* بحث ذكي بالعربي: يتجاهل الهمزات والتشكيل و"ال" التعريف والمسافات وأخطاء الكتابة الشائعة */
function normAr(s) {
  return String(s || '')
    .replace(/[ً-ْٰـ]/g, '')  // تشكيل وتطويل
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ئ/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, '')
    .toLowerCase();
}
function teamSearchMatch(team, q) {
  const raw = String(q || '').trim();
  if (!raw) return true;
  const nq = normAr(raw);
  const name = normAr(team.name_ar);
  const nameNoAl = name.replace(/^ال/, '');
  const nqNoAl = nq.replace(/^ال/, '');
  return name.includes(nq) || nameNoAl.includes(nq)
      || name.includes(nqNoAl) || nameNoAl.includes(nqNoAl)
      || team.code.toLowerCase().includes(raw.toLowerCase());
}
function teamSearchRank(team, q) {
  const nq = normAr(q).replace(/^ال/, '');
  const name = normAr(team.name_ar).replace(/^ال/, '');
  return name.startsWith(nq) ? 0 : 1;
}

/* الأعلام كصور — لأن ويندوز ما بيعرض إيموجي الأعلام (🇨🇦 وأخواتها) */
function flagToIso2(emoji) {
  const ri = [...String(emoji || '')].map((c) => c.codePointAt(0)).filter((cp) => cp >= 0x1F1E6 && cp <= 0x1F1FF);
  if (ri.length === 2) return ri.map((cp) => String.fromCharCode(cp - 0x1F1E6 + 65)).join('').toLowerCase();
  return null;
}
const FLAG_SPECIAL = { ENG: 'gb-eng', SCO: 'gb-sct' };   // إنجلترا وأسكتلندا (مو إيموجي قياسي)
function teamFlagHtml(t) {
  const iso = FLAG_SPECIAL[t.code] || flagToIso2(t.flag);
  if (!iso) return t.flag || '🏳️';   // احتياط
  return `<img class="tflag" loading="lazy" decoding="async" src="https://flagcdn.com/${iso}.svg" alt="">`;
}
const FLAG_SUB_EMOJI = {              // إنجلترا وأسكتلندا (راية سوداء + وسم)
  '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}': 'gb-eng',
  '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}': 'gb-sct',
};
function flagFromEmoji(emoji) {       // أعلام متفرقة (شريط شاشة الدخول)
  const iso = FLAG_SUB_EMOJI[emoji] || flagToIso2(emoji);
  return iso ? `<img class="tflag" loading="lazy" decoding="async" src="https://flagcdn.com/${iso}.svg" alt="">` : emoji;
}

/* ---------- الحالة ---------- */
const S = {
  sb: null,
  session: null,
  profile: null,
  teams: [],
  teamMap: {},
  matches: [],
  myPreds: new Map(),     // match_id -> {home_score, away_score}
  allPreds: [],           // توقعاتي + توقعات الباقين للمباريات اللي بلشت
  leaderboard: [],
  log: [],
  state: null,            // app_state
  myChampion: null,
  myGolden: null,
  allChampions: [],       // بعد الكشف
  allGoldens: [],
  view: 'home',
  roundTab: null,
  logUser: null,
  countedUp: false,
  dirty: false,
  onboarding: false,   // معالج اختيار البطل مفتوح — ممنوع أي إعادة رسم تلقائية
  cascade: false,      // نافذة توقّع الإقصائي مفتوحة — ممنوع أي إعادة رسم تلقائية
  lbTab: null,         // القائمة المعروضة حالياً (للاعب النوع 2 اللي بقائمتين)
};

/* جلب كل الصفوف مهما كبر الجدول (سوبابيز يقصّ عند 1000 صف) */
async function fetchAll(table, orderCol, tieCol = null) {
  const out = [];
  for (let i = 0; ; i += 1000) {
    let q = S.sb.from(table).select('*').order(orderCol);
    if (tieCol) q = q.order(tieCol);
    const { data, error } = await q.range(i, i + 999);
    if (error) return { data: null, error };
    out.push(...data);
    if (data.length < 1000) break;
  }
  return { data: out, error: null };
}

/* ---------- إشعارات ---------- */
function toast(msg, type = 'ok', ms = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type === 'ok' ? '✅' : '⚠️'}</span><span>${esc(msg)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}

/* ---------- نوافذ ---------- */
function openModal(html) {
  $('#modal-host').innerHTML = `<div class="modal-overlay"><div class="modal">${html}</div></div>`;
  $('.modal-overlay').addEventListener('click', (e) => { if (e.target.classList.contains('modal-overlay')) closeModal(); });
}
function closeModal() { $('#modal-host').innerHTML = ''; }

/* ---------- قصاصات احتفال ---------- */
function celebrate(count = 140) {
  const cv = $('#confetti');
  const ctx = cv.getContext('2d');
  cv.width = innerWidth; cv.height = innerHeight;
  const colors = ['#2dd4bf', '#34d399', '#fbbf24', '#f43f5e', '#60a5fa', '#eef2ff'];
  const parts = Array.from({ length: count }, () => ({
    x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.4,
    w: 6 + Math.random() * 6, h: 8 + Math.random() * 8,
    vy: 2.2 + Math.random() * 3.4, vx: -1.5 + Math.random() * 3,
    rot: Math.random() * Math.PI, vr: -0.12 + Math.random() * 0.24,
    color: colors[(Math.random() * colors.length) | 0],
  }));
  let frames = 0;
  (function tick() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (++frames < 240) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, cv.width, cv.height);
  })();
}

/* ---------- اسم المستخدم → إيميل داخلي ---------- */
function normUsername(u) { return String(u || '').trim().replace(/\s+/g, ' '); }
function emailFor(username) {
  const norm = normUsername(username).toLowerCase();
  const bytes = new TextEncoder().encode(norm);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `u${hex}@wc26.app`;
}

/* ============================================================
   الإقلاع
   ============================================================ */
window.addEventListener('DOMContentLoaded', init);

function configMissing() {
  const c = window.WC_CONFIG || {};
  return !c.SUPABASE_URL || c.SUPABASE_URL.includes('YOUR-PROJECT') || !c.SUPABASE_ANON_KEY || c.SUPABASE_ANON_KEY.includes('YOUR-ANON');
}

function hideSplash() { $('#splash').classList.add('gone'); }

async function init() {
  // الكاش للنسخة المنشورة فقط (محلياً بيخرّب التطوير)
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !isLocal) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  if (configMissing()) { hideSplash(); renderSetup(); return; }

  if (!window.supabase) {
    hideSplash();
    $('#root').innerHTML = `<div class="view empty-note"><span class="big">📡</span>ما قدرنا نحمّل مكتبة الاتصال — تأكد من النت<br><br><button class="btn" onclick="location.reload()">جرّب مرة تانية</button></div>`;
    return;
  }

  S.sb = window.supabase.createClient(window.WC_CONFIG.SUPABASE_URL, window.WC_CONFIG.SUPABASE_ANON_KEY);

  const { data: { session } } = await S.sb.auth.getSession();
  S.session = session;

  S.sb.auth.onAuthStateChange((_evt, sess) => {
    const had = !!S.session;
    S.session = sess;
    if (!sess && had) location.reload();
  });

  if (!session) { hideSplash(); renderAuth(); return; }
  await enterApp();
}

function renderSetup() {
  $('#root').innerHTML = `
  <div class="view auth-wrap"><div class="card setup-card">
    <h2>⚙️ خطوة أخيرة قبل الانطلاق</h2>
    <ol>
      <li>أنشئ مشروع مجاني على <code>supabase.com</code></li>
      <li>افتح <b>SQL Editor</b> وشغّل ملف <code>supabase/schema.sql</code> كاملاً</li>
      <li>من <b>Authentication ← Sign In / Up ← Email</b> عطّل خيار <code>Confirm email</code></li>
      <li>من <b>Project Settings ← API</b> انسخ <code>URL</code> و <code>anon key</code> وحطهم بملف <code>js/config.js</code></li>
      <li>حدّث الصفحة وسجّل حسابك، ثم فعّل صلاحية الأدمن لنفسك (السطر الأخير بملف SQL)</li>
    </ol>
    <p style="color:var(--muted);font-size:13px">كل التعليمات موجودة بالتفصيل بملف README.md 📘</p>
    <button class="btn btn-ghost btn-block" id="previewAuth" style="margin-top:14px">👀 معاينة شاشة البداية (بدون اتصال)</button>
  </div></div>`;
  $('#previewAuth').addEventListener('click', () => renderAuth());
}

/* ============================================================
   شاشة الدخول — مشهد الافتتاح
   ============================================================ */
const ALL_FLAGS = ['🇲🇽','🇿🇦','🇰🇷','🇨🇿','🇨🇦','🇧🇦','🇶🇦','🇨🇭','🇺🇸','🇵🇾','🇦🇺','🇹🇷','🇧🇷','🇲🇦','🇭🇹','🏴󠁧󠁢󠁳󠁣󠁴󠁿','🇩🇪','🇨🇼','🇨🇮','🇪🇨','🇳🇱','🇯🇵','🇸🇪','🇹🇳','🇪🇸','🇨🇻','🇸🇦','🇺🇾','🇧🇪','🇪🇬','🇮🇷','🇳🇿','🇫🇷','🇸🇳','🇳🇴','🇮🇶','🇦🇷','🇩🇿','🇦🇹','🇯🇴','🇵🇹','🇨🇩','🏴󠁧󠁢󠁥󠁮󠁧󠁿','🇭🇷','🇵🇦','🇬🇭','🇨🇴','🇺🇿'];

const TROPHY_ART = `
<svg class="trophy-svg" viewBox="0 0 200 220" aria-hidden="true">
  <defs>
    <linearGradient id="atg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffe9a8"/><stop offset=".45" stop-color="#fbbf24"/><stop offset="1" stop-color="#d97706"/>
    </linearGradient>
    <linearGradient id="atg2" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff7df"/><stop offset="1" stop-color="#f59e0b"/>
    </linearGradient>
  </defs>
  <g stroke="url(#atg)" stroke-width="10" fill="none" stroke-linecap="round">
    <path d="M55 48 C28 48 20 62 24 80 C28 100 48 112 66 108"/>
    <path d="M145 48 C172 48 180 62 176 80 C172 100 152 112 134 108"/>
  </g>
  <path fill="url(#atg)" d="M52 38h96v26c0 44-22 70-48 76-26-6-48-32-48-76z"/>
  <ellipse cx="100" cy="38" rx="48" ry="9" fill="url(#atg2)"/>
  <path class="t-shine" d="M66 54 C66 88 76 112 92 124" stroke="rgba(255,255,255,.9)" stroke-width="6" fill="none" stroke-linecap="round"/>
  <rect x="92" y="138" width="16" height="26" rx="4" fill="url(#atg)"/>
  <path d="M70 176q30-14 60 0l6 14H64z" fill="url(#atg)"/>
  <rect x="58" y="192" width="84" height="18" rx="6" fill="#0c1733" stroke="url(#atg)" stroke-width="3"/>
  <text x="100" y="206" text-anchor="middle" font-size="13" font-weight="900" font-family="Cairo,Arial"><tspan fill="#ef2b4e">2</tspan><tspan fill="#11c26d">6</tspan></text>
</svg>`;

function renderAuth(mode = 'login', error = '') {
  $('#topbar').classList.add('hidden');
  $('#navbar').classList.add('hidden');
  let lastUser = '';
  try { lastUser = localStorage.getItem('wc26-last-user') || ''; } catch (_) {}

  const tickerFlags = [...ALL_FLAGS, ...ALL_FLAGS].map((f) => `<span>${flagFromEmoji(f)}</span>`).join('');

  $('#root').innerHTML = `
  <div class="view auth-stage" id="authStage">
    <section class="auth-hero">
      <div class="hero-art" data-px="14">
        <div class="rays"></div>
        ${TROPHY_ART}
        <div class="orbit-ball" aria-hidden="true">⚽</div>
        <span class="spark s1"></span><span class="spark s2"></span><span class="spark s3"></span><span class="spark s4"></span>
      </div>
      <h1 class="kinetic auth-headline" data-px="7"><span>مونديال</span> <span>العيلة</span></h1>
      <div class="year-roll" data-px="5"><span>2</span><span>0</span><span>2</span><span>6</span></div>
      <p class="auth-sub reveal-late">خويي حط اسمك · توقّع النتائج · واكسب نقاط</p>
    </section>

    <section class="auth-panel reveal-late">
      <div class="auth-tabs" role="tablist">
        <button class="auth-tab ${mode === 'login' ? 'active' : ''}" data-mode="login">تسجيل دخول</button>
        <button class="auth-tab ${mode === 'signup' ? 'active' : ''}" data-mode="signup">حساب جديد</button>
      </div>
      ${error ? `<div class="auth-error">${esc(error)}</div>` : ''}
      <form id="authForm">
        <div class="field">
          <label>حط الاسم يلي حيطلع معبّر عنك</label>
          <input class="input" id="username" autocomplete="username" value="${esc(lastUser)}" placeholder="مثلاً: دكتور صلاح" maxlength="15" required>
        </div>
        <div class="field">
          <label>كلمة المرور</label>
          <input class="input" id="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" placeholder="••••••" minlength="6" required>
        </div>
        <button class="btn btn-block btn-shimmer" id="authBtn" type="submit">${mode === 'login' ? 'يلا ندخل' : 'سجّلني بالدوري'}</button>
      </form>
    </section>

    <div class="flag-ticker" aria-hidden="true"><div class="ticker-track">${tickerFlags}</div></div>
  </div>`;

  $$('.auth-tab').forEach((b) => b.addEventListener('click', () => renderAuth(b.dataset.mode)));
  $('#authForm').addEventListener('submit', (e) => { e.preventDefault(); doAuth(mode); });

  // بارالاكس ناعم مع حركة الماوس (أجهزة المكتب فقط)
  if (matchMedia('(pointer:fine)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const stage = $('#authStage');
    stage.addEventListener('mousemove', (e) => {
      const x = e.clientX / innerWidth - 0.5;
      const y = e.clientY / innerHeight - 0.5;
      stage.querySelectorAll('[data-px]').forEach((el) => {
        const k = +el.dataset.px;
        el.style.transform = `translate3d(${x * k}px, ${y * k * 0.7}px, 0)`;
      });
    });
  }
}

function mapAuthError(msg) {
  msg = String(msg || '');
  if (/invalid login credentials/i.test(msg)) return 'الاسم أو كلمة السر غلط — جرّب كمان مرة';
  if (/already registered/i.test(msg)) return 'هالاسم محجوز — جرّب اسم تاني أو سجّل دخول';
  if (/at least 6/i.test(msg) || /password/i.test(msg)) return 'كلمة المرور لازم تكون 6 أحرف على الأقل';
  if (/rate limit/i.test(msg)) return 'محاولات كتير! انطر شوي وجرّب مرة تانية';
  if (/confirm/i.test(msg)) return 'لازم الأدمن يعطّل "Confirm email" من إعدادات Supabase';
  if (/fetch/i.test(msg) || /network/i.test(msg)) return 'مشكلة بالاتصال — تأكد من النت وجرّب كمان مرة';
  console.warn('auth error:', msg);
  return 'صار شي غلط — جرّب كمان مرة، وإذا ضلّت المشكلة خبّر الأدمن';
}

async function doAuth(mode) {
  if (!S.sb) return renderAuth(mode, 'هاي معاينة بس — كمّل ربط Supabase أولاً (ملف config.js)');
  const username = normUsername($('#username').value);
  const password = $('#password').value;

  if (username.length < 2 || username.length > 15) return renderAuth(mode, 'الاسم لازم يكون بين 2 و 15 حرف');
  if (new TextEncoder().encode(username.toLowerCase()).length > 31) return renderAuth(mode, 'الاسم طويل شوي — قصّره وجرّب');
  if (password.length < 6) return renderAuth(mode, 'كلمة المرور لازم تكون 6 أحرف على الأقل');

  const btn = $('#authBtn');
  btn.disabled = true; btn.textContent = 'لحظة...';
  const email = emailFor(username);

  let result;
  try {
    if (mode === 'signup') {
      result = await S.sb.auth.signUp({ email, password, options: { data: { username: username.toLowerCase(), display_name: username } } });
      if (!result.error && !result.data.session) throw new Error('confirm');
    } else {
      result = await S.sb.auth.signInWithPassword({ email, password });
    }
    if (result.error) throw result.error;
  } catch (err) {
    renderAuth(mode, mapAuthError(err.message));
    return;
  }

  try { localStorage.setItem('wc26-last-user', username); } catch (_) {}
  S.session = result.data.session;
  await enterApp();
  if (mode === 'signup') toast(`أهلاً فيك يا ${username}! 🎉`);
}

/* ============================================================
   تحميل البيانات
   ============================================================ */
async function loadAll() {
  const uid = S.session.user.id;
  const [profile, teams, matches, preds, lb, log, state, champ, golden] = await Promise.all([
    S.sb.from('profiles').select('*').eq('id', uid).single(),
    S.sb.from('teams').select('*').order('name_ar'),
    S.sb.from('matches').select('*').order('kickoff').order('id'),
    fetchAll('predictions', 'match_id', 'user_id'),
    S.sb.from('leaderboard').select('*'),
    fetchAll('points_log', 'id'),
    S.sb.from('app_state').select('*').eq('id', true).single(),
    S.sb.from('champion_picks').select('*'),
    S.sb.from('golden_picks').select('*'),
  ]);

  const firstErr = [profile, teams, matches, preds, lb, log, state, champ, golden].find((r) => r.error);
  if (firstErr?.error) throw firstErr.error;

  S.profile = profile.data;
  S.teams = teams.data.map((t) => ({ ...t, flag: teamFlagHtml(t) }));
  S.teamMap = Object.fromEntries(S.teams.map((t) => [t.code, t]));
  S.matches = matches.data;
  S.allPreds = preds.data;
  S.myPreds = new Map(preds.data.filter((p) => p.user_id === uid).map((p) => [p.match_id, p]));
  S.leaderboard = lb.data.sort((a, b) => b.total - a.total || b.exact_count - a.exact_count || a.display_name.localeCompare(b.display_name, 'ar'));
  S.log = log.data;
  S.state = state.data;
  S.allChampions = champ.data;
  S.allGoldens = golden.data;
  S.myChampion = champ.data.find((c) => c.user_id === uid) || null;
  S.myGolden = golden.data.find((g) => g.user_id === uid) || null;

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      ts: Date.now(), teams: S.teams, matches: S.matches, leaderboard: S.leaderboard, state: S.state,
    }));
  } catch (_) { /* مساحة التخزين ممتلئة — مو مشكلة */ }
}

function loadFromCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!c) return false;
    S.teams = c.teams.map((t) => ({ ...t, flag: teamFlagHtml(t) }));
    S.teamMap = Object.fromEntries(S.teams.map((t) => [t.code, t]));
    S.matches = c.matches; S.leaderboard = c.leaderboard; S.state = c.state;
    return true;
  } catch (_) { return false; }
}

let rtTimer = null;
function subscribeRealtime() {
  const refresh = () => {
    clearTimeout(rtTimer);
    rtTimer = setTimeout(async () => {
      try {
        await loadAll();
        softRender();
      } catch (_) { /* تجاهل أخطاء التحديث الصامت */ }
    }, 600);
  };
  S.sb.channel('db-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'points_log' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_state' }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'predictions' }, refresh)
    .subscribe();
}

/* إعادة رسم بدون إزعاج المستخدم وهو عم يكتب أو عم يختار البطل */
function softRender() {
  if (S.onboarding || S.cascade) return;
  // لوحة الإدارة فيها اختيارات وفورمات غير محفوظة — ما منمسحها بتحديث تلقائي
  if (S.view === 'admin') { S.dirty = true; return; }
  const active = document.activeElement;
  if (active && (active.classList.contains('score-num') || active.tagName === 'INPUT' || active.tagName === 'SELECT')) {
    S.dirty = true;
    return;
  }
  renderView();
}
document.addEventListener('focusout', () => {
  if (S.dirty) { S.dirty = false; setTimeout(softRender, 250); }
});

async function enterApp() {
  // رسم فوري من الكاش، ثم تحديث من السيرفر
  const cached = loadFromCache();
  if (cached) { hideSplash(); renderShell(); renderView(); }

  let fresh = false;
  try {
    await loadAll();
    fresh = true;
  } catch (err) {
    hideSplash();
    if (!cached) {
      $('#root').innerHTML = `<div class="view empty-note"><span class="big">📡</span>ما قدرنا نوصل للسيرفر<br><small>${esc(mapAuthError(err.message))}</small><br><br><button class="btn" onclick="location.reload()">جرّب مرة تانية</button></div>`;
      return;
    }
    toast('عرض نسخة محفوظة — في مشكلة بالاتصال', 'err');
  }

  hideSplash();
  renderShell();

  // أول تسجيل: اختيار البطل والمربع الذهبي (سري) — فقط بعد تحميل ناجح من السيرفر
  const deadlineOpen = S.state && Date.now() < new Date(S.state.picks_deadline).getTime();
  if (fresh && (!S.myChampion || !S.myGolden) && deadlineOpen) {
    renderOnboarding(!S.myChampion ? 1 : 2);
  } else {
    renderView();
  }

  subscribeRealtime();
  startTicker();
}

/* ============================================================
   الهيكل العام
   ============================================================ */
function renderShell() {
  $('#topbar').classList.remove('hidden');
  $('#navbar').classList.remove('hidden');
  $('#profileBtn').innerHTML = `<svg class="pc-ico"><use href="#i-user"/></svg> <span>${esc(S.profile?.display_name || '...')}</span>`;
  $('#profileBtn').onclick = openProfile;
  const bs = $('#brandSub'); if (bs) bs.textContent = phaseLabel();

  const tabs = [
    { id: 'home', ico: 'i-home', label: 'الرئيسية' },
    { id: 'matches', ico: 'i-ball', label: 'المباريات' },
    { id: 'log', ico: 'i-chart', label: 'السجل' },
  ];
  if (S.profile?.is_admin) tabs.push({ id: 'admin', ico: 'i-gear', label: 'الإدارة' });

  $('#navbar').innerHTML = `<div class="nav-inner">${tabs.map((t) => `
    <button class="nav-btn ${S.view === t.id ? 'active' : ''}" data-view="${t.id}">
      <span class="ico"><svg><use href="#${t.ico}"/></svg></span><span>${t.label}</span>
    </button>`).join('')}</div>`;

  $$('.nav-btn').forEach((b) => b.addEventListener('click', () => {
    S.view = b.dataset.view;
    renderShell();
    renderView();
    scrollTo({ top: 0 });
  }));
}

function renderView() {
  if (!S.session || S.onboarding || S.cascade) return;
  renderShell();
  if (S.view === 'home') renderHome();
  else if (S.view === 'matches') renderMatches();
  else if (S.view === 'log') renderLog();
  else if (S.view === 'admin') renderAdmin();
}

/* ---------- حالة المباراة ---------- */
function matchPhase(m) {
  const now = Date.now();
  const ko = new Date(m.kickoff).getTime();
  if (m.finished) return 'done';
  if (now >= ko + LIVE_WINDOW_MS) return 'await';   // خلصت غالباً — ناطرين الأدمن يدخل النتيجة
  if (now >= ko) return 'live';
  if (now >= ko - LOCK_MARGIN_MS) return 'locked';
  if (now >= ko - 60 * 60 * 1000) return 'soon';
  return 'open';
}

/* اسم المرحلة الحالية (يظهر تحت اسم الموقع بالشريط العلوي) */
function phaseLabel() {
  const ms = S.matches || [];
  if (!ms.length) return 'دوري التوقّعات';
  if (ms.every((x) => x.finished)) return 'انتهت البطولة 🏆';
  const live = ms.find((m) => matchPhase(m) === 'live');
  const upcoming = ms.find((m) => !m.finished && new Date(m.kickoff).getTime() > Date.now());
  const m = live || upcoming || ms.find((x) => !x.finished);
  return STAGES[m?.stage] || 'دوري التوقّعات';
}

function pointsFor(uid, matchId) {
  return S.log.find((l) => l.user_id === uid && l.match_id === matchId) || null;
}

/* روابط آمنة فقط (http/https) للبانر */
function safeUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

/* شرح نظام نقاط الإقصائي (نافذة) */
function openScoringHelp() {
  const pq = S.state?.points_ko_qualify ?? 3, pd = S.state?.points_ko_dir ?? 1, pe = S.state?.points_ko_exact ?? 2;
  openModal(`
    <h3>🧠 كيف بتنحسب نقاط الإقصائي؟</h3>
    <div class="modal-body" style="color:var(--text)">
      <p class="sh-intro">هون ما في تعادل بالآخر — لازم يطلع متأهّل. فالنظام بيمشي مع المباراة خطوة خطوة:</p>
      <div class="sh-step"><span class="sh-n g">${pq}</span><div><b>مين بيتأهّل</b><br><span class="sh-d">الفريق اللي بيعبر للدور الجاي — ثابتة مهما صار</span></div></div>
      <div class="sh-step"><span class="sh-n o">${pd}</span><div><b>الاتجاه الصح</b><br><span class="sh-d">حزرت إنها بتنحسم بالـ٩٠ / بالإضافي / بالترجيح</span></div></div>
      <div class="sh-step"><span class="sh-n o">${pe}<small>×٣</small></span><div><b>النتيجة بالضبط (بتتراكم)</b><br><span class="sh-d">نقطتين عن كل مرحلة بتضبط نتيجتها: الـ٩٠، الإضافي، الترجيح</span></div></div>
      <div class="sh-max">🔥 أكبر مجموع بالمباراة = <b>${pq + pd + pe * 3} نقاط</b><br><span class="sh-d">مباراة بتروح ترجيح وتضبط كل شي</span></div>
      <div class="sh-eg"><b>مثال:</b> توقّعت إسبانيا تفوز ٢-٠ وهيك صار = ${pq + pd + pe}. توقّعت تعادل ويتأهّل بالترجيح وضبطت الكل = ${pq + pd + pe * 3}.</div>
      <div class="sh-eg" style="color:var(--muted)">توقّع البطل (${S.state?.points_champion ?? 10}) والمربع الذهبي منفصلين عن هالحساب.</div>
    </div>
    <div class="modal-actions"><button class="btn btn-block" id="shClose">تمام، فهمت 👍</button></div>`);
  $('#shClose').onclick = closeModal;
}

/* ============================================================
   القوائم (الدوريين)
   رفقات عمر = نوع 1+2 (نقاط كاملة) · العيلة = نوع 2+3 (بدون نقاط المجموعات)
   ============================================================ */
const LEAGUES = {
  omar:   { name: 'رفقات عمر', types: [1, 2], score: (r) => r.total || 0 },
  family: { name: 'العيلة',    types: [2, 3], score: (r) => (r.total || 0) - (r.group_points || 0) },
};
function myLeagueKeys() {
  const t = S.profile?.player_type;
  const ks = [];
  if (t === 1 || t === 2) ks.push('omar');
  if (t === 2 || t === 3) ks.push('family');
  return ks.length ? ks : ['omar'];
}
function leagueRows(key) {
  const lg = LEAGUES[key];
  return S.leaderboard
    .filter((r) => lg.types.includes(r.player_type))
    .map((r) => ({ r, sc: lg.score(r) }))
    .sort((a, b) => b.sc - a.sc || (b.r.exact_count || 0) - (a.r.exact_count || 0) || a.r.display_name.localeCompare(b.r.display_name, 'ar'));
}
function lbRowHtml(r, sc, i, key, me) {
  const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
  const gc = `${r.golden_points ? `<span><b style="color:var(--gold)">${r.golden_points}</b> المربع</span>` : ''}${r.champion_points ? `<span><b style="color:var(--gold)">${r.champion_points}</b> البطل</span>` : ''}`;
  const stats = key === 'family'
    ? `<span><b style="color:var(--wc-cyan)">${r.ko_points || 0}</b> إقصائي</span>${gc}`
    : `<span><b style="color:var(--gold)">${r.exact_count}</b> بالضبط</span><span><b style="color:var(--wc-green)">${r.winner_count}</b> فائز</span>${gc}`;
  return `
  <div class="lb-row ${r.id === me ? 'me' : ''}" data-uid="${r.id}" style="animation-delay:${Math.min(i * 0.06, 0.5)}s">
    <div class="lb-rank">${medal ? `<span class="medal">${medal}</span>` : i + 1}</div>
    <div class="lb-info">
      <div class="lb-name">${esc(r.display_name)} ${r.id === me ? '<span class="you">(أنت)</span>' : ''}</div>
      <div class="lb-stats">${stats}</div>
    </div>
    <div class="lb-total" data-total="${sc}">${sc}<small>نقطة</small></div>
  </div>`;
}
function leaguesSectionHtml(me) {
  // قبل ترقية القوائم (ما في player_type): ترتيب واحد للكل
  if (!S.leaderboard.some((r) => r.player_type != null)) {
    const rows = [...S.leaderboard].sort((a, b) => b.total - a.total || (b.exact_count || 0) - (a.exact_count || 0));
    const list = rows.length ? rows.map((r, i) => lbRowHtml(r, r.total, i, 'omar', me)).join('')
      : '<div class="empty-note"><span class="big">👋</span>لسا ما في حدا — خبّر الشباب يسجلوا!</div>';
    return `<h2 class="section-title"><svg class="st-ico" style="color:var(--gold)"><use href="#i-trophy"/></svg> ترتيب الشباب</h2><div class="lb-list">${list}</div>`;
  }
  const keys = myLeagueKeys();
  if (!S.lbTab || !keys.includes(S.lbTab)) S.lbTab = keys[0];
  const active = S.lbTab;
  const tabs = keys.length > 1
    ? `<div class="round-tabs lb-tabs">${keys.map((k) => `<button class="round-tab ${k === active ? 'active' : ''}" data-lb="${k}">${LEAGUES[k].name}</button>`).join('')}</div>`
    : '';
  const rows = leagueRows(active);
  const list = rows.length ? rows.map((x, i) => lbRowHtml(x.r, x.sc, i, active, me)).join('')
    : '<div class="empty-note"><span class="big">👋</span>لسا ما في لاعبين بهالقائمة</div>';
  return `
    <h2 class="section-title"><svg class="st-ico" style="color:var(--gold)"><use href="#i-trophy"/></svg> ${keys.length > 1 ? 'الترتيب' : 'ترتيب ' + LEAGUES[active].name}</h2>
    ${tabs}
    <div class="lb-list">${list}</div>`;
}

/* ============================================================
   الرئيسية
   ============================================================ */
function renderHome() {
  const me = S.session.user.id;
  const next = S.matches.find((m) => !m.finished && new Date(m.kickoff).getTime() > Date.now());
  const live = S.matches.filter((m) => matchPhase(m) === 'live');
  const champion = S.state?.champion ? S.teamMap[S.state.champion] : null;
  const allDone = S.matches.length > 0 && S.matches.every((m) => m.finished);

  let winnerHtml = '';
  if (champion && S.leaderboard.length) {
    const top = S.leaderboard[0]?.total || 0;
    const topExact = S.leaderboard[0]?.exact_count || 0;
    const winners = S.leaderboard.filter((r) => r.total === top && r.exact_count === topExact && top > 0);
    winnerHtml = `
    <div class="winner-banner">
      ${TROPHY_ART.replace('class="trophy-svg"', 'class="banner-trophy"')}
      <h2>${champion.flag} ${esc(champion.name_ar)} بطل العالم 2026!</h2>
      ${allDone && winners.length ? `<p style="margin-top:8px;font-size:16px;font-weight:800;color:var(--text)">
        🥇 بطل مونديال العيلة: ${winners.map((w) => esc(w.display_name)).join(' و ')} (${top} نقطة)</p>` : ''}
    </div>`;
  }

  let heroHtml = '';
  if (live.length) {
    const m = live[0];
    heroHtml = `
    <div class="hero">
      <span class="live-badge"><span class="live-dot"></span> عم تلعب هلق</span>
      <div class="hero-teams" style="margin-top:12px">
        <div><span class="hero-flag">${koSide(m, 'h').flag}</span>${esc(koSide(m, 'h').name)}</div>
        <span class="hero-vs">VS</span>
        <div><span class="hero-flag">${koSide(m, 'a').flag}</span>${esc(koSide(m, 'a').name)}</div>
      </div>
    </div>`;
  } else if (next) {
    heroHtml = `
    <div class="hero">
      <div class="hero-label">المباراة الجاية${next.stage !== 'group' ? ` — ${STAGES[next.stage]}` : ''} — ${esc(fmtDay(next.kickoff))} • ${esc(fmtTime(next.kickoff))}</div>
      <div class="hero-teams">
        <div><span class="hero-flag">${koSide(next, 'h').flag}</span>${esc(koSide(next, 'h').name)}</div>
        <span class="hero-vs">VS</span>
        <div><span class="hero-flag">${koSide(next, 'a').flag}</span>${esc(koSide(next, 'a').name)}</div>
      </div>
      <div class="countdown" data-ko="${new Date(next.kickoff).getTime()}">
        <div class="cd-box"><div class="cd-num" data-u="d">0</div><div class="cd-lbl">يوم</div></div>
        <div class="cd-box"><div class="cd-num" data-u="h">0</div><div class="cd-lbl">ساعة</div></div>
        <div class="cd-box"><div class="cd-num" data-u="m">0</div><div class="cd-lbl">دقيقة</div></div>
        <div class="cd-box"><div class="cd-num" data-u="s">0</div><div class="cd-lbl">ثانية</div></div>
      </div>
      ${(next.stage === 'group' || koReady(next)) && !S.myPreds.has(next.id) ? `<p style="margin-top:12px;font-size:13px;color:var(--gold);font-weight:800">لسا ما توقعت هالمباراة!</p>` : (next.stage !== 'group' && !koReady(next)) ? `<p style="margin-top:12px;font-size:12.5px;color:var(--muted);font-weight:700">الفرق بتتحدّد مع نهاية المجموعات</p>` : ''}
    </div>`;
  }

  const bn = S.state || {};
  const bnLink = safeUrl(bn.banner_link);
  const bannerHtml = (bn.banner_on && bn.banner_text) ? `
    <a class="promo-banner ${bnLink ? 'clickable' : ''}" ${bnLink ? `href="${esc(bnLink)}" target="_blank" rel="noopener"` : ''}>
      <span class="promo-spark">📣</span>
      <div class="promo-text">${esc(bn.banner_text)}</div>
      ${bnLink ? `<span class="promo-cta">${esc(bn.banner_cta || 'افتح')}</span>` : ''}
    </a>` : '';

  const pq = S.state?.points_ko_qualify ?? 3, pd = S.state?.points_ko_dir ?? 1, pe = S.state?.points_ko_exact ?? 2;
  const scoring = S.state ? `
    <h2 class="section-title"><svg class="st-ico" style="color:var(--wc-cyan)"><use href="#i-ball"/></svg> نظام النقاط</h2>
    <div class="card pts-explain">
      <div class="pts-row"><span class="pts-k">المجموعات</span><span class="pts-v">الفائز <b class="g">+${S.state.points_win}</b> · بالضبط <b class="o">+${S.state.points_exact}</b></span></div>
      <div class="pts-row"><span class="pts-k">الإقصائي</span><span class="pts-v">المتأهّل <b class="g">+${pq}</b> · الاتجاه <b class="o">+${pd}</b> · كل نتيجة <b class="o">+${pe}</b> <span class="pts-max">حتى ١٠</span></span></div>
      <div class="pts-row"><span class="pts-k">الجوائز</span><span class="pts-v">${S.state.golden_per_team ? 'كل منتخب بالمربع' : 'المربع كامل'} <b class="o">+${S.state.points_golden}</b> · البطل <b class="o">+${S.state.points_champion}</b></span></div>
      <button class="btn btn-sm btn-ghost btn-block" id="scoringHelp" style="margin-top:4px">🧠 اشرحلي نقاط الإقصائي</button>
    </div>` : '';

  $('#root').innerHTML = `
  <div class="view">
    ${bannerHtml}
    ${winnerHtml}
    ${heroHtml}
    ${leaguesSectionHtml(me)}
    ${scoring}
  </div>`;

  $$('.lb-row').forEach((row) => row.addEventListener('click', () => {
    S.logUser = row.dataset.uid;
    S.view = 'log';
    renderView();
    scrollTo({ top: 0 });
  }));

  const sh = $('#scoringHelp'); if (sh) sh.onclick = openScoringHelp;
  $$('.lb-tabs .round-tab').forEach((b) => b.addEventListener('click', () => { S.lbTab = b.dataset.lb; S.countedUp = false; renderHome(); }));

  if (!S.countedUp) {
    S.countedUp = true;
    $$('.lb-total').forEach((el) => {
      const target = +el.dataset.total;
      if (!target) return;
      const small = el.querySelector('small').outerHTML;
      const t0 = performance.now();
      (function step(t) {
        const k = Math.min((t - t0) / 900, 1);
        el.innerHTML = Math.round(target * (1 - Math.pow(1 - k, 3))) + small;
        if (k < 1) requestAnimationFrame(step);
      })(t0);
    });
  }

  updateCountdowns();
}

/* ============================================================
   المباريات
   ============================================================ */
function roundTabsList() {
  const tabs = [
    { id: 'g1', label: 'الجولة 1', filter: (m) => m.stage === 'group' && m.round === 1 },
    { id: 'g2', label: 'الجولة 2', filter: (m) => m.stage === 'group' && m.round === 2 },
    { id: 'g3', label: 'الجولة 3', filter: (m) => m.stage === 'group' && m.round === 3 },
  ];
  for (const st of ['r32', 'r16', 'qf', 'sf', 'third', 'final']) {
    if (S.matches.some((m) => m.stage === st)) tabs.push({ id: st, label: STAGES[st], filter: (m) => m.stage === st });
  }
  return tabs;
}

function defaultRoundTab() {
  const next = S.matches.find((m) => !m.finished);
  const tabs = roundTabsList();
  if (!next) return tabs[tabs.length - 1].id;
  const t = tabs.find((tb) => tb.filter(next));
  return t ? t.id : tabs[0].id;
}

function renderMatches() {
  if (!S.roundTab) S.roundTab = defaultRoundTab();
  const tabs = roundTabsList();
  const tab = tabs.find((t) => t.id === S.roundTab) || tabs[0];
  const list = S.matches.filter(tab.filter);

  // تجميع حسب اليوم
  const groups = [];
  for (const m of list) {
    const day = fmtDay(m.kickoff);
    const g = groups.find((x) => x.day === day);
    if (g) g.items.push(m); else groups.push({ day, items: [m] });
  }

  $('#root').innerHTML = `
  <div class="view">
    <h2 class="section-title"><svg class="st-ico" style="color:var(--wc-cyan)"><use href="#i-ball"/></svg> المباريات <span style="font-size:12px;color:var(--muted);font-weight:700">(الأوقات بتوقيت جهازك)</span></h2>
    <div class="round-tabs">
      ${tabs.map((t) => `<button class="round-tab ${t.id === tab.id ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
    </div>
    ${groups.length === 0 ? '<div class="empty-note"><span class="big">📭</span>ما في مباريات بهالمرحلة بعد</div>' : ''}
    ${groups.map((g) => `
      <div class="date-header">${esc(g.day)}</div>
      <div class="matches-grid">${g.items.map((m, i) => matchCard(m, i)).join('')}</div>
    `).join('')}
  </div>`;

  $$('.round-tab').forEach((b) => b.addEventListener('click', () => { S.roundTab = b.dataset.tab; renderMatches(); }));
  bindMatchCards();
}

function matchCard(m, i = 0) {
  const me = S.session.user.id;
  const phase = matchPhase(m);
  const ko = m.stage !== 'group';
  const th = ko ? koSide(m, 'h') : (S.teamMap[m.home] || { name_ar: m.home, flag: '🏳️' });
  const ta = ko ? koSide(m, 'a') : (S.teamMap[m.away] || { name_ar: m.away, flag: '🏳️' });
  const thName = ko ? th.name : th.name_ar;
  const taName = ko ? ta.name : ta.name_ar;
  const pred = S.myPreds.get(m.id);

  const statusMap = {
    open: '<span class="match-status st-open">التوقع مفتوح</span>',
    soon: '<span class="match-status st-soon">بيقفل بعد شوي</span>',
    locked: '<span class="match-status st-soon">انقفل التوقع</span>',
    live: '<span class="match-status st-live">عم تلعب هلق</span>',
    await: '<span class="match-status st-soon">ناطرين النتيجة</span>',
    done: '<span class="match-status st-done">خلصت</span>',
  };

  let zone = '';
  if (ko) {
    zone = koZone(m, phase, pred, me);
  } else if (phase === 'open' || phase === 'soon') {
    zone = `
    <div class="score-inputs">
      <div class="stepper">
        <button class="step-btn" data-act="inc" data-side="h">+</button>
        <input class="score-num" data-side="h" type="number" inputmode="numeric" min="0" max="20" value="${pred ? pred.home_score : ''}" placeholder="-">
        <button class="step-btn" data-act="dec" data-side="h">−</button>
      </div>
      <span class="score-sep">:</span>
      <div class="stepper">
        <button class="step-btn" data-act="inc" data-side="a">+</button>
        <input class="score-num" data-side="a" type="number" inputmode="numeric" min="0" max="20" value="${pred ? pred.away_score : ''}" placeholder="-">
        <button class="step-btn" data-act="dec" data-side="a">−</button>
      </div>
    </div>
    <div class="save-state ${pred ? 'ok' : ''}">${pred ? '✓ توقعك محفوظ' : 'سجّل توقعك'}</div>`;
  } else {
    // داخل جزيرة LTR: الفريق المضيف يظهر يمين البطاقة، فمنكتب الضيف أولاً ليطلع رقم كل فريق جنبه
    const score = (m.home_score ?? m.away_score) != null && phase !== 'locked'
      ? `<div class="final-score">${m.away_score ?? '?'} - ${m.home_score ?? '?'}</div>`
      : `<div class="final-score" style="color:var(--muted)">- : -</div>`;
    let ptsChip = '';
    if (phase === 'done') {
      const entry = pointsFor(me, m.id);
      if (entry) ptsChip = `<span class="pts-chip ${entry.category === 'exact' ? 'pts-exact' : 'pts-win'}">+${entry.points}</span>`;
      else if (pred) ptsChip = `<span class="pts-chip pts-zero">0</span>`;
    }
    zone = `
      ${score}
      <div class="my-pred-chip">${pred ? `توقعك: ${pred.away_score} - ${pred.home_score}` : 'ما توقعت 😶'}</div>
      ${ptsChip}`;
  }

  const showOthers = phase === 'live' || phase === 'await' || phase === 'done';
  return `
  <div class="card match-card ${ko ? 'ko-card' : ''}" data-mid="${m.id}" style="animation-delay:${Math.min(i * 0.05, 0.4)}s">
    <div class="match-top">
      <span>${esc(fmtTime(m.kickoff))}${ko ? ` • ${STAGES[m.stage]}` : ''}</span>
      ${statusMap[phase]}
    </div>
    <div class="match-body">
      <div class="team"><span class="flag">${th.flag}</span><span class="tname ${ko && th.tbd ? 'tbd' : ''}">${esc(thName)}</span></div>
      <div class="score-zone">${zone}</div>
      <div class="team"><span class="flag">${ta.flag}</span><span class="tname ${ko && ta.tbd ? 'tbd' : ''}">${esc(taName)}</span></div>
    </div>
    ${ko && m.venue ? `<div class="ko-venue">📍 ${esc(m.venue)}</div>` : ''}
    ${showOthers ? `<button class="others-toggle" data-mid="${m.id}">شوف توقعات الشباب</button><div class="others-list hidden" data-others="${m.id}"></div>` : ''}
  </div>`;
}

function bindMatchCards() {
  $$('.match-card').forEach((card) => {
    const mid = +card.dataset.mid;

    card.querySelectorAll('.step-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = card.querySelector(`.score-num[data-side="${btn.dataset.side}"]`);
        let v = input.value === '' ? -1 : parseInt(input.value, 10);
        v = btn.dataset.act === 'inc' ? v + 1 : v - 1;
        v = Math.max(0, Math.min(20, v));
        input.value = v;
        input.classList.remove('pop'); void input.offsetWidth; input.classList.add('pop');
        const other = card.querySelector(`.score-num[data-side="${btn.dataset.side === 'h' ? 'a' : 'h'}"]`);
        if (other.value === '') other.value = 0;
        queueSave(card, mid);
      });
    });

    card.querySelectorAll('.score-num').forEach((input) => {
      input.addEventListener('input', () => {
        if (input.value !== '') {
          let v = Math.max(0, Math.min(20, parseInt(input.value, 10) || 0));
          input.value = v;
        }
        queueSave(card, mid);
      });
    });

    const toggle = card.querySelector('.others-toggle');
    if (toggle) toggle.addEventListener('click', () => toggleOthers(card, mid));

    const koBtn = card.querySelector('.ko-pred-btn');
    if (koBtn) koBtn.addEventListener('click', () => openKnockoutCascade(+koBtn.dataset.ko));
  });
}

const saveTimers = new Map();
function queueSave(card, mid) {
  clearTimeout(saveTimers.get(mid));
  const h = card.querySelector('.score-num[data-side="h"]').value;
  const a = card.querySelector('.score-num[data-side="a"]').value;
  const stateEl = card.querySelector('.save-state');
  if (h === '' || a === '') { stateEl.textContent = 'كمّل النتيجة'; stateEl.classList.remove('ok'); return; }

  stateEl.textContent = 'عم نحفظ...';
  stateEl.classList.remove('ok');
  clearTimeout(saveTimers.get(mid));
  saveTimers.set(mid, setTimeout(() => savePrediction(card, mid, +h, +a), 650));
}

async function savePrediction(card, mid, h, a) {
  const m = S.matches.find((x) => x.id === mid);
  const stateEl = card.querySelector('.save-state');
  if (!m || !['open', 'soon'].includes(matchPhase(m))) {
    stateEl.textContent = 'خلص الوقت — انقفل التوقع';
    return;
  }
  const { error } = await S.sb.from('predictions').upsert(
    { user_id: S.session.user.id, match_id: mid, home_score: h, away_score: a },
    { onConflict: 'user_id,match_id' }
  );
  if (error) {
    stateEl.textContent = /policy|row-level/i.test(error.message) ? 'انقفل التوقع' : 'ما انحفظ — جرّب كمان مرة';
    return;
  }
  S.myPreds.set(mid, { user_id: S.session.user.id, match_id: mid, home_score: h, away_score: a });
  stateEl.textContent = '✓ انحفظ';
  stateEl.classList.add('ok');
}

async function toggleOthers(card, mid) {
  const box = card.querySelector(`[data-others="${mid}"]`);
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="skeleton" style="height:34px"></div>';

  const { data, error } = await S.sb.from('predictions').select('*').eq('match_id', mid);
  if (error) { box.innerHTML = '<div class="lock-note">⚠️ ما قدرنا نجيب التوقعات</div>'; return; }

  const m = S.matches.find((x) => x.id === mid);
  const ko = m.stage !== 'group';
  const names = Object.fromEntries(S.leaderboard.map((r) => [r.id, r.display_name]));
  const rows = data
    .sort((x, y) => (names[x.user_id] || '').localeCompare(names[y.user_id] || '', 'ar'))
    .map((p) => {
      let chip = '';
      if (m.finished) {
        if (ko) {
          const kp = koPoints(p.user_id, mid);
          chip = `<span class="pts-chip ${kp.total > 0 ? 'pts-win' : 'pts-zero'}">${kp.total > 0 ? '+' + kp.total : '0'}</span>`;
        } else {
          const e = pointsFor(p.user_id, mid);
          chip = e ? `<span class="pts-chip ${e.category === 'exact' ? 'pts-exact' : 'pts-win'}">+${e.points}</span>` : '<span class="pts-chip pts-zero">0</span>';
        }
      }
      const disp = ko ? `<span class="op-ko">${koPredText(m, p)}</span>` : `<span class="op-score">${p.away_score} - ${p.home_score}</span>`;
      return `<div class="other-pred"><span>${esc(names[p.user_id] || 'لاعب')}</span><span style="display:flex;gap:8px;align-items:center">${chip}${disp}</span></div>`;
    });
  box.innerHTML = rows.length ? rows.join('') : '<div class="lock-note">ما حدا توقع هالمباراة 🤷</div>';
}

/* ============================================================
   الأدوار الإقصائية — العرض وتسلسل التوقّع
   (المتأهّل → نتيجة الـ90 → الوقت الإضافي → ركلات الترجيح)
   ============================================================ */
function koReady(m) { return !!(m.home && m.away); }   // تحددت الفرق؟

/* نتيجة ركلات ترجيح منطقية حسب الفيفا (أفضل من ٥ ثم موت مفاجئ — بتنحسم أبكر) */
function validPenScore(a, b) {
  if (a == null || b == null || a < 0 || b < 0 || a === b) return false;
  const hi = Math.max(a, b), lo = Math.min(a, b);
  if (hi - lo === 1) return true;            // فرق ركلة وحدة: ممكن دايماً (٥ كاملة أو موت مفاجئ)
  if (hi > 5) return false;                   // فرق ≥٢ مستحيل بالموت المفاجئ
  return { '2-0': 1, '3-0': 1, '3-1': 1, '4-1': 1, '4-2': 1, '5-3': 1 }[`${hi}-${lo}`] === 1;
}

function koSide(m, side) {
  const code = side === 'h' ? m.home : m.away;
  const slot = side === 'h' ? m.home_slot : m.away_slot;
  if (code) { const t = S.teamMap[code] || {}; return { code, flag: t.flag || '🏳️', name: t.name_ar || code, tbd: false }; }
  return { code: null, flag: '🏁', name: slot || 'يتحدد لاحقاً', tbd: true };
}

function koPoints(uid, mid) {   // مجموع نقاط مباراة إقصائية (عدة صفوف)
  const rows = S.log.filter((l) => l.user_id === uid && l.match_id === mid);
  return { total: rows.reduce((s, r) => s + r.points, 0), rows };
}

function koPredText(m, p) {      // ملخص توقّع اللاعب (ترتيب الضيف-المضيف مثل البطاقة)
  if (!p || !p.adv) return 'ما توقعت 😶';
  const a = S.teamMap[p.adv];
  const an = a ? `${a.flag} ${esc(a.name_ar)}` : esc(p.adv);   // العلم صورة HTML (خام)، الاسم مهروب
  let s = `🏆 ${an} • ${p.away_score}-${p.home_score}`;
  if (p.decided_by === 'et') s += ` ← إضافي ${p.et_away}-${p.et_home}`;
  else if (p.decided_by === 'pens') s += ` ← ترجيح ${p.pen_away}-${p.pen_home}`;
  return s;
}

function koZone(m, phase, pred, me) {
  if (phase === 'done' && m.winner) {
    const w = S.teamMap[m.winner] || {};
    const sc = `<div class="final-score">${m.away_score ?? '?'} - ${m.home_score ?? '?'}</div>`;
    let how = '';
    if (m.decided_by === 'et') how = `<div class="ko-how">بعد الإضافي ${m.et_away ?? ''}-${m.et_home ?? ''}</div>`;
    else if (m.decided_by === 'pens') how = `<div class="ko-how">ترجيح ${m.pen_away ?? ''}-${m.pen_home ?? ''}</div>`;
    const adv = `<div class="ko-adv">🏆 ${w.flag || ''} ${esc(w.name_ar || m.winner)}</div>`;
    let chip = '';
    if (pred) { const kp = koPoints(me, m.id); chip = `<span class="pts-chip ${kp.total > 0 ? 'pts-win' : 'pts-zero'}">${kp.total > 0 ? '+' + kp.total : '0'}</span>`; }
    return `${sc}${how}${adv}${chip}`;
  }
  if (!koReady(m)) return `<div class="ko-tbd"><span class="ko-lock">🔒</span>الفرق بتتحدّد<br>بعد المجموعات</div>`;
  if (phase === 'open' || phase === 'soon') {
    return `<button class="btn btn-sm ko-pred-btn" data-ko="${m.id}">${pred ? '✏️ عدّل توقّعك' : '⚽ توقّع'}</button>
      <div class="ko-pred-sum ${pred ? 'has' : ''}">${pred ? koPredText(m, pred) : 'اضغط لتبدأ'}</div>`;
  }
  return `<div class="final-score" style="color:var(--muted)">- : -</div>
    <div class="ko-pred-sum ${pred ? 'has' : ''}">${pred ? koPredText(m, pred) : 'ما توقعت 😶'}</div>`;
}

/* ----- تسلسل التوقّع (نافذة متدرّجة) ----- */
let koDraft = null;

function openKnockoutCascade(mid) {
  const m = S.matches.find((x) => x.id === mid);
  if (!m || !koReady(m) || !['open', 'soon'].includes(matchPhase(m))) { toast('التوقع مقفل لهالمباراة', 'err'); return; }
  const p = S.myPreds.get(mid);
  koDraft = {
    mid, step: 1, adv: p?.adv || null,
    h: p?.home_score ?? null, a: p?.away_score ?? null,
    decided_by: p?.decided_by || null,
    et_h: p?.et_home ?? null, et_a: p?.et_away ?? null,
    pen_h: p?.pen_home ?? null, pen_a: p?.pen_away ?? null,
  };
  S.cascade = true;
  renderKoStep();
}

function closeKo() { S.cascade = false; koDraft = null; closeModal(); }

function koOpenModal(html) {
  $('#modal-host').innerHTML = `<div class="modal-overlay"><div class="modal ko-modal">${html}</div></div>`;
  $('.modal-overlay').addEventListener('click', (e) => { if (e.target.classList.contains('modal-overlay')) closeKo(); });
}

function koDraftField(pfx, side) {
  const map = { ks: ['h', 'a'], et: ['et_h', 'et_a'], pn: ['pen_h', 'pen_a'] };
  return map[pfx][side === 'h' ? 0 : 1];
}

function koScoreRow(m, hVal, aVal, pfx) {
  const th = koSide(m, 'h'), ta = koSide(m, 'a');
  const cell = (side, val, t) => `
    <div class="ko-sc-cell">
      <div class="ko-sc-team"><span class="flag">${t.flag}</span><span class="tn">${esc(t.name)}</span></div>
      <div class="stepper">
        <button class="step-btn" data-pfx="${pfx}" data-side="${side}" data-act="inc">+</button>
        <input class="score-num" id="${pfx}-${side}" type="number" inputmode="numeric" min="0" max="20" value="${val ?? ''}" placeholder="-">
        <button class="step-btn" data-pfx="${pfx}" data-side="${side}" data-act="dec">−</button>
      </div>
    </div>`;
  return `<div class="ko-score-row">${cell('a', aVal, ta)}<span class="score-sep">:</span>${cell('h', hVal, th)}</div>`;
}

function renderKoStep() {
  const m = S.matches.find((x) => x.id === koDraft.mid);
  if (!m) { closeKo(); return; }
  const th = koSide(m, 'h'), ta = koSide(m, 'a');
  const advT = koDraft.adv ? (S.teamMap[koDraft.adv] || {}) : null;
  const advName = advT ? `${advT.flag} ${esc(advT.name_ar || '')}` : '';
  const step = koDraft.step;
  const dots = [1, 2, 3].map((n) => `<span class="ko-dot ${step >= n ? 'on' : ''}"></span>`).join('');
  const head = `
    <div class="ko-cas-head">
      <span class="ko-cas-stage">${STAGES[m.stage]} • توقّع إقصائي</span>
      <h3>${ta.flag} ${esc(ta.name)} <span class="ko-vs">×</span> ${th.flag} ${esc(th.name)}</h3>
      <div class="ko-dots">${dots}</div>
    </div>`;
  let body = '';

  if (step === 1) {
    body = `
      <div class="ko-q">مين بيتأهّل للدور الجاي؟</div>
      <div class="ko-pick2">
        <button class="ko-team ${koDraft.adv === m.home ? 'sel' : ''}" data-adv="${m.home}"><span class="flag">${th.flag}</span><span>${esc(th.name)}</span></button>
        <button class="ko-team ${koDraft.adv === m.away ? 'sel' : ''}" data-adv="${m.away}"><span class="flag">${ta.flag}</span><span>${esc(ta.name)}</span></button>
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" id="koCancel">إلغاء</button><button class="btn" id="koNext" ${koDraft.adv ? '' : 'disabled'}>التالي ←</button></div>`;
  } else if (step === 2) {
    body = `
      <div class="ko-q">شو نتيجة الوقت الأصلي؟ <span class="ko-q-sub">٩٠ دقيقة</span></div>
      <div class="ko-hint">توقّعت يتأهّل <b>${advName}</b> — لو حطّيت فوز لازم يكون إلو</div>
      ${koScoreRow(m, koDraft.h, koDraft.a, 'ks')}
      <div class="modal-actions"><button class="btn btn-ghost" id="koBack">رجوع</button><button class="btn" id="koNext">تابع ←</button></div>`;
  } else if (step === 3) {
    body = `
      <div class="ko-q">تعادل ${koDraft.h}-${koDraft.a}! لوين رايحة؟</div>
      <div class="ko-pick2 col">
        <button class="ko-opt" data-go="et"><b>${advName}</b> بتحسمها بالوقت الإضافي</button>
        <button class="ko-opt" data-go="pens">بيضل تعادل ← ركلات ترجيح 🥅</button>
      </div>
      <div class="modal-actions"><button class="btn btn-ghost" id="koBack">رجوع</button></div>`;
  } else if (step === 4) {
    body = `
      <div class="ko-q">نتيجة نهاية الوقت الإضافي</div>
      <div class="ko-hint">لازم تطلع لصالح <b>${advName}</b></div>
      ${koScoreRow(m, koDraft.et_h ?? koDraft.h, koDraft.et_a ?? koDraft.a, 'et')}
      <div class="modal-actions"><button class="btn btn-ghost" id="koBack">رجوع</button><button class="btn" id="koSave">احفظ ✓</button></div>`;
  } else if (step === 5) {
    body = `
      <div class="ko-q">راحت ركلات ترجيح 🥅</div>
      <div class="ko-sub">تعادلوا بنهاية الإضافي بكم؟</div>
      ${koScoreRow(m, koDraft.et_h ?? koDraft.h, koDraft.et_a ?? koDraft.a, 'et')}
      <div class="ko-sub">ومين بياخد الترجيح وبكم؟ (<b>${advName}</b>)</div>
      ${koScoreRow(m, koDraft.pen_h, koDraft.pen_a, 'pn')}
      <div class="modal-actions"><button class="btn btn-ghost" id="koBack">رجوع</button><button class="btn" id="koSave">احفظ ✓</button></div>`;
  }

  koOpenModal(`${head}${body}`);
  bindKoStep(m);
}

function bindKoStep(m) {
  const adv = koDraft.adv;
  const advName = () => { const t = S.teamMap[adv] || {}; return t.name_ar || 'اللي اخترته'; };

  const c = $('#koCancel'); if (c) c.onclick = closeKo;
  const b = $('#koBack'); if (b) b.onclick = () => {
    koDraft.step = koDraft.step === 2 ? 1 : koDraft.step === 3 ? 2 : 3;
    renderKoStep();
  };

  $$('.ko-team').forEach((btn) => { btn.onclick = () => { koDraft.adv = btn.dataset.adv; renderKoStep(); }; });
  $$('.ko-opt').forEach((btn) => { btn.onclick = () => { koDraft.decided_by = btn.dataset.go; koDraft.step = btn.dataset.go === 'et' ? 4 : 5; renderKoStep(); }; });

  $$('.ko-score-row .step-btn').forEach((btn) => { btn.onclick = () => {
    const { pfx, side } = btn.dataset;
    const inp = $(`#${pfx}-${side}`);
    let v = inp.value === '' ? -1 : parseInt(inp.value, 10);
    v = btn.dataset.act === 'inc' ? v + 1 : v - 1;
    v = Math.max(0, Math.min(20, v));
    inp.value = v;
    inp.classList.remove('pop'); void inp.offsetWidth; inp.classList.add('pop');
    koDraft[koDraftField(pfx, side)] = v;
    const oside = side === 'h' ? 'a' : 'h';
    const other = $(`#${pfx}-${oside}`);
    if (other && other.value === '') { other.value = 0; koDraft[koDraftField(pfx, oside)] = 0; }
  }; });
  $$('.ko-score-row .score-num').forEach((inp) => { inp.oninput = () => {
    const i = inp.id.indexOf('-');
    const pfx = inp.id.slice(0, i), side = inp.id.slice(i + 1);
    let v = inp.value === '' ? null : Math.max(0, Math.min(20, parseInt(inp.value, 10) || 0));
    if (v !== null) inp.value = v;
    koDraft[koDraftField(pfx, side)] = v;
  }; });

  const next = $('#koNext'); if (next) next.onclick = () => {
    if (koDraft.step === 1) { if (!koDraft.adv) return; koDraft.step = 2; return renderKoStep(); }
    if (koDraft.h == null || koDraft.a == null) return toast('كمّل النتيجة', 'err');
    if (koDraft.h === koDraft.a) { koDraft.step = 3; return renderKoStep(); }
    const winCode = koDraft.h > koDraft.a ? m.home : m.away;
    if (winCode !== adv) return toast(`لازم النتيجة تكون لصالح ${advName()} لأنك توقّعته يتأهّل`, 'err', 4000);
    koDraft.decided_by = 'reg';
    saveKoPrediction();
  };

  const save = $('#koSave'); if (save) save.onclick = () => {
    if (koDraft.et_h == null || koDraft.et_a == null) return toast('كمّل نتيجة الوقت الإضافي', 'err');
    // الأهداف ما بترجع: نتيجة الإضافي لازم تكون ≥ نتيجة الـ90 لكل فريق
    if (koDraft.et_h < koDraft.h || koDraft.et_a < koDraft.a) return toast('نتيجة الإضافي ما بتنقص عن الـ90 (الأهداف ما بترجع للوراء)', 'err', 4500);
    if (koDraft.step === 4) {
      if (koDraft.et_h === koDraft.et_a) return toast('الحسم بالإضافي بدّو فائز — مو تعادل', 'err');
      const winCode = koDraft.et_h > koDraft.et_a ? m.home : m.away;
      if (winCode !== adv) return toast(`نتيجة الإضافي لازم تكون لصالح ${advName()}`, 'err', 4000);
      koDraft.decided_by = 'et';
    } else {
      if (koDraft.et_h !== koDraft.et_a) return toast('بمسار الترجيح لازم الإضافي يضل تعادل', 'err');
      if (koDraft.pen_h == null || koDraft.pen_a == null) return toast('كمّل نتيجة ركلات الترجيح', 'err');
      if (koDraft.pen_h === koDraft.pen_a) return toast('لازم يطلع فائز بركلات الترجيح', 'err');
      if (!validPenScore(koDraft.pen_h, koDraft.pen_a)) return toast('نتيجة ترجيح غير منطقية — بتنحسم أبكر (مثلاً 5-0 ما بتصير)', 'err', 5000);
      const winCode = koDraft.pen_h > koDraft.pen_a ? m.home : m.away;
      if (winCode !== adv) return toast(`فائز الترجيح لازم يكون ${advName()}`, 'err', 4000);
      koDraft.decided_by = 'pens';
    }
    saveKoPrediction();
  };
}

async function saveKoPrediction() {
  const mid = koDraft.mid;
  const m = S.matches.find((x) => x.id === mid);
  if (!m || !['open', 'soon'].includes(matchPhase(m))) { toast('خلص الوقت — انقفل التوقع', 'err'); closeKo(); renderView(); return; }
  const dby = koDraft.decided_by;
  const payload = {
    user_id: S.session.user.id, match_id: mid,
    home_score: koDraft.h, away_score: koDraft.a,
    adv: koDraft.adv, decided_by: dby,
    et_home: dby === 'reg' ? null : koDraft.et_h,
    et_away: dby === 'reg' ? null : koDraft.et_a,
    pen_home: dby === 'pens' ? koDraft.pen_h : null,
    pen_away: dby === 'pens' ? koDraft.pen_a : null,
  };
  const { error } = await S.sb.from('predictions').upsert(payload, { onConflict: 'user_id,match_id' });
  if (error) { toast(/policy|row-level/i.test(error.message) ? 'انقفل التوقع' : 'ما انحفظ — جرّب كمان مرة', 'err'); return; }
  S.myPreds.set(mid, payload);
  closeKo();
  celebrate(60);
  toast('انحفظ توقّعك للإقصائي ✅');
  renderView();
}

/* ============================================================
   سجل النقاط
   ============================================================ */
function renderLog() {
  const me = S.session.user.id;
  const hasTypes = S.leaderboard.some((r) => r.player_type != null);
  const visibleIds = hasTypes
    ? new Set(myLeagueKeys().flatMap((k) => leagueRows(k).map((x) => x.r.id)))
    : new Set(S.leaderboard.map((r) => r.id));
  if (!S.logUser || !visibleIds.has(S.logUser)) S.logUser = me;
  const row = S.leaderboard.find((r) => r.id === S.logUser) || { display_name: '...', total: 0, match_points: 0, golden_points: 0, champion_points: 0, exact_count: 0, winner_count: 0 };
  const isMe = S.logUser === me;
  const reveal = !!S.state?.reveal_picks;

  const entries = S.log.filter((l) => l.user_id === S.logUser);

  // مباريات منتهية توقعها هذا اللاعب بدون نقاط (للأمانة الكاملة 😄)
  const zeroRows = S.allPreds
    .filter((p) => p.user_id === S.logUser)
    .map((p) => ({ p, m: S.matches.find((m) => m.id === p.match_id) }))
    .filter(({ p, m }) => m && m.finished && m.home_score != null && m.away_score != null && !entries.some((e) => e.match_id === m.id));

  const matchEntries = entries.filter((e) => e.match_id != null)
    .sort((x, y) => new Date(S.matches.find((m) => m.id === y.match_id)?.kickoff || 0) - new Date(S.matches.find((m) => m.id === x.match_id)?.kickoff || 0));
  const bonusEntries = entries.filter((e) => e.match_id == null);

  // الاختيارات السرية (لي أو للجميع بعد الكشف)
  let picksHtml = '';
  if (isMe || reveal) {
    const ch = S.allChampions.find((c) => c.user_id === S.logUser);
    const gd = S.allGoldens.find((g) => g.user_id === S.logUser);
    if (ch || gd) {
      picksHtml = `
      <div class="card" style="margin-bottom:14px">
        <div style="font-weight:800;font-size:13.5px;margin-bottom:9px">${isMe && !reveal ? '🤫 اختياراتك السرية (ما حدا شايفها غيرك)' : '🔮 الاختيارات'}</div>
        ${ch ? `<div style="font-size:13.5px;font-weight:700;margin-bottom:5px">🏆 البطل المتوقع: ${S.teamMap[ch.team]?.flag || ''} ${esc(S.teamMap[ch.team]?.name_ar || ch.team)}</div>` : ''}
        ${gd ? `<div style="font-size:13.5px;font-weight:700">⭐ المربع الذهبي: ${gd.teams.map((t) => `${S.teamMap[t]?.flag || ''} ${esc(S.teamMap[t]?.name_ar || t)}`).join(' • ')}</div>` : ''}
      </div>`;
    }
  }

  const logItem = (icon, note, sub, pts, zero = false, d = 0) => `
    <div class="card log-item" style="animation-delay:${Math.min(d * 0.04, 0.4)}s">
      <span class="log-ico">${icon}</span>
      <div class="log-note">${note}${sub ? `<div class="log-sub">${sub}</div>` : ''}</div>
      <span class="log-pts ${zero ? 'zero' : ''}">${zero ? '0' : '+' + pts}</span>
    </div>`;

  let d = 0;
  const itemsHtml = [
    ...bonusEntries.map((e) => logItem(e.category === 'champion' ? '🏆' : '⭐', esc(e.note), '', e.points, false, d++)),
    ...matchEntries.map((e) => {
      const m = S.matches.find((mm) => mm.id === e.match_id);
      const sub = m ? `${esc(fmtDay(m.kickoff))}` : '';
      return logItem(e.category === 'exact' ? '🎯' : '✅', esc(e.note), sub, e.points, false, d++);
    }),
    ...zeroRows.map(({ p, m }) => {
      const th = S.teamMap[m.home], ta = S.teamMap[m.away];
      return logItem('😢', `ما حالفه الحظ: ${esc(th?.name_ar)} ${m.home_score} - ${m.away_score} ${esc(ta?.name_ar)}`, `توقّع ${p.home_score} - ${p.away_score} • ${esc(fmtDay(m.kickoff))}`, 0, true, d++);
    }),
  ].join('');

  $('#root').innerHTML = `
  <div class="view">
    <h2 class="section-title"><svg class="st-ico" style="color:var(--wc-green)"><use href="#i-chart"/></svg> سجل النقاط</h2>
    <div class="player-chips">
      ${S.leaderboard.filter((r) => visibleIds.has(r.id)).map((r) => `<button class="p-chip ${r.id === S.logUser ? 'active' : ''}" data-uid="${r.id}">${esc(r.display_name)}${r.id === me ? ' (أنت)' : ''}</button>`).join('')}
    </div>
    <div class="log-summary">
      <div class="card log-stat"><div class="v" style="color:var(--gold)">${row.total}</div><div class="k">المجموع</div></div>
      <div class="card log-stat"><div class="v">${row.match_points}</div><div class="k">نقاط المباريات</div></div>
      <div class="card log-stat"><div class="v">${row.exact_count}</div><div class="k">نتيجة بالضبط 🎯</div></div>
      <div class="card log-stat"><div class="v">${row.golden_points + row.champion_points}</div><div class="k">مربع + بطل</div></div>
    </div>
    ${picksHtml}
    <div class="log-list">
      ${itemsHtml || `<div class="empty-note"><span class="big">🕰️</span>لسا ما في شي بالسجل — أول ما تخلص مباراة بتشوف النقاط هون</div>`}
    </div>
  </div>`;

  $$('.p-chip').forEach((b) => b.addEventListener('click', () => { S.logUser = b.dataset.uid; renderLog(); }));
}

/* ============================================================
   اختيار البطل والمربع الذهبي (مرة واحدة، سري)
   ============================================================ */
const onb = { champion: null, golden: [] };

function renderOnboarding(step) {
  S.onboarding = true;
  $('#navbar').classList.add('hidden');
  const deadline = new Date(S.state.picks_deadline);

  if (step === 1) {
    $('#root').innerHTML = `
    <div class="view onb-wrap">
      <div class="onb-head">
        <span class="big-ico"><svg width="52" height="52" style="color:var(--gold)" aria-hidden="true"><use href="#i-trophy"/></svg></span>
        <h2>مين رح يكون بطل العالم؟</h2>
        <p>اختار منتخب واحد — هالتوقع بيتسجل <b>لمرة وحدة بس</b> وما فيك تغيّره!</p>
        <span class="secret-tag">🤫 سري تماماً — ما حدا بيشوفه غيرك</span>
        <p style="font-size:12px;margin-top:8px">⏳ آخر موعد للاختيار: ${esc(fmtDay(deadline))} • ${esc(fmtTime(deadline))}</p>
      </div>
      <input class="input team-search" id="teamSearch" placeholder="دوّر على منتخب...">
      <div class="teams-grid" id="teamsGrid"></div>
      <div class="onb-foot">
        <button class="btn btn-block" id="nextBtn" disabled>اختار البطل أولاً</button>
      </div>
    </div>`;
    drawTeamGrid(1);
  } else {
    // مصالحة المربع مع البطل الحالي (يمكن المستخدم رجع وغيّر بطله)
    const champNow = onb.champion || S.myChampion?.team || null;
    if (onb.goldenChamp && onb.goldenChamp !== champNow) {
      onb.golden = onb.golden.filter((c) => c !== onb.goldenChamp);
    }
    onb.goldenChamp = champNow;
    if (champNow && !onb.golden.includes(champNow)) {
      onb.golden = [champNow, ...onb.golden].slice(0, 4);
    }
    $('#root').innerHTML = `
    <div class="view onb-wrap">
      <div class="onb-head">
        <span class="big-ico"><svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.2l2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.6l6.1-.9z"/></svg></span>
        <h2>المربع الذهبي</h2>
        <p>مين الـ 4 منتخبات اللي رح توصل لنص النهائي؟ بطلك محسوب تلقائياً، اختار <b>3 كمان</b></p>
        <span class="secret-tag">🤫 سري تماماً — لمرة وحدة بس</span>
      </div>
      <input class="input team-search" id="teamSearch" placeholder="دوّر على منتخب...">
      <div class="teams-grid" id="teamsGrid"></div>
      <div class="onb-foot">
        ${!S.myChampion ? '<button class="btn btn-ghost" id="backBtn">رجوع</button>' : ''}
        <span class="pick-count" id="pickCount"></span>
        <button class="btn btn-block" id="nextBtn" disabled>كمّل الأربعة</button>
      </div>
    </div>`;
    drawTeamGrid(2);
    const back = $('#backBtn');
    if (back) back.onclick = () => renderOnboarding(1);
  }

  $('#teamSearch').addEventListener('input', () => drawTeamGrid(step));
}

function drawTeamGrid(step) {
  const q = ($('#teamSearch')?.value || '').trim();
  const champ = onb.champion || S.myChampion?.team || null;
  const list = S.teams.filter((t) => teamSearchMatch(t, q));
  if (q) list.sort((a, b) => teamSearchRank(a, q) - teamSearchRank(b, q));

  $('#teamsGrid').innerHTML = list.map((t) => {
    const isChamp = t.code === champ;
    const sel = step === 1 ? onb.champion === t.code : onb.golden.includes(t.code);
    const cls = step === 2 && isChamp ? 'locked selected' : sel ? 'selected' : '';
    return `<button class="team-pick ${cls}" data-code="${t.code}" ${step === 2 && isChamp ? 'disabled' : ''}>
      <span class="flag">${t.flag}</span><span class="tname">${esc(t.name_ar)}</span>
    </button>`;
  }).join('');

  $$('#teamsGrid .team-pick').forEach((b) => b.addEventListener('click', () => {
    const code = b.dataset.code;
    if (step === 1) {
      onb.champion = code;
    } else {
      if (code === champ) return;
      if (onb.golden.includes(code)) onb.golden = onb.golden.filter((c) => c !== code);
      else if (onb.golden.length < 4) onb.golden.push(code);
      else { toast('المربع 4 منتخبات بس! شيل واحد قبل', 'err'); return; }
    }
    drawTeamGrid(step);
  }));

  const btn = $('#nextBtn');
  if (step === 1) {
    btn.disabled = !onb.champion;
    btn.textContent = onb.champion ? `بطلي: ${S.teamMap[onb.champion].flag} ${S.teamMap[onb.champion].name_ar} — التالي` : 'اختار البطل أولاً';
    btn.onclick = () => { if (onb.champion) renderOnboarding(2); };
  } else {
    const n = onb.golden.length;
    $('#pickCount').textContent = `${n}/4`;
    btn.disabled = n !== 4;
    btn.textContent = n === 4 ? 'تأكيد الاختيارات' : `كمّل الأربعة (${n}/4)`;
    btn.onclick = () => { if (n === 4) confirmPicks(); };
  }
}

function confirmPicks() {
  const champ = onb.champion || S.myChampion?.team;
  openModal(`
    <h3>قرار نهائي!</h3>
    <div class="modal-body">
      هاي الاختيارات بتنحفظ <b>لمرة وحدة وللأبد</b> — ولا حدا بيشوفها غيرك:
      <div style="margin-top:12px;color:var(--text);font-weight:800">
        البطل: ${S.teamMap[champ].flag} ${esc(S.teamMap[champ].name_ar)}<br><br>
        المربع الذهبي:<br>${onb.golden.map((c) => `${S.teamMap[c].flag} ${esc(S.teamMap[c].name_ar)}`).join('<br>')}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="cancelPicks">رجوع</button>
      <button class="btn" id="okPicks">أكيد، اعتمد!</button>
    </div>`);
  $('#cancelPicks').onclick = closeModal;
  $('#okPicks').onclick = submitPicks;
}

async function submitPicks() {
  const btn = $('#okPicks');
  const uid = S.session.user.id;
  const champ = onb.champion || S.myChampion?.team;
  if (champ && !S.myGolden && !onb.golden.includes(champ)) {
    toast('لازم بطلك يكون ضمن المربع الذهبي — رجاع اختار', 'err');
    closeModal();
    return;
  }
  btn.disabled = true; btn.textContent = 'لحظة...';

  try {
    if (!S.myChampion) {
      const { error } = await S.sb.from('champion_picks').insert({ user_id: uid, team: champ });
      if (error && !/duplicate/i.test(error.message)) throw error;
    }
    if (!S.myGolden) {
      const { error } = await S.sb.from('golden_picks').insert({ user_id: uid, teams: onb.golden });
      if (error && !/duplicate/i.test(error.message)) throw error;
    }
  } catch (err) {
    closeModal();
    const msg = /policy|row-level/i.test(err.message) ? 'خلص الموعد النهائي للاختيار 😔' : mapAuthError(err.message);
    toast(msg, 'err', 4500);
    await loadAll().catch(() => {});
    S.onboarding = false;
    renderShell(); renderView();
    return;
  }

  closeModal();
  celebrate();
  toast('انحفظت اختياراتك السرية! بالتوفيق 🍀', 'ok', 4000);
  await loadAll().catch(() => {});
  S.onboarding = false;
  renderShell();
  S.view = 'home';
  renderView();
}

/* ============================================================
   حسابي
   ============================================================ */
function openProfile() {
  if (!S.profile || !S.state) return;
  const ch = S.myChampion ? S.teamMap[S.myChampion.team] : null;
  const gd = S.myGolden;
  const deadlineOpen = S.state && Date.now() < new Date(S.state.picks_deadline).getTime();

  openModal(`
    <h3>${esc(S.profile.display_name)} ${S.profile.is_admin ? '<span style="font-size:12px;color:var(--gold)">أدمن</span>' : ''}</h3>
    <div class="modal-body">
      <div class="my-picks">
        <div class="card my-pick-row">
          <span class="flag">${ch ? ch.flag : '—'}</span>
          <div><div class="lbl">بطلك السري</div><div class="val">${ch ? esc(ch.name_ar) : deadlineOpen ? 'لسا ما اخترت!' : 'فات الموعد'}</div></div>
        </div>
        <div class="card my-pick-row">
          <span class="flag"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.2l2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.6l6.1-.9z"/></svg></span>
          <div><div class="lbl">مربعك الذهبي السري</div><div class="val">${gd ? gd.teams.map((t) => S.teamMap[t]?.flag || '').join(' ') + '<br><span style="font-size:12px">' + gd.teams.map((t) => esc(S.teamMap[t]?.name_ar || t)).join(' • ') + '</span>' : deadlineOpen ? 'لسا ما اخترت!' : 'فات الموعد'}</div></div>
        </div>
        ${(!ch || !gd) && deadlineOpen ? '<button class="btn" id="goPicks">اختار هلق</button>' : ''}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="closeProfile">إغلاق</button>
      <button class="btn btn-danger" id="logoutBtn">تسجيل خروج</button>
    </div>`);

  $('#closeProfile').onclick = closeModal;
  $('#logoutBtn').onclick = async () => { await S.sb.auth.signOut(); };
  const gp = $('#goPicks');
  if (gp) gp.onclick = () => { closeModal(); renderOnboarding(!S.myChampion ? 1 : 2); };
}

/* ============================================================
   الإدارة
   ============================================================ */
const adminTimers = new Map();

/* بطاقة إدخال نتيجة (مجموعات بسيطة / إقصائي كامل) */
function adminMatchCard(m) {
  const ko = m.stage !== 'group';
  const ss = `<span class="save-state ${m.finished ? 'ok' : ''}">${m.finished ? '✓ محفوظة' : ''}</span>`;
  if (!ko) {
    const th = S.teamMap[m.home], ta = S.teamMap[m.away];
    return `
    <div class="card admin-match" data-mid="${m.id}" data-ko="0">
      <div class="am-teams">${th?.flag || ''} ${esc(th?.name_ar || m.home)} × ${esc(ta?.name_ar || m.away)} ${ta?.flag || ''}
        <span class="am-date">${esc(fmtDay(m.kickoff))} • ${esc(fmtTime(m.kickoff))} • ج${m.round}</span>
      </div>
      <div class="admin-score">
        <input type="number" min="0" max="99" data-f="h" value="${m.home_score ?? ''}" placeholder="-">
        <span>:</span>
        <input type="number" min="0" max="99" data-f="a" value="${m.away_score ?? ''}" placeholder="-">
      </div>
      <label class="check-row"><input type="checkbox" data-f="fin" ${m.finished ? 'checked' : ''}> انتهت</label>
      ${ss}
    </div>`;
  }
  const th = S.teamMap[m.home], ta = S.teamMap[m.away];
  const teamOpts = (sel) => '<option value="">— يتحدد —</option>' + S.teams.map((t) => `<option value="${t.code}" ${sel === t.code ? 'selected' : ''}>${esc(t.name_ar)}</option>`).join('');
  const winOpts = '<option value="">— مين تأهّل —</option>'
    + (m.home ? `<option value="${m.home}" ${m.winner === m.home ? 'selected' : ''}>${esc(th?.name_ar || m.home)}</option>` : '')
    + (m.away ? `<option value="${m.away}" ${m.winner === m.away ? 'selected' : ''}>${esc(ta?.name_ar || m.away)}</option>` : '');
  return `
  <div class="card admin-match ko-admin" data-mid="${m.id}" data-ko="1">
    <div class="am-head">
      <span class="am-date">${STAGES[m.stage]} • ${esc(fmtDay(m.kickoff))} ${esc(fmtTime(m.kickoff))}${m.venue ? ' • ' + esc(m.venue) : ''}</span>
      <div class="am-ko-teams">
        <select class="input input-sm" data-f="home">${teamOpts(m.home)}</select>
        <span class="am-x">×</span>
        <select class="input input-sm" data-f="away">${teamOpts(m.away)}</select>
      </div>
      <div class="am-slots">${esc(m.home_slot || '')} × ${esc(m.away_slot || '')}</div>
    </div>
    <div class="am-ko-grid">
      <div class="am-fieldlet"><label>الوقت الأصلي</label><div class="admin-score"><input type="number" min="0" max="30" data-f="h" value="${m.home_score ?? ''}" placeholder="-"><span>:</span><input type="number" min="0" max="30" data-f="a" value="${m.away_score ?? ''}" placeholder="-"></div></div>
      <div class="am-fieldlet"><label>كيف حُسمت</label><select class="input input-sm" data-f="dby"><option value="">—</option><option value="reg" ${m.decided_by === 'reg' ? 'selected' : ''}>الأصلي</option><option value="et" ${m.decided_by === 'et' ? 'selected' : ''}>الإضافي</option><option value="pens" ${m.decided_by === 'pens' ? 'selected' : ''}>ترجيح</option></select></div>
      <div class="am-fieldlet"><label>المتأهّل</label><select class="input input-sm" data-f="win">${winOpts}</select></div>
      <div class="am-fieldlet"><label>الإضافي</label><div class="admin-score"><input type="number" min="0" max="30" data-f="eth" value="${m.et_home ?? ''}" placeholder="-"><span>:</span><input type="number" min="0" max="30" data-f="eta" value="${m.et_away ?? ''}" placeholder="-"></div></div>
      <div class="am-fieldlet"><label>الترجيح</label><div class="admin-score"><input type="number" min="0" max="30" data-f="ph" value="${m.pen_home ?? ''}" placeholder="-"><span>:</span><input type="number" min="0" max="30" data-f="pa" value="${m.pen_away ?? ''}" placeholder="-"></div></div>
    </div>
    <div class="am-foot"><label class="check-row"><input type="checkbox" data-f="fin" ${m.finished ? 'checked' : ''}> انتهت</label>${ss}</div>
  </div>`;
}

/* حفظ تلقائي لنتيجة مباراة (بدون إعادة تحميل كامل) */
async function adminSaveMatch(card) {
  const mid = +card.dataset.mid;
  const m = S.matches.find((x) => x.id === mid);
  if (!m) return;
  const ko = card.dataset.ko === '1';
  const st = card.querySelector('.save-state');
  const setMsg = (t, ok = false) => { if (st) { st.textContent = t; st.classList.toggle('ok', ok); st.classList.toggle('err', !ok && t && t !== '✓ انحفظ'); } };
  const g = (f) => card.querySelector(`[data-f="${f}"]`);
  const numv = (f) => { const v = g(f)?.value; return v === '' || v == null ? null : +v; };
  const fin = g('fin')?.checked || false;
  let upd;
  if (!ko) {
    const h = numv('h'), a = numv('a');
    if (fin && (h == null || a == null)) { setMsg('حط النتيجة قبل "انتهت"'); return; }
    upd = { home_score: h, away_score: a, finished: fin };
  } else {
    const home = g('home')?.value || null, away = g('away')?.value || null;
    if (home && away && home === away) { setMsg('الفريقين نفس بعض'); return; }
    const dby = g('dby')?.value || null, win = g('win')?.value || null;
    const h = numv('h'), a = numv('a'), eth = numv('eth'), eta = numv('eta'), ph = numv('ph'), pa = numv('pa');
    if (fin) {
      if (!home || !away) { setMsg('حدّد الفريقين أول'); return; }
      if (h == null || a == null || !dby || !win) { setMsg('كمّل النتيجة والحسم والمتأهّل'); return; }
      if (dby === 'reg' && h === a) { setMsg('الحسم بالوقت الأصلي بدّو فائز (مو تعادل)'); return; }
      if (dby === 'et' || dby === 'pens') {
        if (h !== a) { setMsg('لازم الوقت الأصلي تعادل ليروح لإضافي/ترجيح'); return; }
        if (eth == null || eta == null) { setMsg('حط نتيجة الإضافي'); return; }
        if (eth < h || eta < a) { setMsg('نتيجة الإضافي ما بتنقص عن الأصلي'); return; }
      }
      if (dby === 'et' && eth === eta) { setMsg('الحسم بالإضافي بدّو فائز'); return; }
      if (dby === 'pens') {
        if (eth !== eta) { setMsg('بالترجيح لازم الإضافي يضل تعادل'); return; }
        if (ph == null || pa == null) { setMsg('حط نتيجة الترجيح'); return; }
        if (!validPenScore(ph, pa)) { setMsg('نتيجة ترجيح غير منطقية (مثل 5-0)'); return; }
      }
      const realWin = dby === 'pens' ? (ph > pa ? home : away) : dby === 'et' ? (eth > eta ? home : away) : (h > a ? home : away);
      if (win !== realWin) { setMsg('المتأهّل ما بيطابق النتيجة'); return; }
    }
    upd = {
      home, away, home_score: h, away_score: a, decided_by: dby, winner: win,
      et_home: (dby === 'et' || dby === 'pens') ? eth : null,
      et_away: (dby === 'et' || dby === 'pens') ? eta : null,
      pen_home: dby === 'pens' ? ph : null,
      pen_away: dby === 'pens' ? pa : null,
      finished: fin,
    };
  }
  const { error } = await S.sb.from('matches').update(upd).eq('id', mid);
  if (error) { setMsg('ما انحفظ: ' + error.message); return; }
  Object.assign(m, upd);
  setMsg('✓ انحفظ', true);
}

function bindAdminMatches() {
  $$('.admin-match').forEach((card) => {
    const mid = +card.dataset.mid;
    card.querySelectorAll('input, select').forEach((el) => {
      const f = el.dataset.f;
      if (f === 'home' || f === 'away') {
        el.addEventListener('change', async () => { await adminSaveMatch(card); renderAdmin(); });
        return;
      }
      const evName = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
      el.addEventListener(evName, () => {
        const stt = card.querySelector('.save-state');
        if (stt) { stt.textContent = 'عم نحفظ...'; stt.classList.remove('ok', 'err'); }
        clearTimeout(adminTimers.get(mid));
        adminTimers.set(mid, setTimeout(() => adminSaveMatch(card), 600));
      });
    });
  });
}

function renderAdmin() {
  if (!S.profile?.is_admin) { S.view = 'home'; return renderHome(); }
  const st = S.state;
  const toLocalInput = (iso) => {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const unfinished = S.matches.filter((m) => !m.finished && (
    new Date(m.kickoff).getTime() <= Date.now() + 36e5 * 3 ||
    (m.stage !== 'group' && (!m.home || !m.away) && new Date(m.kickoff).getTime() <= Date.now() + 5 * 864e5)
  ));
  const adminList = (S.adminShowAll ? S.matches : unfinished);

  $('#root').innerHTML = `
  <div class="view">
    <h2 class="section-title"><svg class="st-ico" style="color:var(--wc-red)"><use href="#i-gear"/></svg> لوحة الإدارة</h2>

    <div class="admin-section">
      <h3 class="section-title" style="font-size:16px">النتائج</h3>
      <div class="card" style="margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <div style="flex:1;min-width:200px;font-size:12.5px;color:var(--muted);font-weight:700">النتائج بتنجلب تلقائياً كل 10 دقايق — وبتقدر تعدّل يدوياً بأي وقت</div>
        <button class="btn btn-sm" id="fetchNow">جلب النتائج هلق</button>
      </div>
      <label class="check-row" style="margin-bottom:10px"><input type="checkbox" id="showAllMatches" ${S.adminShowAll ? 'checked' : ''}> عرض كل المباريات (مو بس اللي بدها نتيجة)</label>
      <div class="ko-hint-admin">💡 النتائج بتنحفظ تلقائياً أول ما تغيّر أي رقم. للإقصائي: حدّد الفريقين أول (تطلع من الخانات)، بعدين النتيجة والمتأهّل.</div>
      <div class="lb-list">
        ${adminList.length === 0 ? '<div class="empty-note">ما في مباريات بحاجة نتيجة هلق ✅</div>' : ''}
        ${adminList.map(adminMatchCard).join('')}
      </div>
    </div>

    <div class="admin-section">
      <h3 class="section-title" style="font-size:16px">المربع الذهبي الفعلي <span style="font-size:11px;color:var(--muted)">(اختار 4 أول ما يتحددوا)</span></h3>
      <div class="teams-grid" id="goldenGrid">
        ${S.teams.map((t) => `<button class="team-pick ${st.golden_teams.includes(t.code) ? 'selected' : ''}" data-gcode="${t.code}"><span class="flag">${t.flag}</span><span class="tname">${esc(t.name_ar)}</span></button>`).join('')}
      </div>
      <button class="btn btn-sm" id="saveGolden" style="margin-top:10px">حفظ المربع الذهبي</button>
    </div>

    <div class="admin-section">
      <h3 class="section-title" style="font-size:16px">البطل الفعلي والكشف</h3>
      <div class="card">
        <div class="field">
          <label>بطل العالم 2026 (اتركه فاضي لحد ما تخلص البطولة)</label>
          <select class="input" id="champSelect">
            <option value="">— لسا ما في بطل —</option>
            ${S.teams.map((t) => `<option value="${t.code}" ${st.champion === t.code ? 'selected' : ''}>${esc(t.name_ar)}</option>`).join('')}
          </select>
        </div>
        <label class="check-row" style="margin-bottom:12px"><input type="checkbox" id="revealPicks" ${st.reveal_picks ? 'checked' : ''}> 🎭 كشف التوقعات السرية للجميع (بعد نهاية البطولة)</label>
        <button class="btn btn-sm" id="saveChamp">حفظ</button>
      </div>
    </div>

    <div class="admin-section">
      <h3 class="section-title" style="font-size:16px">الإعدادات</h3>
      <div class="card">
        <div class="settings-grid">
          <div class="field"><label>نقاط معرفة الفائز</label><input class="input" id="pWin" type="number" min="0" value="${st.points_win}"></div>
          <div class="field"><label>نقاط النتيجة بالضبط</label><input class="input" id="pExact" type="number" min="0" value="${st.points_exact}"></div>
          <div class="field"><label>نقاط المربع الذهبي</label><input class="input" id="pGolden" type="number" min="0" value="${st.points_golden}"></div>
          <div class="field"><label>نقاط البطل</label><input class="input" id="pChamp" type="number" min="0" value="${st.points_champion}"></div>
          <div class="field"><label>إقصائي: المتأهّل</label><input class="input" id="pKoQ" type="number" min="0" value="${st.points_ko_qualify ?? 3}"></div>
          <div class="field"><label>إقصائي: الاتجاه</label><input class="input" id="pKoD" type="number" min="0" value="${st.points_ko_dir ?? 1}"></div>
          <div class="field"><label>إقصائي: كل نتيجة</label><input class="input" id="pKoE" type="number" min="0" value="${st.points_ko_exact ?? 2}"></div>
          <div class="field"><label>طريقة حساب المربع</label>
            <select class="input" id="gMode">
              <option value="per" ${st.golden_per_team ? 'selected' : ''}>نقاط عن كل منتخب صحيح</option>
              <option value="all" ${!st.golden_per_team ? 'selected' : ''}>النقاط فقط لو أصاب الأربعة</option>
            </select>
          </div>
          <div class="field"><label>آخر موعد لاختيار البطل/المربع</label><input class="input" id="deadline" type="datetime-local" value="${toLocalInput(st.picks_deadline)}"></div>
        </div>
        <button class="btn btn-sm" id="saveSettings">حفظ الإعدادات</button>
        <button class="btn btn-sm btn-ghost" id="recompute" style="margin-inline-start:8px">إعادة حساب كل النقاط</button>
      </div>
    </div>

    <div class="admin-section">
      <h3 class="section-title" style="font-size:16px">📣 بانر الرئيسية</h3>
      <div class="card">
        <label class="check-row" style="margin-bottom:12px"><input type="checkbox" id="bnOn" ${st.banner_on ? 'checked' : ''}> إظهار البانر بالصفحة الرئيسية</label>
        <div class="field"><label>نص البانر</label><input class="input" id="bnText" value="${esc(st.banner_text || '')}" placeholder="مثلاً: المسابقة برعاية مشروعي — اكتشفه!"></div>
        <div class="settings-grid">
          <div class="field"><label>رابط (اختياري — يبدأ بـ https)</label><input class="input" id="bnLink" value="${esc(st.banner_link || '')}" placeholder="https://..."></div>
          <div class="field"><label>نص الزر</label><input class="input" id="bnCta" value="${esc(st.banner_cta || '')}" placeholder="اكتشف"></div>
        </div>
        <button class="btn btn-sm" id="saveBanner">حفظ البانر</button>
      </div>
    </div>

    <div class="admin-section">
      <h3 class="section-title" style="font-size:16px">👥 اللاعبين والقوائم</h3>
      <div class="ko-hint-admin">«رفقات عمر» = نوع ١ و٢ (نقاط كاملة) · «العيلة» = نوع ٢ و٣ (إقصائي + مربع + بطل، بلا نقاط المجموعات). النوع بيتحفظ تلقائياً.</div>
      <div class="lb-list">
        ${[...S.leaderboard].sort((a, b) => (a.player_type || 9) - (b.player_type || 9) || a.display_name.localeCompare(b.display_name, 'ar')).map((r) => `
          <div class="card admin-player">
            <div class="ap-name">${esc(r.display_name)}${r.is_admin ? ' <span class="ap-admin">أدمن</span>' : ''}<span class="ap-pts">${r.total} نقطة</span></div>
            <select class="input input-sm ap-type" data-uid="${r.id}">
              <option value="1" ${r.player_type === 1 ? 'selected' : ''}>نوع ١ — رفقات عمر</option>
              <option value="2" ${r.player_type === 2 ? 'selected' : ''}>نوع ٢ — الاثنين</option>
              <option value="3" ${r.player_type === 3 ? 'selected' : ''}>نوع ٣ — العيلة</option>
            </select>
          </div>`).join('')}
      </div>
    </div>

    <div class="admin-section">
      <h3 class="section-title" style="font-size:16px">إضافة مباراة (الأدوار الإقصائية)</h3>
      <div class="card">
        <div class="settings-grid">
          <div class="field"><label>المرحلة</label>
            <select class="input" id="nmStage">${Object.entries(STAGES).filter(([k]) => k !== 'group').map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          </div>
          <div class="field"><label>الفريق الأول</label>
            <select class="input" id="nmHome">${S.teams.map((t) => `<option value="${t.code}">${esc(t.name_ar)}</option>`).join('')}</select>
          </div>
          <div class="field"><label>الفريق الثاني</label>
            <select class="input" id="nmAway">${S.teams.map((t) => `<option value="${t.code}">${esc(t.name_ar)}</option>`).join('')}</select>
          </div>
          <div class="field"><label>الموعد (بتوقيت جهازك)</label><input class="input" id="nmKick" type="datetime-local"></div>
        </div>
        <button class="btn btn-sm" id="addMatch">إضافة المباراة</button>
      </div>
    </div>
  </div>`;

  $('#showAllMatches').addEventListener('change', (e) => { S.adminShowAll = e.target.checked; renderAdmin(); });

  $('#fetchNow').addEventListener('click', async () => {
    const btn = $('#fetchNow');
    btn.disabled = true; btn.textContent = 'عم نجلب...';
    try {
      const { error: e1 } = await S.sb.rpc('auto_fetch_results');
      if (e1) throw e1;
      await new Promise((r) => setTimeout(r, 9000));   // مهلة وصول رد ESPN
      const { data, error } = await S.sb.rpc('process_results_fetch');
      if (error) throw error;
      toast(data > 0 ? `وصلت ${data} نتيجة جديدة والنقاط انحسبت` : 'ما وصلت نتائج جديدة بعد — منجرب تلقائياً كل 10 دقايق');
    } catch (err) {
      toast('ما زبط الجلب: ' + err.message, 'err');
    }
    await loadAll().catch(() => {});
    renderAdmin();
  });

  bindAdminMatches();

  let goldenSel = [...st.golden_teams];
  $$('#goldenGrid .team-pick').forEach((b) => b.addEventListener('click', () => {
    const c = b.dataset.gcode;
    if (goldenSel.includes(c)) goldenSel = goldenSel.filter((x) => x !== c);
    else if (goldenSel.length < 4) goldenSel.push(c);
    else return toast('4 منتخبات بس!', 'err');
    b.classList.toggle('selected');
  }));
  $('#saveGolden').addEventListener('click', async () => {
    if (goldenSel.length !== 0 && goldenSel.length !== 4) return toast('اختار 4 منتخبات بالضبط (أو ولا واحد للمسح)', 'err');
    const { error } = await S.sb.from('app_state').update({ golden_teams: goldenSel }).eq('id', true);
    if (error) return toast('خطأ: ' + error.message, 'err');
    toast('انحفظ المربع الذهبي والنقاط توزعت ⭐');
    await loadAll().catch(() => {}); renderAdmin();
  });

  $('#saveChamp').addEventListener('click', async () => {
    const champ = $('#champSelect').value || null;
    const reveal = $('#revealPicks').checked;
    const { error } = await S.sb.from('app_state').update({ champion: champ, reveal_picks: reveal }).eq('id', true);
    if (error) return toast('خطأ: ' + error.message, 'err');
    toast(champ ? 'مبروك للبطل! النقاط توزعت 🏆' : 'انحفظ');
    await loadAll().catch(() => {}); renderAdmin();
  });

  $('#saveSettings').addEventListener('click', async () => {
    const dl = $('#deadline').value;
    const { error } = await S.sb.from('app_state').update({
      points_win: +$('#pWin').value || 0,
      points_exact: +$('#pExact').value || 0,
      points_golden: +$('#pGolden').value || 0,
      points_champion: +$('#pChamp').value || 0,
      points_ko_qualify: +$('#pKoQ').value || 0,
      points_ko_dir: +$('#pKoD').value || 0,
      points_ko_exact: +$('#pKoE').value || 0,
      golden_per_team: $('#gMode').value === 'per',
      picks_deadline: dl ? new Date(dl).toISOString() : S.state.picks_deadline,
    }).eq('id', true);
    if (error) return toast('خطأ: ' + error.message, 'err');
    toast('انحفظت الإعدادات وانحسبت النقاط من جديد ✅');
    await loadAll().catch(() => {}); renderAdmin();
  });

  $('#recompute').addEventListener('click', async () => {
    const { error } = await S.sb.rpc('recompute_points');
    if (error) return toast('خطأ: ' + error.message, 'err');
    toast('انحسبت كل النقاط من جديد 🔄');
    await loadAll().catch(() => {}); renderAdmin();
  });

  $('#saveBanner').addEventListener('click', async () => {
    const link = $('#bnLink').value.trim();
    const { error } = await S.sb.from('app_state').update({
      banner_on: $('#bnOn').checked,
      banner_text: $('#bnText').value.trim() || null,
      banner_link: link || null,
      banner_cta: $('#bnCta').value.trim() || null,
    }).eq('id', true);
    if (error) return toast('خطأ: ' + error.message, 'err');
    toast('انحفظ البانر 📣');
    await loadAll().catch(() => {}); renderAdmin();
  });

  $$('.ap-type').forEach((sel) => sel.addEventListener('change', async () => {
    const uid = sel.dataset.uid, t = +sel.value;
    sel.disabled = true;
    const { error } = await S.sb.rpc('admin_set_player_type', { p_uid: uid, p_type: t });
    sel.disabled = false;
    if (error) return toast('خطأ: ' + error.message, 'err');
    const row = S.leaderboard.find((r) => r.id === uid); if (row) row.player_type = t;
    if (uid === S.session.user.id && S.profile) S.profile.player_type = t;
    toast('انحفظ نوع اللاعب 👥');
  }));

  $('#addMatch').addEventListener('click', async () => {
    const home = $('#nmHome').value, away = $('#nmAway').value, kick = $('#nmKick').value;
    if (home === away) return toast('الفريقين نفس بعض! 😅', 'err');
    if (!kick) return toast('حدد موعد المباراة', 'err');
    const { error } = await S.sb.from('matches').insert({
      stage: $('#nmStage').value, round: null, home, away,
      kickoff: new Date(kick).toISOString(),
    });
    if (error) return toast('خطأ: ' + error.message, 'err');
    toast('انضافت المباراة وصار فيهم يتوقعوها ⚽');
    await loadAll().catch(() => {}); renderAdmin();
  });
}

/* ============================================================
   عداد الوقت
   ============================================================ */
let tickerInterval = null;
function startTicker() {
  clearInterval(tickerInterval);
  let lastMinute = new Date().getMinutes();
  tickerInterval = setInterval(() => {
    updateCountdowns();
    // كل دقيقة: راجع حالات القفل (يمكن مباراة بلشت)
    const m = new Date().getMinutes();
    if (m !== lastMinute) {
      lastMinute = m;
      if (S.view === 'matches' || S.view === 'home') softRender();
    }
  }, 1000);
}

function updateCountdowns() {
  $$('.countdown').forEach((box) => {
    const ko = +box.dataset.ko;
    let diff = Math.max(0, ko - Date.now());
    const d = Math.floor(diff / 864e5); diff -= d * 864e5;
    const h = Math.floor(diff / 36e5); diff -= h * 36e5;
    const mi = Math.floor(diff / 6e4); diff -= mi * 6e4;
    const s = Math.floor(diff / 1000);
    const set = (u, v) => { const el = box.querySelector(`[data-u="${u}"]`); if (el && el.textContent != v) el.textContent = v; };
    set('d', d); set('h', h); set('m', mi); set('s', s);
  });
}
