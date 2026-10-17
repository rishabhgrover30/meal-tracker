/**
 * Meal Tracker -> Google Sheet sync (bound to the "Meal Tracker Log" spreadsheet).
 *
 * The phone POSTs one full-day snapshot (JSON sent as text/plain, so there's no CORS preflight)
 * every time that day changes. For that date we:
 *   - replace every row in "Items" (this handles adds, edits and deletes in one go)
 *   - upsert the single row in "Daily" (or remove it if the day is now empty)
 * Re-sending the same snapshot is harmless (idempotent).
 *
 * Deploy: Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
 */
var ITEMS = 'Items';
var DAILY = 'Daily';
var ITEM_HEADERS = ['date', 'time', 'meal', 'food', 'qty', 'unit', 'kcal', 'protein', 'carbs', 'fat', 'fibre', 'item id'];
var DAILY_HEADERS = ['date', 'kcal', 'protein', 'carbs', 'fat', 'fibre', 'target kcal', 'target protein', 'target carbs', 'target fat', 'target fibre', 'items', 'updated at'];
// Optional: put a random string here AND in the app's Sync URL as ?key=... to reject stray posts.
var SHARED_KEY = '';

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (SHARED_KEY && (!e.parameter || e.parameter.key !== SHARED_KEY)) return json_({ ok: false, error: 'bad key' });
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var days = Array.isArray(body.days) ? body.days : [body];
    var done = [];
    days.forEach(function (d) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ''))) throw new Error('missing or bad date');
      writeDay_(d);
      done.push(d.date);
    });
    return json_({ ok: true, dates: done });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/** GET ?date=YYYY-MM-DD returns that day's rows (handy for checks); no params = health check. */
function doGet(e) {
  var date = e && e.parameter && e.parameter.date;
  if (!date) return json_({ ok: true, app: 'meal-tracker-sync' });
  var items = sheet_(ITEMS, ITEM_HEADERS).getDataRange().getValues().slice(1).filter(function (r) { return String(r[0]) === date; });
  var daily = sheet_(DAILY, DAILY_HEADERS).getDataRange().getValues().slice(1).filter(function (r) { return String(r[0]) === date; });
  return json_({ ok: true, date: date, items: items, daily: daily[0] || null });
}

function writeDay_(d) {
  var date = String(d.date);
  var items = Array.isArray(d.items) ? d.items : [];
  var t = d.targets || {}, tot = d.totals || {};

  // ---- Items: drop this date's rows, append the snapshot, keep everything sorted by date + time
  var sh = sheet_(ITEMS, ITEM_HEADERS);
  var all = sh.getDataRange().getValues();
  var keep = all.slice(1).filter(function (r) { return r.join('') !== '' && String(r[0]) !== date; });
  var add = items.map(function (it) {
    return [date, String(it.time || ''), it.meal || '', it.food || '', num_(it.qty), it.unit || '', r1_(it.kcal), r1_(it.p), r1_(it.c), r1_(it.f), r1_(it.fib), String(it.id || '')];
  });
  var rows = keep.concat(add).sort(function (a, b) { var x = String(a[0]) + String(a[1]), y = String(b[0]) + String(b[1]); return x < y ? -1 : x > y ? 1 : 0; });
  if (all.length > 1) sh.getRange(2, 1, all.length - 1, ITEM_HEADERS.length).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, 2).setNumberFormat('@'); // keep date/time as plain text
    sh.getRange(2, 1, rows.length, ITEM_HEADERS.length).setValues(rows);
  }

  // ---- Daily: upsert one row for this date (remove it if the day is empty)
  var dsh = sheet_(DAILY, DAILY_HEADERS);
  var dv = dsh.getDataRange().getValues();
  var idx = -1;
  for (var i = 1; i < dv.length; i++) if (String(dv[i][0]) === date) { idx = i; break; }
  var row = [date, r1_(tot.kcal), r1_(tot.p), r1_(tot.c), r1_(tot.f), r1_(tot.fib), num_(t.kcal), num_(t.p), num_(t.c), num_(t.f), num_(t.fib), items.length,
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')];
  if (!items.length) { if (idx > 0) dsh.deleteRow(idx + 1); return; }
  if (idx > 0) { dsh.getRange(idx + 1, 1, 1, row.length).setValues([row]); }
  else {
    dsh.appendRow(row);
    var last = dsh.getLastRow();
    dsh.getRange(last, 1).setNumberFormat('@').setValue(date);
    if (last > 2) dsh.getRange(2, 1, last - 1, DAILY_HEADERS.length).sort(1);
  }
}

function sheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.appendRow(headers); sh.setFrozenRows(1); }
  return sh;
}
function num_(x) { var n = Number(x); return isNaN(n) ? '' : n; }
function r1_(x) { var n = Number(x); return isNaN(n) ? '' : Math.round(n * 10) / 10; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/** Run once from the editor (optional) to check the script can see the sheet. */
function selfTest() {
  writeDay_({ date: '2000-01-01', targets: { kcal: 2900, p: 160, c: 380, f: 80, fib: 35 }, totals: { kcal: 100, p: 10, c: 10, f: 1, fib: 1 },
    items: [{ id: 'test', time: '12:00', meal: 'Lunch', food: 'test food', qty: 1, unit: 'serving', kcal: 100, p: 10, c: 10, f: 1, fib: 1 }] });
  writeDay_({ date: '2000-01-01', items: [] }); // and clean it up again
  Logger.log('selfTest OK');
}
