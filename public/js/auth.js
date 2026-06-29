/**
 * auth.js - HIMTI UMB Global Session Guard v2.1
 * 
 * File ini di-include di semua halaman protected.
 * Fungsi:
 * 1. Intercept semua fetch() → jika dapat 401 SESSION_INVALID → auto logout + redirect login
 * 2. Tampilkan notifikasi yang jelas ke user
 * 3. Fungsi logout yang proper (hapus session di server + localStorage)
 */

(function () {
  // ============================================
  // INTERCEPT FETCH GLOBAL
  // ============================================
  const _originalFetch = window.fetch;

  window.fetch = async function (...args) {
    let response;
    try {
      response = await _originalFetch(...args);
    } catch (err) {
      throw err;
    }

    // Jika 401, cek apakah karena session invalid (login di perangkat lain)
    if (response.status === 401) {
      try {
        const clone = response.clone();
        const data = await clone.json();

        if (data.code === 'SESSION_INVALID') {
          // Tampilkan notif
          showSessionExpiredAlert(data.error || 'Sesi Anda telah berakhir.');
          return response; // return dulu, redirect ditangani oleh alert
        }
      } catch (e) {
        // Jika response bukan JSON, abaikan
      }
    }

    return response;
  };

  // ============================================
  // TAMPILKAN NOTIFIKASI SESI BERAKHIR
  // ============================================
  function showSessionExpiredAlert(message) {
    // Cegah multiple alert
    if (document.getElementById('himti-session-alert')) return;

    const overlay = document.createElement('div');
    overlay.id = 'himti-session-alert';
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.85);
      z-index: 99999; display: flex; align-items: center; justify-content: center;
      font-family: 'Segoe UI', sans-serif;
    `;

    overlay.innerHTML = `
      <div style="background:#0d1f3c; border:2px solid #c9a227; border-radius:16px; padding:32px 28px;
                  max-width:420px; width:90%; text-align:center; box-shadow:0 0 40px rgba(201,162,39,0.3)">
        <div style="font-size:3rem; margin-bottom:12px">⚠️</div>
        <h3 style="color:#c9a227; font-size:1.2rem; margin-bottom:10px">Sesi Berakhir</h3>
        <p style="color:#a0aec0; font-size:.9rem; line-height:1.6; margin-bottom:20px">
          ${message}<br><br>
          <strong style="color:#fff">Akun ini baru saja login di perangkat lain.</strong><br>
          Hanya satu perangkat yang bisa login dalam satu waktu.
        </p>
        <button id="himti-session-btn"
          style="background:#c9a227; color:#0a1628; border:none; border-radius:8px;
                 padding:11px 28px; font-weight:700; font-size:1rem; cursor:pointer; width:100%">
          🔑 Login Ulang
        </button>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('himti-session-btn').onclick = function () {
      doLogout(true); // redirect tanpa API call (token sudah invalid)
    };
  }

  // ============================================
  // FUNGSI LOGOUT GLOBAL (bisa dipanggil dari tombol logout)
  // ============================================
  window.himtiLogout = async function (skipConfirm) {
    if (!skipConfirm && !confirm('Yakin ingin keluar?')) return;

    const token = localStorage.getItem('himti_token');
    if (token) {
      // Hapus session di server (best effort)
      try {
        await _originalFetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token }
        });
      } catch (e) { /* abaikan jika gagal */ }
    }

    doLogout(false);
  };

  function doLogout(isKick) {
    localStorage.removeItem('himti_token');
    localStorage.removeItem('himti_role');
    localStorage.removeItem('himti_nama');

    // Tentukan halaman login berdasarkan URL saat ini
    const path = window.location.pathname;
    let loginUrl = '/anggota/login.html';
    if (path.startsWith('/admin/') || path.includes('/admin/')) loginUrl = '/admin/login.html';
    if (path.startsWith('/superadmin/') || path.includes('/superadmin/')) loginUrl = '/superadmin/login.html';

    if (isKick) {
      // Simpan pesan di sessionStorage untuk ditampilkan di halaman login
      sessionStorage.setItem('himti_kick_msg', 'Anda telah logout karena akun ini login di perangkat lain.');
    }

    window.location.href = loginUrl;
  }

  // ============================================
  // TAMPILKAN PESAN KICK DI HALAMAN LOGIN (jika ada)
  // ============================================
  document.addEventListener('DOMContentLoaded', function () {
    const kickMsg = sessionStorage.getItem('himti_kick_msg');
    if (kickMsg) {
      sessionStorage.removeItem('himti_kick_msg');
      // Cari elemen alert di halaman login (jika ada)
      setTimeout(() => {
        const alertEl = document.getElementById('alert-err') || document.getElementById('kick-msg');
        if (alertEl) {
          alertEl.textContent = '⚠️ ' + kickMsg;
          alertEl.style.display = 'block';
          alertEl.style.background = 'rgba(255,193,7,0.1)';
          alertEl.style.borderColor = '#ffc107';
          alertEl.style.color = '#ffc107';
        }
      }, 100);
    }
  });

})();
