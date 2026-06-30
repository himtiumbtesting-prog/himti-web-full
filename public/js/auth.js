/**
 * auth.js - HIMTI UMB Session Guard v2.3
 * ✅ sessionStorage  → otomatis logout saat tab/browser ditutup
 * ✅ Inactivity 20 menit → countdown warning → auto logout
 * ✅ Polling 30 detik → kick jika akun login di perangkat lain
 * ✅ Fetch interceptor → tangkap SESSION_INVALID dari server
 */
(function () {
  // ─── STORAGE: pakai sessionStorage agar token hilang saat tab ditutup ───
  // Semua kode HTML yang masih pakai localStorage untuk key HIMTI
  // akan otomatis diarahkan ke sessionStorage via override ini
  const HIMTI_KEYS = ['himti_token', 'himti_role', 'himti_nama'];
  const _ls = {
    get: (k) => sessionStorage.getItem(k) || localStorage.getItem(k),
    set: (k, v) => { sessionStorage.setItem(k, v); localStorage.removeItem(k); },
    del: (k) => { sessionStorage.removeItem(k); localStorage.removeItem(k); }
  };
  // Migrasi token lama dari localStorage → sessionStorage (jika ada)
  HIMTI_KEYS.forEach(k => {
    const v = localStorage.getItem(k);
    if (v) { sessionStorage.setItem(k, v); localStorage.removeItem(k); }
  });

  // ─── INTERCEPT FETCH: tangkap SESSION_INVALID dari server ───────────────
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    let res;
    try { res = await _fetch(...args); } catch (e) { throw e; }
    if (res.status === 401) {
      try {
        const data = await res.clone().json();
        if (data.code === 'SESSION_INVALID') {
          showKickedAlert(data.error || 'Sesi Anda berakhir.');
        }
      } catch (e) { /* bukan JSON */ }
    }
    return res;
  };

  // ─── INACTIVITY TIMER: 20 menit tidak aktif → warning → auto logout ─────
  const IDLE_LIMIT   = 20 * 60 * 1000; // 20 menit
  const WARN_BEFORE  =  5 * 60 * 1000; // warning 5 menit sebelum logout
  let idleTimer, warnTimer, countdownInterval;

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    clearTimeout(warnTimer);
    clearInterval(countdownInterval);
    hideIdleWarning();

    const token = sessionStorage.getItem('himti_token') || localStorage.getItem('himti_token');
    if (!token) return;

    // Warning muncul 5 menit sebelum logout (di menit ke-15)
    warnTimer = setTimeout(showIdleWarning, IDLE_LIMIT - WARN_BEFORE);
    // Auto logout di menit ke-20
    idleTimer = setTimeout(() => {
      hideIdleWarning();
      doLogout(false, 'idle');
    }, IDLE_LIMIT);
  }

  // Deteksi aktivitas user
  ['mousemove','mousedown','keydown','touchstart','scroll','click'].forEach(evt => {
    document.addEventListener(evt, resetIdleTimer, { passive: true });
  });

  // ─── POLLING: cek sesi setiap 30 detik ───────────────────────────────────
  function startPolling() {
    const token = sessionStorage.getItem('himti_token') || localStorage.getItem('himti_token');
    if (!token) return;
    setInterval(async () => {
      const t = sessionStorage.getItem('himti_token') || localStorage.getItem('himti_token');
      if (!t) return;
      try {
        const res = await _fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + t } });
        if (res.status === 401) {
          const d = await res.json().catch(() => ({}));
          if (d.code === 'SESSION_INVALID') showKickedAlert(d.error || 'Sesi berakhir.');
        }
      } catch (e) { /* network err */ }
    }, 30000);
  }

  // ─── LOGOUT SAAT TAB / BROWSER DITUTUP ───────────────────────────────────
  // sessionStorage sudah otomatis terhapus saat tab ditutup.
  // sendBeacon untuk memberi tahu server (best-effort)
  window.addEventListener('pagehide', () => {
    const t = sessionStorage.getItem('himti_token');
    if (t) navigator.sendBeacon('/api/auth/logout', new Blob([JSON.stringify({ token: t })], { type: 'application/json' }));
  });

  // ─── MODAL: SESI BERAKHIR (dipakai dari perangkat lain) ──────────────────
  function showKickedAlert(msg) {
    if (document.getElementById('himti-kicked')) return;
    const el = document.createElement('div');
    el.id = 'himti-kicked';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:99999;display:flex;align-items:center;justify-content:center;font-family:Segoe UI,sans-serif';
    el.innerHTML = `<div style="background:#0d1f3c;border:2px solid #c9a227;border-radius:16px;padding:32px 26px;max-width:380px;width:90%;text-align:center">
      <div style="font-size:2.8rem;margin-bottom:12px">🔐</div>
      <h3 style="color:#c9a227;margin-bottom:10px;font-size:1.1rem">Sesi Berakhir</h3>
      <p style="color:#a0aec0;font-size:.86rem;line-height:1.7;margin-bottom:20px">${msg}<br><br>
      <strong style="color:#fff">Hanya 1 perangkat yang bisa aktif dalam satu waktu.</strong></p>
      <button onclick="doLogout(true,'kicked')" style="background:#c9a227;color:#0a1628;border:none;border-radius:8px;padding:11px 24px;font-weight:700;font-size:.95rem;cursor:pointer;width:100%">🔑 Login Ulang</button>
    </div>`;
    document.body.appendChild(el);
  }

  // ─── MODAL: PERINGATAN INAKTIF ────────────────────────────────────────────
  let secondsLeft = 300;
  function showIdleWarning() {
    if (document.getElementById('himti-idle')) return;
    secondsLeft = 300;
    const el = document.createElement('div');
    el.id = 'himti-idle';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99998;display:flex;align-items:center;justify-content:center;font-family:Segoe UI,sans-serif';
    el.innerHTML = `<div style="background:#fff;border-radius:14px;padding:28px 24px;max-width:340px;width:90%;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.2)">
      <div style="font-size:2.5rem;margin-bottom:10px">⏰</div>
      <h3 style="color:#1a202c;margin-bottom:8px;font-size:1.05rem">Sesi Akan Berakhir</h3>
      <p style="color:#64748b;font-size:.84rem;margin-bottom:14px">Anda tidak aktif. Akan logout otomatis dalam:</p>
      <div style="font-size:2.2rem;font-weight:900;color:#ef4444;margin-bottom:18px" id="himti-countdown">5:00</div>
      <button onclick="himtiStayActive()" style="background:#c9a227;color:#0a1628;border:none;border-radius:8px;padding:10px 24px;font-weight:700;font-size:.9rem;cursor:pointer;width:100%">✅ Saya Masih Di Sini</button>
    </div>`;
    document.body.appendChild(el);

    countdownInterval = setInterval(() => {
      secondsLeft--;
      const el2 = document.getElementById('himti-countdown');
      if (el2) {
        const m = Math.floor(secondsLeft / 60);
        const s = secondsLeft % 60;
        el2.textContent = `${m}:${s.toString().padStart(2,'0')}`;
      }
    }, 1000);
  }

  function hideIdleWarning() {
    const el = document.getElementById('himti-idle');
    if (el) el.remove();
    clearInterval(countdownInterval);
  }

  window.himtiStayActive = function () {
    hideIdleWarning();
    resetIdleTimer();
  };

  // ─── LOGOUT GLOBAL ────────────────────────────────────────────────────────
  window.himtiLogout = async function (skipConfirm) {
    if (!skipConfirm && !confirm('Yakin ingin keluar?')) return;
    await doLogout(false, 'manual');
  };

  window.doLogout = async function (skipApi, reason) {
    const token = sessionStorage.getItem('himti_token') || localStorage.getItem('himti_token');
    if (token && !skipApi) {
      try { await _fetch('/api/auth/logout', { method:'POST', headers:{ Authorization:'Bearer '+token } }); } catch (e) {}
    }
    HIMTI_KEYS.forEach(k => { sessionStorage.removeItem(k); localStorage.removeItem(k); });
    const path = window.location.pathname;
    let url = '/anggota/login.html';
    if (path.startsWith('/admin/')) url = '/admin/login.html';
    if (path.startsWith('/superadmin/')) url = '/superadmin/login.html';
    if (reason === 'kicked') sessionStorage.setItem('himti_kick_msg', 'Anda logout karena akun ini dibuka di perangkat lain.');
    if (reason === 'idle') sessionStorage.setItem('himti_kick_msg', 'Anda logout otomatis karena tidak aktif selama 20 menit.');
    window.location.href = url;
  };

  // ─── INIT ─────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    // Tampilkan pesan kick/idle di halaman login
    const msg = sessionStorage.getItem('himti_kick_msg');
    if (msg) {
      sessionStorage.removeItem('himti_kick_msg');
      setTimeout(() => {
        const el = document.getElementById('kick-msg') || document.getElementById('alert-err');
        if (el) {
          el.textContent = '⚠️ ' + msg;
          el.style.cssText += 'display:block;background:rgba(255,193,7,.1);border-color:#ffc107;color:#854d0e';
        }
      }, 150);
    }
    // Mulai timer & polling hanya jika sudah login
    const token = sessionStorage.getItem('himti_token') || localStorage.getItem('himti_token');
    if (token) {
      resetIdleTimer();
      startPolling();
    }
  });
})();


