(function () {
  'use strict';
  var CFG = window.TIMECLOCK_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var LS_EMP = 'tc_employees', LS_STATUS = 'tc_status', LS_LASTSYNC = 'tc_lastsync';

  /* ---------------- Storage (IndexedDB queue) ---------------- */
  var dbP = new Promise(function (res, rej) {
    var r = indexedDB.open('giovanna-timeclock', 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('queue', { keyPath: 'id' }); };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
  function tx(mode, fn) {
    return dbP.then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction('queue', mode), s = t.objectStore('queue'), out;
        var req = fn(s);
        if (req) req.onsuccess = function () { out = req.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }
  var queueAdd = function (p) { return tx('readwrite', function (s) { return s.put(p); }); };
  var queueAll = function () { return tx('readonly', function (s) { return s.getAll(); }); };
  var queueDel = function (ids) { return tx('readwrite', function (s) { ids.forEach(function (id) { s.delete(id); }); }); };

  // Ask the browser to keep our data (helps on iPad)
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

  function getEmployees() { try { return JSON.parse(localStorage.getItem(LS_EMP)) || []; } catch (e) { return []; } }
  function getStatus() { try { return JSON.parse(localStorage.getItem(LS_STATUS)) || {}; } catch (e) { return {}; } }
  function setStatus(id, type, ts) { var s = getStatus(); s[id] = { type: type, ts: ts }; localStorage.setItem(LS_STATUS, JSON.stringify(s)); }
  function mergeEmployees(list) {
    localStorage.setItem(LS_EMP, JSON.stringify(list));
    var s = getStatus();
    list.forEach(function (e) {
      if (e.status && (!s[e.id] || e.status.ts > s[e.id].ts)) s[e.id] = e.status;
    });
    localStorage.setItem(LS_STATUS, JSON.stringify(s));
  }

  /* ---------------- Clock ---------------- */
  function tick() {
    var d = new Date();
    $('time').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    $('date').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
  tick(); setInterval(tick, 1000);

  /* ---------------- Screens ---------------- */
  function show(id) { ['home', 'punch', 'done'].forEach(function (s) { $(s).classList.toggle('hidden', s !== id); }); }

  /* ---------------- PIN pad ---------------- */
  var pin = '', busy = false;
  function renderDots() {
    var spans = $('dots').children;
    for (var i = 0; i < 4; i++) spans[i].classList.toggle('f', i < pin.length);
  }
  function promptMsg(t, err) { var p = $('prompt'); p.textContent = t; p.classList.toggle('err', !!err); }
  $('pad').addEventListener('click', function (ev) {
    var b = ev.target.closest('button'); if (!b || busy) return;
    var k = b.getAttribute('data-k');
    if (k === 'clear') pin = '';
    else if (k === 'back') pin = pin.slice(0, -1);
    else if (pin.length < 4) pin += k;
    if (pin.length) promptMsg('Enter your 4-digit PIN');
    renderDots();
    if (pin.length === 4) checkPin();
  });
  document.addEventListener('keydown', function (e) {
    if ($('home').classList.contains('hidden')) return;
    if (/^\d$/.test(e.key)) { var b = document.querySelector('[data-k="' + e.key + '"]'); if (b) b.click(); }
    if (e.key === 'Backspace') document.querySelector('[data-k="back"]').click();
  });

  function sha256(s) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  function checkPin() {
    busy = true;
    var entered = pin, emps = getEmployees();
    if (!emps.length) {
      fail(navigator.onLine ? 'Loading employees… try again in a moment' : 'Connect to Wi‑Fi once to load employees');
      syncNow();
      return;
    }
    Promise.all(emps.map(function (e) { return sha256(e.id + ':' + entered); })).then(function (hashes) {
      var match = null;
      emps.forEach(function (e, i) { if (hashes[i] === e.pinHash) match = e; });
      if (match) { pin = ''; renderDots(); busy = false; openPunch(match); }
      else fail('PIN not recognized');
    });
  }
  function fail(msg) {
    promptMsg(msg, true);
    var d = $('dots'); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake');
    setTimeout(function () { pin = ''; renderDots(); busy = false; }, 450);
  }

  /* ---------------- Camera ---------------- */
  var stream = null;
  function startCamera() {
    var msg = $('camMsg');
    if (stream && stream.active) { $('video').srcObject = stream; return Promise.resolve(true); }
    msg.textContent = 'Starting camera…'; msg.classList.remove('hidden');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg.textContent = 'Camera not available on this device.'; return Promise.resolve(false);
    }
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
      .then(function (s) {
        stream = s; var v = $('video'); v.srcObject = s;
        return v.play().catch(function () {}).then(function () { msg.classList.add('hidden'); return true; });
      })
      .catch(function () {
        msg.textContent = 'Camera is blocked. Ask the manager to allow camera access in Settings.';
        return false;
      });
  }
  function stopCamera() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    $('video').srcObject = null;
  }
  function snap() {
    var v = $('video');
    if (!stream || !v.videoWidth) return null;
    var w = 480, h = Math.round(v.videoHeight * (w / v.videoWidth));
    var c = $('canvas'); c.width = w; c.height = h;
    var g = c.getContext('2d');
    g.translate(w, 0); g.scale(-1, 1); // match the mirrored preview
    g.drawImage(v, 0, 0, w, h);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, h - 26, w, 26);
    g.fillStyle = '#fff'; g.font = '14px -apple-system, Arial, sans-serif';
    g.fillText(new Date().toLocaleString(), 8, h - 8);
    var f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
    return c.toDataURL('image/jpeg', 0.6);
  }

  /* ---------------- Punch flow ---------------- */
  var current = null, idleTimer = null;
  function openPunch(emp) {
    current = emp;
    var st = getStatus()[emp.id];
    var isIn = st && st.type === 'IN';
    $('hello').textContent = 'Hi, ' + emp.name;
    $('status').textContent = isIn
      ? 'You\u2019re clocked in since ' + new Date(st.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + (sameDay(st.ts) ? '' : ' on ' + new Date(st.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })) + '.'
      : 'You\u2019re clocked out.';
    $('btnIn').classList.toggle('dim', !!isIn);
    $('btnOut').classList.toggle('dim', !isIn);
    $('btnIn').disabled = $('btnOut').disabled = false;
    show('punch');
    startCamera();
    resetIdle();
  }
  function sameDay(ts) { return new Date(ts).toDateString() === new Date().toDateString(); }
  function resetIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(goHome, 30000); }
  function goHome() { clearTimeout(idleTimer); stopCamera(); current = null; show('home'); promptMsg('Enter your 4-digit PIN'); }

  function punch(type) {
    if (!current) return;
    $('btnIn').disabled = $('btnOut').disabled = true;
    var photo = snap();
    var ts = Date.now();
    var rec = {
      id: (crypto.randomUUID ? crypto.randomUUID() : ts + '-' + Math.random().toString(36).slice(2)),
      empId: current.id, name: current.name, type: type, ts: ts,
      photo: photo, offline: !navigator.onLine,
      note: photo ? '' : 'Camera unavailable - no photo'
    };
    var emp = current;
    queueAdd(rec).then(function () {
      setStatus(emp.id, type, ts);
      stopCamera();
      $('doneTitle').textContent = type === 'IN' ? 'Clocked in' : 'Clocked out';
      $('doneSub').textContent = emp.name + ' \u00b7 ' + new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) +
        (photo ? '' : ' \u00b7 no photo taken');
      show('done');
      clearTimeout(idleTimer);
      setTimeout(goHome, 2600);
      updateSyncUI();
      syncNow();
    }).catch(function () {
      $('btnIn').disabled = $('btnOut').disabled = false;
      alertMsg('Could not save. Please try again.');
    });
  }
  function alertMsg(t) { $('status').textContent = t; }
  $('btnIn').addEventListener('click', function () { punch('IN'); });
  $('btnOut').addEventListener('click', function () { punch('OUT'); });
  $('cancel').addEventListener('click', goHome);
  $('punch').addEventListener('pointerdown', resetIdle);

  /* ---------------- Sync ---------------- */
  var syncing = false;
  function updateSyncUI(state) {
    return queueAll().then(function (q) {
      var dot = $('syncDot'), txt = $('syncText');
      dot.className = 'dot';
      if (!CFG.API_URL) { dot.classList.add('off'); txt.textContent = 'Not connected to Google Sheet'; return; }
      if (!navigator.onLine || state === 'error') {
        dot.classList.add(q.length ? 'wait' : 'off');
        txt.textContent = q.length ? q.length + ' saved on iPad \u00b7 will sync on Wi‑Fi' : 'Offline \u00b7 punches save on iPad';
      } else if (!getEmployees().length) {
        dot.classList.add('wait'); txt.textContent = 'Connecting\u2026';
      } else if (q.length) {
        dot.classList.add('wait'); txt.textContent = 'Syncing ' + q.length + '…';
      } else {
        dot.classList.add('ok'); txt.textContent = 'All punches synced';
      }
    });
  }

  function api(method, body) {
    var url = CFG.API_URL + (method === 'GET' ? '?token=' + encodeURIComponent(CFG.TOKEN) + '&t=' + Date.now() : '');
    var opt = method === 'GET' ? {} : { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) };
    opt.redirect = 'follow'; opt.cache = 'no-store';
    return fetch(url, opt).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'error'); return j; });
  }

  function syncNow() {
    if (syncing || !CFG.API_URL) return updateSyncUI();
    syncing = true;
    return queueAll().then(function (q) {
      q.sort(function (a, b) { return a.ts - b.ts; });
      var batches = [];
      for (var i = 0; i < q.length; i += 4) batches.push(q.slice(i, i + 4));
      var chain = Promise.resolve(null);
      batches.forEach(function (b) {
        chain = chain.then(function () {
          return api('POST', { token: CFG.TOKEN, punches: b }).then(function (j) {
            if (j.employees) mergeEmployees(j.employees);
            return queueDel(j.accepted || []);
          });
        });
      });
      return chain.then(function () {
        if (!batches.length) return api('GET').then(function (j) { mergeEmployees(j.employees || []); });
      });
    }).then(function () {
      localStorage.setItem(LS_LASTSYNC, String(Date.now()));
      syncing = false; return updateSyncUI();
    }).catch(function () {
      syncing = false; return updateSyncUI('error');
    });
  }

  window.addEventListener('online', syncNow);
  window.addEventListener('offline', function () { updateSyncUI(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) syncNow(); });
  setInterval(syncNow, 60000);
  updateSyncUI(); syncNow();

  /* ---------------- Offline app shell ---------------- */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
