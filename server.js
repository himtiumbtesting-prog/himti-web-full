// server.js - HIMTI UMB Web Management System v2.1
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'himti-umb-secret-2025';

// Database Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// File upload (memory storage → base64)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Hanya file gambar yang diizinkan'), false);
  }
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// =============================================
// DATABASE INITIALIZATION
// =============================================
async function initDB() {
  const client = await pool.connect();
  try {
    // Users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'anggota',
        is_active BOOLEAN DEFAULT true,
        session_token VARCHAR(64),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Tambah kolom users jika belum ada (migrasi dari skema versi lama)
    // Digabung jadi SATU query batch agar tidak terpotong timeout di tengah jalan
    const usersColumns = [
      ['username', 'VARCHAR(50)'],
      ['password_hash', 'VARCHAR(255)'],
      ['role', "VARCHAR(20) DEFAULT 'anggota'"],
      ['is_active', 'BOOLEAN DEFAULT true'],
      ['session_token', 'VARCHAR(64)'],
      ['created_at', 'TIMESTAMP DEFAULT NOW()']
    ];
    const usersAlterSQL = usersColumns
      .map(([col, type]) => `ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col} ${type};`)
      .join('\n');
    await client.query(usersAlterSQL).catch((e) => console.log('users migration:', e.message));
    await client.query(`ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username)`).catch(() => {});

    // Perbaikan dinamis: longgarkan kolom NOT NULL legacy yang tidak kita kenal di tabel users
    try {
      const notNullUsers = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='users' AND is_nullable='NO' AND column_name NOT IN ('id','username','password_hash')
      `);
      if (notNullUsers.rows.length) {
        const dropSQL = notNullUsers.rows
          .map(r => `ALTER TABLE users ALTER COLUMN ${r.column_name} DROP NOT NULL;`)
          .join('\n');
        await client.query(dropSQL).catch((e) => console.log('drop not null users:', e.message));
        console.log('Kolom NOT NULL legacy users dilonggarkan:', notNullUsers.rows.map(r => r.column_name).join(', '));
      }
    } catch (e) { console.log('cek not null users gagal:', e.message); }

    // Anggota dengan kolom masa_aktif
    await client.query(`
      CREATE TABLE IF NOT EXISTS anggota (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        nama VARCHAR(100) NOT NULL,
        npm VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(100),
        no_hp VARCHAR(20),
        angkatan VARCHAR(10),
        prodi VARCHAR(100) DEFAULT 'Teknik Informatika',
        foto_url TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        tahun_bergabung INTEGER,
        masa_aktif_mulai DATE,
        masa_aktif_sampai DATE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Tambahkan SEMUA kolom yang mungkin belum ada (migrasi dari skema versi lama).
    // Menangani kasus tabel 'anggota' sudah ada sebelumnya dengan struktur berbeda.
    // Digabung jadi SATU query batch (1 round-trip) agar tidak terpotong timeout
    // di tengah jalan seperti yang terjadi dengan loop per-kolom sebelumnya.
    // Aman dijalankan berkali-kali & tidak menghapus data yang sudah ada.
    const anggotaColumns = [
      ['user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE'],
      ['nama', 'VARCHAR(100)'],
      ['npm', 'VARCHAR(20)'],
      ['email', 'VARCHAR(100)'],
      ['no_hp', 'VARCHAR(20)'],
      ['angkatan', 'VARCHAR(10)'],
      ['prodi', "VARCHAR(100) DEFAULT 'Teknik Informatika'"],
      ['foto_url', 'TEXT'],
      ['status', "VARCHAR(20) DEFAULT 'pending'"],
      ['tahun_bergabung', 'INTEGER'],
      ['masa_aktif_mulai', 'DATE'],
      ['masa_aktif_sampai', 'DATE'],
      ['created_at', 'TIMESTAMP DEFAULT NOW()'],
      ['updated_at', 'TIMESTAMP DEFAULT NOW()']
    ];
    const anggotaAlterSQL = anggotaColumns
      .map(([col, type]) => `ALTER TABLE anggota ADD COLUMN IF NOT EXISTS ${col} ${type};`)
      .join('\n');
    await client.query(anggotaAlterSQL).catch((e) => console.log('anggota migration:', e.message));
    // Pastikan NPM unik (skip kalau constraint sudah ada atau ada data duplikat)
    await client.query(`ALTER TABLE anggota ADD CONSTRAINT anggota_npm_key UNIQUE (npm)`).catch(() => {});

    // Perbaikan dinamis: tabel 'anggota' versi lama mungkin punya kolom WAJIB (NOT NULL)
    // yang tidak kita kenal (misal kolom 'password' dari skema lama yang berbeda).
    // Kode kita hanya wajibkan 'nama' dan 'npm' — kolom lain yang masih NOT NULL
    // otomatis dilonggarkan supaya INSERT dari sistem baru tidak gagal.
    try {
      const notNullCols = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name='anggota' AND is_nullable='NO' AND column_name NOT IN ('id','nama','npm')
      `);
      if (notNullCols.rows.length) {
        const dropSQL = notNullCols.rows
          .map(r => `ALTER TABLE anggota ALTER COLUMN ${r.column_name} DROP NOT NULL;`)
          .join('\n');
        await client.query(dropSQL).catch((e) => console.log('drop not null anggota:', e.message));
        console.log('Kolom NOT NULL legacy dilonggarkan:', notNullCols.rows.map(r => r.column_name).join(', '));
      }
    } catch (e) { console.log('cek not null anggota gagal:', e.message); }

    // Pembayaran/Iuran
    await client.query(`
      CREATE TABLE IF NOT EXISTS pembayaran (
        id SERIAL PRIMARY KEY,
        anggota_id INTEGER REFERENCES anggota(id) ON DELETE CASCADE,
        jenis VARCHAR(30) DEFAULT 'iuran_awal',
        jumlah INTEGER DEFAULT 50000,
        bukti_url TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        catatan_anggota TEXT,
        catatan_admin TEXT,
        submitted_at TIMESTAMP DEFAULT NOW(),
        processed_at TIMESTAMP,
        processed_by INTEGER REFERENCES users(id)
      )
    `);

    // Perpanjangan masa aktif
    await client.query(`
      CREATE TABLE IF NOT EXISTS perpanjangan_requests (
        id SERIAL PRIMARY KEY,
        anggota_id INTEGER REFERENCES anggota(id) ON DELETE CASCADE,
        bukti_url TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        catatan TEXT,
        catatan_admin TEXT,
        masa_aktif_lama DATE,
        masa_aktif_baru DATE,
        requested_at TIMESTAMP DEFAULT NOW(),
        processed_at TIMESTAMP,
        processed_by INTEGER REFERENCES users(id)
      )
    `);

    // Kegiatan/Event untuk presensi
    await client.query(`
      CREATE TABLE IF NOT EXISTS kegiatan (
        id SERIAL PRIMARY KEY,
        nama VARCHAR(100) NOT NULL,
        deskripsi TEXT,
        kode_presensi VARCHAR(10) UNIQUE NOT NULL,
        tanggal DATE NOT NULL,
        is_active BOOLEAN DEFAULT true,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Presensi
    await client.query(`
      CREATE TABLE IF NOT EXISTS presensi (
        id SERIAL PRIMARY KEY,
        anggota_id INTEGER REFERENCES anggota(id),
        kegiatan_id INTEGER REFERENCES kegiatan(id),
        waktu_presensi TIMESTAMP DEFAULT NOW(),
        UNIQUE(anggota_id, kegiatan_id)
      )
    `);

    // Kontak HIMTI (single row)
    await client.query(`
      CREATE TABLE IF NOT EXISTS kontak_himti (
        id INTEGER PRIMARY KEY DEFAULT 1,
        nomor_wa VARCHAR(30),
        nomor_hp VARCHAR(30),
        email_himti VARCHAR(100),
        alamat TEXT,
        instagram VARCHAR(100),
        updated_at TIMESTAMP DEFAULT NOW(),
        updated_by INTEGER REFERENCES users(id)
      )
    `);

    // Info Pembayaran (single row)
    await client.query(`
      CREATE TABLE IF NOT EXISTS info_pembayaran (
        id INTEGER PRIMARY KEY DEFAULT 1,
        nama_bank VARCHAR(50),
        nomor_rekening VARCHAR(50),
        atas_nama VARCHAR(100),
        nominal_iuran INTEGER DEFAULT 50000,
        nominal_perpanjangan INTEGER DEFAULT 50000,
        instruksi TEXT,
        qris_image TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Admin profiles
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_profiles (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        nama VARCHAR(100) NOT NULL,
        email VARCHAR(100),
        jabatan VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // === Seed default accounts ===
    const sa = await client.query("SELECT id FROM users WHERE username = 'superadmin'");
    if (sa.rows.length === 0) {
      const h = await bcrypt.hash('himti2025', 10);
      await client.query("INSERT INTO users (username, password_hash, role) VALUES ('superadmin', $1, 'superadmin')", [h]);
    }

    const adm = await client.query("SELECT id FROM users WHERE username = 'admin'");
    if (adm.rows.length === 0) {
      const h = await bcrypt.hash('admin2025', 10);
      const u = await client.query("INSERT INTO users (username, password_hash, role) VALUES ('admin', $1, 'admin') RETURNING id", [h]);
      await client.query("INSERT INTO admin_profiles (user_id, nama, jabatan) VALUES ($1, 'Admin HIMTI', 'Administrator')", [u.rows[0].id]);
    }

    // Default kontak
    const knt = await client.query("SELECT id FROM kontak_himti WHERE id = 1");
    if (knt.rows.length === 0) {
      await client.query(`INSERT INTO kontak_himti (id, nomor_wa, email_himti, alamat, instagram)
        VALUES (1, '6281234567890', 'himti@umb.ac.id', 'Gedung Informatika, Universitas Muhammadiyah Bengkulu', '@himti_umb')`);
    }

    // Default info pembayaran
    const infoByr = await client.query("SELECT id FROM info_pembayaran WHERE id = 1");
    if (infoByr.rows.length === 0) {
      await client.query(`INSERT INTO info_pembayaran (id, nama_bank, nomor_rekening, atas_nama, nominal_iuran, nominal_perpanjangan, instruksi)
        VALUES (1, 'BRI', '1234-01-012345-56-7', 'HIMTI UMB', 50000, 50000, 'Transfer ke rekening BRI atas nama HIMTI UMB. Setelah transfer, upload bukti pembayaran di halaman Bayar Iuran.')`);
    }

    console.log('✅ Database initialized');
  } catch (err) {
    console.error('❌ DB init error:', err.message);
  } finally {
    client.release();
  }
}

// =============================================
// AUTH UTILITIES
// =============================================
const generateToken = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
const generateSessionToken = () => crypto.randomBytes(32).toString('hex');

// verifyToken: cek JWT + pastikan sesi masih valid di DB (single session enforcement)
async function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token tidak ada', code: 'NO_TOKEN' });
  }
  try {
    const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    req.user = decoded;

    // Wajib punya session_token (token lama sebelum v2.1 tidak valid)
    if (!decoded.session_token) {
      return res.status(401).json({
        error: 'Sesi kadaluarsa, silakan login ulang.',
        code: 'SESSION_INVALID'
      });
    }

    // Cek ke database: pastikan session_token cocok
    const r = await pool.query(
      'SELECT session_token, is_active FROM users WHERE id=$1', [decoded.id]
    );
    if (!r.rows.length) {
      return res.status(401).json({ error: 'Akun tidak ditemukan', code: 'SESSION_INVALID' });
    }
    const dbUser = r.rows[0];

    // Cek akun aktif
    if (!dbUser.is_active && decoded.role !== 'superadmin') {
      return res.status(403).json({ error: 'Akun dinonaktifkan', code: 'ACCOUNT_DISABLED' });
    }

    // Cek session: token tidak cocok = ada orang lain yang login pakai akun ini
    if (dbUser.session_token !== decoded.session_token) {
      return res.status(401).json({
        error: 'Sesi berakhir. Akun ini baru saja login di perangkat lain.',
        code: 'SESSION_INVALID'
      });
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token tidak valid atau sudah kadaluarsa', code: 'TOKEN_INVALID' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Akses ditolak' });
    next();
  };
}

// Auto update status kadaluarsa
async function syncExpiredStatus() {
  await pool.query(`UPDATE anggota SET status='kadaluarsa' WHERE masa_aktif_sampai < CURRENT_DATE AND status='aktif'`).catch(()=>{});
}

const fileToBase64 = (file) => file ? `data:${file.mimetype};base64,${file.buffer.toString('base64')}` : null;

// =============================================
// AUTH ROUTES
// =============================================
app.post('/api/auth/register', upload.single('foto'), async (req, res) => {
  const { username, password, nama, npm, email, no_hp, angkatan, prodi } = req.body;
  if (!username || !password || !nama || !npm) return res.status(400).json({ error: 'Data wajib belum lengkap' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 10);
    const uRes = await client.query("INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'anggota') RETURNING id", [username, hash]);
    const tahun = new Date().getFullYear();
    const foto = req.file ? fileToBase64(req.file) : null;
    await client.query(
      `INSERT INTO anggota (user_id, nama, npm, email, no_hp, angkatan, prodi, foto_url, status, tahun_bergabung)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)`,
      [uRes.rows[0].id, nama, npm, email || null, no_hp || null, angkatan || tahun.toString(), prodi || 'Teknik Informatika', foto, tahun]
    );
    await client.query('COMMIT');
    res.json({ success: true, message: 'Registrasi berhasil! Silakan login dan tunggu persetujuan admin.' });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(400).json({ error: 'Username atau NPM sudah terdaftar' });
    res.status(500).json({ error: 'Server error: ' + err.message });
  } finally { client.release(); }
});

app.post('/api/auth/login-anggota', async (req, res) => {
  const { username, password } = req.body;
  try {
    const r = await pool.query(
      `SELECT u.*, a.id as aid, a.nama, a.status as ast, a.npm
       FROM users u JOIN anggota a ON a.user_id = u.id
       WHERE u.username=$1 AND u.role='anggota'`, [username]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Username atau password salah' });
    const u = r.rows[0];
    if (!await bcrypt.compare(password, u.password_hash)) return res.status(401).json({ error: 'Username atau password salah' });
    if (!u.is_active) return res.status(403).json({ error: 'Akun dinonaktifkan' });
    // Generate session baru → invalidate sesi lama di perangkat lain
    const sessionToken = generateSessionToken();
    await pool.query('UPDATE users SET session_token=$1 WHERE id=$2', [sessionToken, u.id]);
    const token = generateToken({ id: u.id, username: u.username, role: 'anggota', anggota_id: u.aid, nama: u.nama, session_token: sessionToken });
    res.json({ token, nama: u.nama, status: u.ast });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login-admin', async (req, res) => {
  const { username, password } = req.body;
  try {
    const r = await pool.query(
      `SELECT u.*, ap.nama FROM users u
       LEFT JOIN admin_profiles ap ON ap.user_id = u.id
       WHERE u.username=$1 AND u.role='admin'`, [username]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Username atau password salah' });
    const u = r.rows[0];
    if (!await bcrypt.compare(password, u.password_hash)) return res.status(401).json({ error: 'Username atau password salah' });
    if (!u.is_active) return res.status(403).json({ error: 'Akun dinonaktifkan' });
    // Generate session baru → invalidate sesi lama di perangkat lain
    const sessionToken = generateSessionToken();
    await pool.query('UPDATE users SET session_token=$1 WHERE id=$2', [sessionToken, u.id]);
    const token = generateToken({ id: u.id, username: u.username, role: 'admin', nama: u.nama || username, session_token: sessionToken });
    res.json({ token, nama: u.nama || username });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login-superadmin', async (req, res) => {
  const { username, password } = req.body;
  try {
    const r = await pool.query("SELECT * FROM users WHERE username=$1 AND role='superadmin'", [username]);
    if (!r.rows.length) return res.status(401).json({ error: 'Username atau password salah' });
    const u = r.rows[0];
    if (!await bcrypt.compare(password, u.password_hash)) return res.status(401).json({ error: 'Username atau password salah' });
    // Generate session baru → invalidate sesi lama di perangkat lain
    const sessionToken = generateSessionToken();
    await pool.query('UPDATE users SET session_token=$1 WHERE id=$2', [sessionToken, u.id]);
    const token = generateToken({ id: u.id, username: u.username, role: 'superadmin', nama: 'Super Admin', session_token: sessionToken });
    res.json({ token, nama: 'Super Admin' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Logout - hapus session_token di DB
app.post('/api/auth/logout', verifyToken, async (req, res) => {
  try {
    await pool.query('UPDATE users SET session_token=NULL WHERE id=$1', [req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', verifyToken, (req, res) => res.json({ user: req.user }));

// =============================================
// ANGGOTA ROUTES
// =============================================
app.get('/api/anggota/profil', verifyToken, requireRole('anggota'), async (req, res) => {
  try {
    await syncExpiredStatus();
    const r = await pool.query(
      `SELECT a.*, u.username FROM anggota a JOIN users u ON u.id=a.user_id WHERE a.user_id=$1`, [req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Profil tidak ditemukan' });
    const kontak = await pool.query("SELECT nomor_wa FROM kontak_himti WHERE id=1");
    r.rows[0].kontak_wa = kontak.rows[0]?.nomor_wa || null;
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/anggota/profil', verifyToken, requireRole('anggota'), upload.single('foto'), async (req, res) => {
  const { email, no_hp } = req.body;
  try {
    if (req.file) {
      await pool.query(`UPDATE anggota SET email=$1, no_hp=$2, foto_url=$3, updated_at=NOW() WHERE user_id=$4`,
        [email, no_hp, fileToBase64(req.file), req.user.id]);
    } else {
      await pool.query(`UPDATE anggota SET email=$1, no_hp=$2, updated_at=NOW() WHERE user_id=$3`, [email, no_hp, req.user.id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SEARCH ANGGOTA - cari berdasarkan nama, npm, tahun
app.get('/api/anggota/cari', verifyToken, requireRole('anggota', 'admin', 'superadmin'), async (req, res) => {
  const { q, npm, tahun } = req.query;
  try {
    await syncExpiredStatus();
    let conditions = ["a.status != 'pending'"];
    let params = [];
    let idx = 1;

    if (q && q.trim()) {
      conditions.push(`a.nama ILIKE $${idx++}`);
      params.push(`%${q.trim()}%`);
    }
    if (npm && npm.trim()) {
      conditions.push(`a.npm ILIKE $${idx++}`);
      params.push(`%${npm.trim()}%`);
    }
    if (tahun && tahun.trim() && !isNaN(parseInt(tahun))) {
      conditions.push(`a.tahun_bergabung = $${idx++}`);
      params.push(parseInt(tahun));
    }

    const r = await pool.query(
      `SELECT a.id, a.nama, a.npm, a.angkatan, a.prodi, a.status, a.tahun_bergabung, a.masa_aktif_sampai
       FROM anggota a
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.nama ASC LIMIT 50`,
      params
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Kartu Anggota
app.get('/api/anggota/kartu', verifyToken, requireRole('anggota'), async (req, res) => {
  try {
    await syncExpiredStatus();
    const r = await pool.query(
      `SELECT a.*, u.username FROM anggota a JOIN users u ON u.id=a.user_id WHERE a.user_id=$1`, [req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Data tidak ditemukan' });
    const a = r.rows[0];
    if (a.status === 'pending') return res.status(403).json({ error: 'Akun belum diaktifkan admin' });
    res.json(a);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Presensi anggota
app.post('/api/anggota/presensi', verifyToken, requireRole('anggota'), async (req, res) => {
  const { kode } = req.body;
  try {
    const aid = req.user.anggota_id;
    const angg = await pool.query("SELECT status FROM anggota WHERE id=$1", [aid]);
    if (angg.rows[0]?.status !== 'aktif') return res.status(403).json({ error: 'Hanya anggota aktif yang bisa presensi' });
    const k = await pool.query("SELECT * FROM kegiatan WHERE kode_presensi=$1 AND is_active=true", [kode]);
    if (!k.rows.length) return res.status(404).json({ error: 'Kode presensi tidak valid atau sudah tidak aktif' });
    await pool.query("INSERT INTO presensi (anggota_id, kegiatan_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [aid, k.rows[0].id]);
    res.json({ success: true, kegiatan: k.rows[0].nama });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/anggota/presensi-riwayat', verifyToken, requireRole('anggota'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.waktu_presensi, k.nama, k.tanggal FROM presensi p
       JOIN kegiatan k ON k.id=p.kegiatan_id WHERE p.anggota_id=$1 ORDER BY p.waktu_presensi DESC`,
      [req.user.anggota_id]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// PEMBAYARAN/IURAN ROUTES
// =============================================
app.post('/api/pembayaran/submit', verifyToken, requireRole('anggota'), upload.single('bukti'), async (req, res) => {
  const { catatan } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Bukti pembayaran wajib diupload' });
  try {
    const existPending = await pool.query(
      "SELECT id FROM pembayaran WHERE anggota_id=$1 AND status='pending' AND jenis='iuran_awal'", [req.user.anggota_id]
    );
    if (existPending.rows.length) return res.status(400).json({ error: 'Masih ada pengajuan yang sedang diproses' });
    await pool.query(
      `INSERT INTO pembayaran (anggota_id, jenis, bukti_url, catatan_anggota) VALUES ($1,'iuran_awal',$2,$3)`,
      [req.user.anggota_id, fileToBase64(req.file), catatan || null]
    );
    res.json({ success: true, message: 'Bukti pembayaran berhasil dikirim' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pembayaran/status', verifyToken, requireRole('anggota'), async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM pembayaran WHERE anggota_id=$1 ORDER BY submitted_at DESC LIMIT 5", [req.user.anggota_id]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// PERPANJANGAN MASA AKTIF ROUTES
// =============================================
app.post('/api/perpanjangan/request', verifyToken, requireRole('anggota'), upload.single('bukti'), async (req, res) => {
  const { catatan } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Bukti pembayaran perpanjangan wajib diupload' });
  try {
    const angg = await pool.query("SELECT * FROM anggota WHERE id=$1", [req.user.anggota_id]);
    if (!angg.rows.length) return res.status(404).json({ error: 'Data anggota tidak ditemukan' });
    const a = angg.rows[0];
    if (a.status === 'pending') return res.status(403).json({ error: 'Akun belum diaktifkan' });

    const existPending = await pool.query(
      "SELECT id FROM perpanjangan_requests WHERE anggota_id=$1 AND status='pending'", [req.user.anggota_id]
    );
    if (existPending.rows.length) return res.status(400).json({ error: 'Masih ada permohonan perpanjangan yang sedang diproses' });

    await pool.query(
      `INSERT INTO perpanjangan_requests (anggota_id, bukti_url, catatan, masa_aktif_lama) VALUES ($1,$2,$3,$4)`,
      [req.user.anggota_id, fileToBase64(req.file), catatan || null, a.masa_aktif_sampai]
    );
    res.json({ success: true, message: 'Permohonan perpanjangan berhasil dikirim. Tunggu konfirmasi admin.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/perpanjangan/status', verifyToken, requireRole('anggota'), async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM perpanjangan_requests WHERE anggota_id=$1 ORDER BY requested_at DESC LIMIT 5",
      [req.user.anggota_id]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// INFO PUBLIK
// =============================================
app.get('/api/kontak', async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM kontak_himti WHERE id=1");
    res.json(r.rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/info-pembayaran', async (req, res) => {
  try {
    const r = await pool.query("SELECT id,nama_bank,nomor_rekening,atas_nama,nominal_iuran,nominal_perpanjangan,instruksi FROM info_pembayaran WHERE id=1");
    res.json(r.rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// ADMIN ROUTES
// =============================================
app.get('/api/admin/stats', verifyToken, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await syncExpiredStatus();
    const [total, aktif, pending, kadaluarsa, iuranPending, perpPending] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM anggota"),
      pool.query("SELECT COUNT(*) FROM anggota WHERE status='aktif'"),
      pool.query("SELECT COUNT(*) FROM anggota WHERE status='pending'"),
      pool.query("SELECT COUNT(*) FROM anggota WHERE status='kadaluarsa'"),
      pool.query("SELECT COUNT(*) FROM pembayaran WHERE status='pending'"),
      pool.query("SELECT COUNT(*) FROM perpanjangan_requests WHERE status='pending'")
    ]);
    res.json({
      total: total.rows[0].count,
      aktif: aktif.rows[0].count,
      pending: pending.rows[0].count,
      kadaluarsa: kadaluarsa.rows[0].count,
      iuran_pending: iuranPending.rows[0].count,
      perpanjangan_pending: perpPending.rows[0].count
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Daftar anggota dengan filter
app.get('/api/admin/anggota', verifyToken, requireRole('admin', 'superadmin'), async (req, res) => {
  const { status, tahun, q } = req.query;
  try {
    await syncExpiredStatus();
    let conds = ['1=1'];
    let params = [];
    let idx = 1;
    if (status) { conds.push(`a.status=$${idx++}`); params.push(status); }
    if (tahun && !isNaN(parseInt(tahun))) { conds.push(`a.tahun_bergabung=$${idx++}`); params.push(parseInt(tahun)); }
    if (q) { conds.push(`(a.nama ILIKE $${idx} OR a.npm ILIKE $${idx})`); params.push(`%${q}%`); idx++; }
    const r = await pool.query(
      `SELECT a.*, u.username, u.is_active FROM anggota a JOIN users u ON u.id=a.user_id
       WHERE ${conds.join(' AND ')} ORDER BY a.created_at DESC`,
      params
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Aktivasi/ubah status anggota
app.put('/api/admin/anggota/:id/aktivasi', verifyToken, requireRole('admin', 'superadmin'), async (req, res) => {
  const { id } = req.params;
  const { action, catatan } = req.body; // action: 'aktifkan' | 'nonaktifkan' | 'tolak'
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const angg = await client.query("SELECT * FROM anggota WHERE id=$1", [id]);
    if (!angg.rows.length) return res.status(404).json({ error: 'Anggota tidak ditemukan' });

    if (action === 'aktifkan') {
      const now = new Date();
      const masaAktifMulai = now.toISOString().split('T')[0];
      const masaAktifSampai = new Date(now.setFullYear(now.getFullYear() + 2)).toISOString().split('T')[0];
      await client.query(
        `UPDATE anggota SET status='aktif', masa_aktif_mulai=$1, masa_aktif_sampai=$2, updated_at=NOW() WHERE id=$3`,
        [masaAktifMulai, masaAktifSampai, id]
      );
      // Auto approve pembayaran pending jika ada
      await client.query(
        `UPDATE pembayaran SET status='approved', catatan_admin='Disetujui saat aktivasi', processed_at=NOW(), processed_by=$1
         WHERE anggota_id=$2 AND status='pending' AND jenis='iuran_awal'`,
        [req.user.id, id]
      );
    } else if (action === 'nonaktifkan') {
      await client.query("UPDATE anggota SET status='nonaktif', updated_at=NOW() WHERE id=$1", [id]);
      await client.query("UPDATE users SET is_active=false WHERE id=(SELECT user_id FROM anggota WHERE id=$1)", [id]);
    } else if (action === 'tolak') {
      await client.query("UPDATE anggota SET status='nonaktif', updated_at=NOW() WHERE id=$1", [id]);
    } else if (action === 'aktifkan_user') {
      await client.query("UPDATE users SET is_active=true WHERE id=(SELECT user_id FROM anggota WHERE id=$1)", [id]);
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Export Excel
app.get('/api/admin/anggota/export-excel', verifyToken, requireRole('admin', 'superadmin'), async (req, res) => {
  const { tahun } = req.query;
  try {
    await syncExpiredStatus();
    let query = `SELECT a.nama, a.npm, a.email, a.no_hp, a.angkatan, a.prodi,
                        a.status, a.tahun_bergabung, a.masa_aktif_mulai, a.masa_aktif_sampai, a.created_at
                 FROM anggota a WHERE 1=1`;
    const params = [];
    if (tahun && !isNaN(parseInt(tahun))) { query += ` AND a.tahun_bergabung=$1`; params.push(parseInt(tahun)); }
    query += ' ORDER BY a.nama ASC';
    const r = await pool.query(query, params);

    const fmt = (d) => d ? new Date(d).toLocaleDateString('id-ID') : '-';
    const data = r.rows.map((row, i) => ({
      'No': i + 1,
      'Nama': row.nama,
      'NPM': row.npm,
      'Email': row.email || '-',
      'No HP': row.no_hp || '-',
      'Angkatan': row.angkatan || '-',
      'Program Studi': row.prodi || '-',
      'Status': row.status,
      'Tahun Bergabung': row.tahun_bergabung || '-',
      'Masa Aktif Mulai': fmt(row.masa_aktif_mulai),
      'Masa Aktif Sampai': fmt(row.masa_aktif_sampai),
      'Tanggal Daftar': fmt(row.created_at)
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [
      {wch:5},{wch:25},{wch:15},{wch:25},{wch:15},{wch:10},{wch:25},{wch:12},{wch:18},{wch:18},{wch:18},{wch:18}
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Data Anggota');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fn = tahun ? `anggota_${tahun}.xlsx` : 'semua_anggota.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Kelola Pembayaran
app.get('/api/admin/pembayaran', verifyToken, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.*, a.nama, a.npm FROM pembayaran p
       JOIN anggota a ON a.id=p.anggota_id ORDER BY p.submitted_at DESC`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/pembayaran/:id/proses', verifyToken, requireRole('admin', 'superadmin'), async (req, res) => {
  const { action, catatan } = req.body; // action: 'approve' | 'reject'
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query("SELECT * FROM pembayaran WHERE id=$1", [req.params.id]);
    if (!p.rows.length) return res.status(404).json({ error: 'Data tidak ditemukan' });
    const status = action === 'approve' ? 'approved' : 'rejected';
    await client.query(
      `UPDATE pembayaran SET status=$1, catatan_admin=$2, processed_at=NOW(), processed_by=$3 WHERE id=$4`,
      [status, catatan || null, req.user.id, req.params.id]
    );
    // Jika approve iuran_awal dan anggota masih pending → aktifkan
    if (action === 'approve' && p.rows[0].jenis === 'iuran_awal') {
      const angg = await client.query("SELECT * FROM anggota WHERE id=$1", [p.rows[0].anggota_id]);
      if (angg.rows[0]?.status === 'pending') {
        const now = new Date();
        const mam = now.toISOString().split('T')[0];
        const mas = new Date(now.setFullYear(now.getFullYear() + 2)).toISOString().split('T')[0];
        await client.query(
          "UPDATE anggota SET status='aktif', masa_aktif_mulai=$1, masa_aktif_sampai=$2, updated_at=NOW() WHERE id=$3",
          [mam, mas, p.rows[0].anggota_id]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Kelola Perpanjangan
app.get('/api/admin/perpanjangan', verifyToken, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT pr.*, a.nama, a.npm, a.masa_aktif_sampai FROM perpanjangan_requests pr
       JOIN anggota a ON a.id=pr.anggota_id ORDER BY pr.requested_at DESC`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/perpanjangan/:id/proses', verifyToken, requireRole('admin', 'superadmin'), async (req, res) => {
  const { action, catatan } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pr = await client.query("SELECT * FROM perpanjangan_requests WHERE id=$1", [req.params.id]);
    if (!pr.rows.length) return res.status(404).json({ error: 'Data tidak ditemukan' });
    const p = pr.rows[0];
    const status = action === 'approve' ? 'approved' : 'rejected';
    let masaBaru = null;
    if (action === 'approve') {
      const angg = await client.query("SELECT masa_aktif_sampai FROM anggota WHERE id=$1", [p.anggota_id]);
      const base = angg.rows[0]?.masa_aktif_sampai;
      const baseDate = base && new Date(base) > new Date() ? new Date(base) : new Date();
      baseDate.setFullYear(baseDate.getFullYear() + 2);
      masaBaru = baseDate.toISOString().split('T')[0];
      await client.query(
        "UPDATE anggota SET masa_aktif_sampai=$1, status='aktif', updated_at=NOW() WHERE id=$2",
        [masaBaru, p.anggota_id]
      );
    }
    await client.query(
      `UPDATE perpanjangan_requests SET status=$1, catatan_admin=$2, masa_aktif_baru=$3, processed_at=NOW(), processed_by=$4 WHERE id=$5`,
      [status, catatan || null, masaBaru, req.user.id, req.params.id]
    );
    await client.query('COMMIT');
    res.json({ success: true, masa_aktif_baru: masaBaru });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Kelola Presensi
app.get('/api/admin/kegiatan', verifyToken, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT k.*, COUNT(p.id) as jumlah_hadir FROM kegiatan k
       LEFT JOIN presensi p ON p.kegiatan_id=k.id
       GROUP BY k.id ORDER BY k.created_at DESC`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/kegiatan', verifyToken, requireRole('admin', 'superadmin'), async (req, res) => {
  const { nama, deskripsi, tanggal } = req.body;
  if (!nama || !tanggal) return res.status(400).json({ error: 'Nama dan tanggal wajib diisi' });
  try {
    const kode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const r = await pool.query(
      "INSERT INTO kegiatan (nama, deskripsi, kode_presensi, tanggal, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [nama, deskripsi || null, kode, tanggal, req.user.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/kegiatan/:id/toggle', verifyToken, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    await pool.query("UPDATE kegiatan SET is_active=NOT is_active WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/kegiatan/:id/peserta', verifyToken, requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.nama, a.npm, p.waktu_presensi FROM presensi p
       JOIN anggota a ON a.id=p.anggota_id WHERE p.kegiatan_id=$1 ORDER BY p.waktu_presensi`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Kontak HIMTI (admin update)
app.put('/api/kontak', verifyToken, requireRole('admin', 'superadmin'), async (req, res) => {
  const { nomor_wa, nomor_hp, email_himti, alamat, instagram } = req.body;
  try {
    await pool.query(
      `INSERT INTO kontak_himti (id, nomor_wa, nomor_hp, email_himti, alamat, instagram, updated_at, updated_by)
       VALUES (1,$1,$2,$3,$4,$5,NOW(),$6)
       ON CONFLICT (id) DO UPDATE SET nomor_wa=$1, nomor_hp=$2, email_himti=$3, alamat=$4, instagram=$5, updated_at=NOW(), updated_by=$6`,
      [nomor_wa||null, nomor_hp||null, email_himti||null, alamat||null, instagram||null, req.user.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Info pembayaran (admin update)
app.put('/api/info-pembayaran', verifyToken, requireRole('admin', 'superadmin'), upload.single('qris'), async (req, res) => {
  const { nama_bank, nomor_rekening, atas_nama, nominal_iuran, nominal_perpanjangan, instruksi } = req.body;
  try {
    const qris = req.file ? fileToBase64(req.file) : null;
    const existing = await pool.query("SELECT qris_image FROM info_pembayaran WHERE id=1");
    const qrisFinal = qris || existing.rows[0]?.qris_image || null;
    await pool.query(
      `INSERT INTO info_pembayaran (id, nama_bank, nomor_rekening, atas_nama, nominal_iuran, nominal_perpanjangan, instruksi, qris_image)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET nama_bank=$1, nomor_rekening=$2, atas_nama=$3, nominal_iuran=$4, nominal_perpanjangan=$5, instruksi=$6, qris_image=$7, updated_at=NOW()`,
      [nama_bank||null, nomor_rekening||null, atas_nama||null, parseInt(nominal_iuran)||50000, parseInt(nominal_perpanjangan)||50000, instruksi||null, qrisFinal]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// SUPER ADMIN ROUTES
// =============================================
app.get('/api/superadmin/admins', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.username, u.is_active, u.created_at, ap.nama, ap.email, ap.jabatan
       FROM users u LEFT JOIN admin_profiles ap ON ap.user_id=u.id
       WHERE u.role='admin' ORDER BY u.created_at DESC`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/superadmin/admins', verifyToken, requireRole('superadmin'), async (req, res) => {
  const { username, password, nama, email, jabatan } = req.body;
  if (!username || !password || !nama) return res.status(400).json({ error: 'Data tidak lengkap' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 10);
    const u = await client.query("INSERT INTO users (username, password_hash, role) VALUES ($1,$2,'admin') RETURNING id", [username, hash]);
    await client.query("INSERT INTO admin_profiles (user_id, nama, email, jabatan) VALUES ($1,$2,$3,$4)", [u.rows[0].id, nama, email||null, jabatan||null]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(400).json({ error: 'Username sudah digunakan' });
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.put('/api/superadmin/admins/:id/toggle', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    await pool.query("UPDATE users SET is_active=NOT is_active WHERE id=$1 AND role='admin'", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/superadmin/admins/:id', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    await pool.query("DELETE FROM users WHERE id=$1 AND role='admin'", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/superadmin/ganti-password', verifyToken, requireRole('superadmin'), async (req, res) => {
  const { password_lama, password_baru } = req.body;
  try {
    const r = await pool.query("SELECT password_hash FROM users WHERE id=$1", [req.user.id]);
    if (!await bcrypt.compare(password_lama, r.rows[0].password_hash)) return res.status(400).json({ error: 'Password lama salah' });
    const hash = await bcrypt.hash(password_baru, 10);
    await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [hash, req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/superadmin/stats', verifyToken, requireRole('superadmin'), async (req, res) => {
  try {
    await syncExpiredStatus();
    const [total, aktif, admins] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM anggota"),
      pool.query("SELECT COUNT(*) FROM anggota WHERE status='aktif'"),
      pool.query("SELECT COUNT(*) FROM users WHERE role='admin'")
    ]);
    res.json({ total: total.rows[0].count, aktif: aktif.rows[0].count, admins: admins.rows[0].count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// =============================================
// START
// =============================================
initDB().then(() => {
  if (require.main === module) {
    app.listen(PORT, () => console.log(`🚀 HIMTI Server running on port ${PORT}`));
  }
});

module.exports = app;

// =============================================
// SETUP ROUTE (inisiasi manual)
// =============================================
app.get('/api/setup', async (req, res) => {
  if (req.query.key !== 'HIMTI2025SETUP') return res.status(403).json({ error: 'Key tidak valid' });
  try {
    await initDB();
    const cols = await pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='anggota' ORDER BY column_name`
    );
    res.json({
      success: true,
      message: 'Database berhasil diinisialisasi ulang',
      kolom_anggota_sekarang: cols.rows.map(r => `${r.column_name}${r.is_nullable === 'NO' ? ' [WAJIB]' : ''}`)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cek struktur tabel apa adanya (diagnostik, tanpa mengubah apapun)
app.get('/api/db-check', async (req, res) => {
  if (req.query.key !== 'HIMTI2025SETUP') return res.status(403).json({ error: 'Key tidak valid' });
  try {
    const tables = ['users', 'anggota', 'pembayaran', 'perpanjangan_requests', 'kegiatan', 'presensi', 'kontak_himti', 'info_pembayaran', 'admin_profiles'];
    const result = {};
    for (const t of tables) {
      const r = await pool.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`,
        [t]
      );
      result[t] = r.rows.length ? r.rows.map(x => `${x.column_name} (${x.data_type})`) : 'TABEL TIDAK DITEMUKAN';
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// RESET DATA ANGGOTA (khusus, tidak mengubah struktur/admin/settings)
// =============================================
// Menghapus SEMUA data terkait anggota: akun anggota, pembayaran, perpanjangan,
// presensi. TIDAK menyentuh: akun admin/superadmin, kontak HIMTI, info pembayaran,
// daftar kegiatan, atau struktur tabel manapun. Aksi ini PERMANEN.
// Wajib pakai &confirm=YES supaya tidak terpicu tidak sengaja.
app.get('/api/reset-anggota', async (req, res) => {
  if (req.query.key !== 'HIMTI2025SETUP') return res.status(403).json({ error: 'Key tidak valid' });
  if (req.query.confirm !== 'YES') {
    return res.status(400).json({
      error: 'Konfirmasi diperlukan sebelum menghapus data',
      cara_konfirmasi: 'Tambahkan &confirm=YES di akhir URL untuk melanjutkan',
      peringatan: 'Aksi ini akan menghapus PERMANEN semua akun anggota, riwayat pembayaran, perpanjangan, dan presensi. Akun admin/superadmin, kontak HIMTI, dan info pembayaran TIDAK terpengaruh.'
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const presensiRes = await client.query('DELETE FROM presensi RETURNING id');
    const pembayaranRes = await client.query('DELETE FROM pembayaran RETURNING id');
    const perpanjanganRes = await client.query('DELETE FROM perpanjangan_requests RETURNING id');
    const anggotaRes = await client.query('DELETE FROM anggota RETURNING id');
    const usersRes = await client.query(`DELETE FROM users WHERE role='anggota' RETURNING id`);
    await client.query('COMMIT');
    res.json({
      success: true,
      message: '✅ Semua data anggota berhasil dihapus. Struktur tabel, akun admin/superadmin, dan pengaturan lain tidak berubah.',
      dihapus: {
        akun_anggota: usersRes.rowCount,
        data_anggota: anggotaRes.rowCount,
        riwayat_pembayaran: pembayaranRes.rowCount,
        riwayat_perpanjangan: perpanjanganRes.rowCount,
        riwayat_presensi: presensiRes.rowCount
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Beacon logout (dipanggil saat tab/browser ditutup via navigator.sendBeacon)
app.post('/api/auth/logout-beacon', async (req, res) => {
  try {
    const body = req.body;
    const token = body?.token;
    if (token) {
      const decoded = require('jsonwebtoken').verify(token, JWT_SECRET);
      await pool.query('UPDATE users SET session_token=NULL WHERE id=$1', [decoded.id]);
    }
  } catch (e) { /* abaikan error */ }
  res.status(200).end();
});
