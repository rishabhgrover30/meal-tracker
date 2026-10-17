/**
 * Coach sync: Meal Tracker + Workout -> Google Sheet (bound to the "Meal Tracker Log" spreadsheet).
 * One web-app deployment serves both apps.
 *
 * Security
 *   - Every request needs the shared secret: POST body field "key", GET ?key=...
 *     The secret lives in Script Properties (SECRET), never in code or in the public repos.
 *     Run setup() once from the editor: it creates a random secret (if none) and logs it.
 *   - Requests without a matching key get {"ok":false,"error":"unauthorized"} and nothing else.
 *   - Payloads are size-capped and validated; only the five known tabs are ever written.
 *
 * POST (JSON sent as text/plain, so there's no CORS preflight)
 *   Meal (default; "app" missing or "meal-tracker"): one full-day snapshot {date, targets, totals, items[]}
 *     or {days:[...]}. Replaces that date's rows in "Items", upserts its row in "Daily".
 *   Workout ("app":"workout"): one full session snapshot {date, sessionId, sessionName, started, updated,
 *     note, sets:[{exercise, set, kg, reps, done, time}]} or {sessions:[...]}. Replaces that date+session's
 *     rows in "Workout", upserts its row in "WorkoutSessions".
 *   Re-sending the same snapshot is harmless (idempotent).
 *
 * GET (all need &key=...)
 *   ?key=K                               health check -> {"ok":true}
 *   ?key=K&date=YYYY-MM-DD               meal day (items + daily totals); also &app=meal
 *   ?key=K&app=workout&date=YYYY-MM-DD   that day's workout sessions and sets (optional &session=day1)
 *
 * Deploy: Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
 */
var ITEMS = 'Items', DAILY = 'Daily', WORKOUT = 'Workout', WSESS = 'WorkoutSessions';
var HEADERS = {
  Items: ['date', 'time', 'meal', 'food', 'qty', 'unit', 'kcal', 'protein', 'carbs', 'fat', 'fibre', 'item id'],
  Daily: ['date', 'kcal', 'protein', 'carbs', 'fat', 'fibre', 'target kcal', 'target protein', 'target carbs', 'target fat', 'target fibre', 'items', 'updated at'],
  Workout: ['date', 'session', 'exercise', 'set', 'kg', 'reps', 'done', 'time'],
  WorkoutSessions: ['date', 'session', 'session name', 'sets done', 'sets total', 'started', 'last update', 'note']
};
var LIMITS = { body: 200000, days: 31, items: 300, sessions: 8, sets: 150, str: 200, note: 1000 };

// ---------------------------------------------------------------- entry points
function doPost(e) {
  var raw = (e && e.postData && e.postData.contents) || '';
  if (raw.length > LIMITS.body) return json_({ ok: false, error: 'too large' });
  var body;
  try { body = JSON.parse(raw || '{}'); } catch (err) { return json_({ ok: false, error: 'unauthorized' }); }
  if (!body || typeof body !== 'object' || !authorised_(body.key)) return json_({ ok: false, error: 'unauthorized' });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (body.app === 'workout') {
      var sess = Array.isArray(body.sessions) ? body.sessions : [body];
      if (sess.length > LIMITS.sessions) throw new Error('too many sessions');
      var did = sess.map(function (s) { var c = cleanSession_(s); writeSession_(c); return c.date + ' ' + c.sessionId; });
      return json_({ ok: true, app: 'workout', sessions: did });
    }
    if (body.app && body.app !== 'meal-tracker' && body.app !== 'meal') throw new Error('unknown app');
    var days = Array.isArray(body.days) ? body.days : [body];
    if (days.length > LIMITS.days) throw new Error('too many days');
    var done = days.map(function (d) { var c = cleanDay_(d); writeDay_(c); return c.date; });
    return json_({ ok: true, dates: done });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err).slice(0, 120) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!authorised_(p.key)) return json_({ ok: false, error: 'unauthorized' });
  var date = p.date;
  if (!date) return json_({ ok: true });
  if (!isDate_(date)) return json_({ ok: false, error: 'bad date' });
  if (p.app === 'workout') return json_(readWorkout_(date, p.session));
  var items = rowsFor_(ITEMS, date).map(function (r) { return obj_(HEADERS.Items, r); });
  var daily = rowsFor_(DAILY, date).map(function (r) { return obj_(HEADERS.Daily, r); });
  return json_({ ok: true, app: 'meal', date: date, items: items, daily: daily[0] || null });
}

// ---------------------------------------------------------------- auth
function authorised_(key) {
  var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!secret || typeof key !== 'string' || key.length !== secret.length) return false;
  var diff = 0; // constant-time compare
  for (var i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}

/** Run once from the editor. Creates the secret if missing, checks sheet access, logs the key to copy. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SECRET');
  if (!secret) { secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); props.setProperty('SECRET', secret); }
  [ITEMS, DAILY, WORKOUT, WSESS].forEach(function (n) { sheet_(n); });
  Logger.log('Setup OK. Your sync key is:  ' + secret);
  Logger.log('Copy that key and send it to your coach together with the Web app URL (ends in /exec).');
}

/** Optional: run to replace the key (the apps then need the new key). */
function rotateKey() { PropertiesService.getScriptProperties().deleteProperty('SECRET'); setup(); }

// ---------------------------------------------------------------- validation
function isDate_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function str_(x, max) {
  var s = String(x == null ? '' : x).replace(/[\u0000-\u001f]/g, ' ').slice(0, max || LIMITS.str);
  return /^[=+\-@]/.test(s) ? "'" + s : s; // never let a value become a formula
}
function num_(x) { if (x === '' || x == null) return ''; var n = Number(x); return isFinite(n) ? n : ''; }
function r1_(x) { var n = num_(x); return n === '' ? '' : Math.round(n * 10) / 10; }
function time_(x) { var s = String(x || ''); return /^\d{1,2}:\d{2}$/.test(s) ? s : ''; }
function stamp_(x) { var s = String(x || ''); return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s) ? s : ''; }

function cleanDay_(d) {
  if (!d || typeof d !== 'object' || !isDate_(d.date)) throw new Error('missing or bad date');
  var items = Array.isArray(d.items) ? d.items : [];
  if (items.length > LIMITS.items) throw new Error('too many items');
  var t = d.targets || {}, tot = d.totals || {};
  return {
    date: String(d.date),
    targets: { kcal: num_(t.kcal), p: num_(t.p), c: num_(t.c), f: num_(t.f), fib: num_(t.fib) },
    totals: { kcal: r1_(tot.kcal), p: r1_(tot.p), c: r1_(tot.c), f: r1_(tot.f), fib: r1_(tot.fib) },
    items: items.map(function (it) {
      it = it || {};
      return { time: time_(it.time), meal: str_(it.meal, 30), food: str_(it.food), qty: num_(it.qty), unit: str_(it.unit, 30),
        kcal: r1_(it.kcal), p: r1_(it.p), c: r1_(it.c), f: r1_(it.f), fib: r1_(it.fib), id: str_(it.id, 60) };
    })
  };
}

function cleanSession_(s) {
  if (!s || typeof s !== 'object' || !isDate_(s.date)) throw new Error('missing or bad date');
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(String(s.sessionId || ''))) throw new Error('bad sessionId');
  var sets = Array.isArray(s.sets) ? s.sets : [];
  if (sets.length > LIMITS.sets) throw new Error('too many sets');
  return {
    date: String(s.date), sessionId: String(s.sessionId), sessionName: str_(s.sessionName, 80),
    started: stamp_(s.started), updated: stamp_(s.updated), note: str_(s.note, LIMITS.note),
    sets: sets.map(function (x) {
      x = x || {};
      var kg = String(x.kg == null ? '' : x.kg).trim().slice(0, 12);
      return { exercise: str_(x.exercise, 80), set: num_(x.set), kg: /^\d+(\.\d+)?$/.test(kg) ? Number(kg) : str_(kg, 12),
        reps: num_(x.reps), done: x.done === true, time: time_(x.time) };
    })
  };
}

// ---------------------------------------------------------------- meal
function writeDay_(d) {
  var date = d.date, items = d.items, t = d.targets, tot = d.totals;
  var add = items.map(function (it) {
    return [date, it.time, it.meal, it.food, it.qty, it.unit, it.kcal, it.p, it.c, it.f, it.fib, it.id];
  });
  replaceRows_(ITEMS, function (r) { return String(r[0]) === date; }, add, function (r) { return String(r[0]) + String(r[1]); }, 2);
  var updated = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  var row = [date, tot.kcal, tot.p, tot.c, tot.f, tot.fib, t.kcal, t.p, t.c, t.f, t.fib, items.length, updated];
  upsertRow_(DAILY, function (r) { return String(r[0]) === date; }, items.length ? row : null, [1, 13]);
}

// ---------------------------------------------------------------- workout
function writeSession_(s) {
  var match = function (r) { return String(r[0]) === s.date && String(r[1]) === s.sessionId; };
  var add = s.sets.map(function (x) { return [s.date, s.sessionId, x.exercise, x.set, x.kg, x.reps, x.done, x.time]; });
  // keep sets in plan order within a session; sessions sorted by date then id
  replaceRows_(WORKOUT, match, add, function (r) { return String(r[0]) + '|' + String(r[1]); }, 2, [8]);
  var done = s.sets.filter(function (x) { return x.done; }).length;
  var now = s.updated || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  var row = [s.date, s.sessionId, s.sessionName, done, s.sets.length, s.started, now, s.note];
  upsertRow_(WSESS, match, s.sets.length ? row : null, [1, 2, 6, 7]);
}

function readWorkout_(date, session) {
  var sets = rowsFor_(WORKOUT, date).filter(function (r) { return !session || String(r[1]) === session; });
  var sess = rowsFor_(WSESS, date).filter(function (r) { return !session || String(r[1]) === session; });
  return {
    ok: true, app: 'workout', date: date,
    sessions: sess.map(function (r) {
      var o = obj_(HEADERS.WorkoutSessions, r);
      o.sets = sets.filter(function (x) { return String(x[1]) === String(r[1]); }).map(function (x) {
        var y = obj_(HEADERS.Workout, x); delete y.date; delete y.session; return y;
      });
      return o;
    })
  };
}

// ---------------------------------------------------------------- sheet helpers
/** Drop rows matching `match`, append `add`, stable-sort by sortKey. textCols (1-based) stay plain text. */
function replaceRows_(name, match, add, sortKey, nTextCols, extraTextCols) {
  var hdr = HEADERS[name], sh = sheet_(name);
  var all = sh.getDataRange().getValues();
  var keep = all.slice(1).filter(function (r) { return r.join('') !== '' && !match(r); });
  var rows = keep.concat(add).map(function (r, i) { return { r: r, i: i }; })
    .sort(function (a, b) { var x = sortKey(a.r), y = sortKey(b.r); return x < y ? -1 : x > y ? 1 : a.i - b.i; })
    .map(function (o) { return o.r; });
  if (all.length > 1) sh.getRange(2, 1, all.length - 1, hdr.length).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, nTextCols).setNumberFormat('@');
    (extraTextCols || []).forEach(function (c) { sh.getRange(2, c, rows.length, 1).setNumberFormat('@'); });
    sh.getRange(2, 1, rows.length, hdr.length).setValues(rows);
  }
}

/** Update the single row matching `match`, append it if missing, or delete it when row is null. */
function upsertRow_(name, match, row, textCols) {
  var hdr = HEADERS[name], sh = sheet_(name), v = sh.getDataRange().getValues(), idx = -1;
  for (var i = 1; i < v.length; i++) if (match(v[i])) { idx = i; break; }
  if (!row) { if (idx > 0) sh.deleteRow(idx + 1); return; }
  var r = idx > 0 ? idx + 1 : sh.getLastRow() + 1;
  textCols.forEach(function (c) { sh.getRange(r, c, 1, 1).setNumberFormat('@'); });
  sh.getRange(r, 1, 1, hdr.length).setValues([row]);
  if (idx < 0 && r > 2) sh.getRange(2, 1, r - 1, hdr.length).sort([1, 2]);
}

function rowsFor_(name, date) {
  return sheet_(name).getDataRange().getValues().slice(1).filter(function (r) { return cell_(r[0]) === date; });
}
function cell_(x) {
  if (Object.prototype.toString.call(x) === '[object Date]') return Utilities.formatDate(x, Session.getScriptTimeZone(), x.getHours() || x.getMinutes() ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
  return typeof x === 'string' && x.charAt(0) === "'" ? x.slice(1) : x;
}
function obj_(hdr, r) { var o = {}; hdr.forEach(function (h, i) { o[h] = cell_(r[i]); }); return o; }

function sheet_(name) {
  if (!HEADERS.hasOwnProperty(name)) throw new Error('unknown tab'); // only the known tabs, ever
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.appendRow(HEADERS[name]); sh.setFrozenRows(1); }
  return sh;
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/** Optional: run from the editor to check writing works (adds and removes a test day and session). */
function selfTest() {
  writeDay_(cleanDay_({ date: '2000-01-01', targets: { kcal: 2900 }, totals: { kcal: 100 }, items: [{ id: 'test', time: '12:00', meal: 'Lunch', food: 'test', qty: 1, unit: 'serving', kcal: 100 }] }));
  writeDay_(cleanDay_({ date: '2000-01-01', items: [] }));
  writeSession_(cleanSession_({ date: '2000-01-01', sessionId: 'test', sets: [{ exercise: 'Test', set: 1, kg: 10, reps: 5, done: true, time: '12:00' }] }));
  writeSession_(cleanSession_({ date: '2000-01-01', sessionId: 'test', sets: [] }));
  Logger.log('selfTest OK');
}
