require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── DB ──────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5
});

// ── JWT SECRETS ─────────────────────────────────
const SA_SECRET  = process.env.JWT_SECRET_SUPERADMIN || 'sa_dev';
const ADM_SECRET = process.env.JWT_SECRET_ADMIN      || 'adm_dev';
const ANG_SECRET = process.env.JWT_SECRET_ANGGOTA    || 'ang_dev';

// ── HELPERS ─────────────────────────────────────
const q    = async (sql, p=[]) => (await pool.query(sql,p)).rows;
const q1   = async (sql, p=[]) => (await pool.query(sql,p)).rows[0]||null;
const ok   = (res,data={},msg='OK') => res.json({ success:true, message:msg, ...data });
const fail = (res,msg='Error',code=400) => res.status(code).json({ success:false, message:msg });

function authSA(req,res,next){
  const t=(req.headers.authorization||'').split(' ')[1];
  if(!t) return fail(res,'Token tidak ada',401);
  try{ req.user=jwt.verify(t,SA_SECRET); req.user.role='superadmin'; next(); }
  catch{ fail(res,'Token tidak valid',401); }
}
function authADM(req,res,next){
  const t=(req.headers.authorization||'').split(' ')[1];
  if(!t) return fail(res,'Token tidak ada',401);
  try{ req.user=jwt.verify(t,ADM_SECRET); req.user.role='admin'; next(); }
  catch{ fail(res,'Token tidak valid',401); }
}
function authANG(req,res,next){
  const t=(req.headers.authorization||'').split(' ')[1];
  if(!t) return fail(res,'Token tidak ada',401);
  try{ req.user=jwt.verify(t,ANG_SECRET); req.user.role='anggota'; next(); }
  catch{ fail(res,'Token tidak valid',401); }
}
function authADMorSA(req,res,next){
  const t=(req.headers.authorization||'').split(' ')[1];
  if(!t) return fail(res,'Token tidak ada',401);
  try{ req.user=jwt.verify(t,ADM_SECRET); req.user.role='admin'; return next(); } catch{}
  try{ req.user=jwt.verify(t,SA_SECRET);  req.user.role='superadmin'; return next(); } catch{}
  fail(res,'Token tidak valid',401);
}

// ════════════════════════════════════════════════
// SETUP — inisialisasi DB
// ════════════════════════════════════════════════
app.get('/api/setup', async (req,res)=>{
  if(req.query.key !== (process.env.SETUP_KEY||'HIMTI2025SETUP'))
    return fail(res,'Key tidak valid',403);
  try{
    await pool.query(`
      CREATE TABLE IF NOT EXISTS administrators (
        id SERIAL PRIMARY KEY,
        nama VARCHAR(100) NOT NULL,
        username VARCHAR(50) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        nama VARCHAR(100) NOT NULL,
        username VARCHAR(50) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        status VARCHAR(20) DEFAULT 'aktif' CHECK(status IN('aktif','tidak_aktif')),
        created_by INT REFERENCES administrators(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS anggota (
        id SERIAL PRIMARY KEY,
        npm VARCHAR(30) NOT NULL UNIQUE,
        nama VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        foto TEXT,
        status VARCHAR(20) DEFAULT 'pending'
          CHECK(status IN('pending','aktif','tidak_aktif','alumni')),
        status_bayar VARCHAR(30) DEFAULT 'belum_bayar'
          CHECK(status_bayar IN('belum_bayar','menunggu_verifikasi','lunas')),
        tanggal_bergabung TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS rekening (
        id SERIAL PRIMARY KEY,
        nama_bank VARCHAR(100) NOT NULL,
        no_rekening VARCHAR(50) NOT NULL,
        atas_nama VARCHAR(100) NOT NULL,
        nominal INT DEFAULT 50000,
        aktif BOOLEAN DEFAULT TRUE,
        catatan TEXT,
        updated_by INT REFERENCES administrators(id),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS pembayaran (
        id SERIAL PRIMARY KEY,
        anggota_id INT NOT NULL REFERENCES anggota(id) ON DELETE CASCADE,
        rekening_id INT REFERENCES rekening(id),
        nominal INT NOT NULL DEFAULT 50000,
        bukti TEXT,
        status VARCHAR(20) DEFAULT 'menunggu'
          CHECK(status IN('menunggu','lunas','ditolak')),
        catatan TEXT,
        verified_by INT REFERENCES admins(id),
        verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS kegiatan (
        id SERIAL PRIMARY KEY,
        judul VARCHAR(200) NOT NULL,
        deskripsi TEXT,
        tanggal DATE NOT NULL,
        waktu_mulai TIME,
        waktu_selesai TIME,
        lokasi VARCHAR(200),
        kode_absen VARCHAR(14) NOT NULL UNIQUE,
        status VARCHAR(20) DEFAULT 'aktif'
          CHECK(status IN('aktif','selesai','dibatalkan')),
        created_by INT REFERENCES admins(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS absensi (
        id SERIAL PRIMARY KEY,
        kegiatan_id INT NOT NULL REFERENCES kegiatan(id) ON DELETE CASCADE,
        anggota_id  INT NOT NULL REFERENCES anggota(id)  ON DELETE CASCADE,
        waktu_absen TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(kegiatan_id, anggota_id)
      );
      CREATE TABLE IF NOT EXISTS pengumuman (
        id SERIAL PRIMARY KEY,
        judul VARCHAR(200) NOT NULL,
        konten TEXT NOT NULL,
        penting BOOLEAN DEFAULT FALSE,
        created_by INT REFERENCES admins(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Seed superadmin
    const h = await bcrypt.hash('himti2025',10);
    await pool.query(`
      INSERT INTO administrators(nama,username,password)
      VALUES('Super Administrator','superadmin',$1)
      ON CONFLICT(username) DO NOTHING
    `,[h]);

    // Seed admin default
    const h2 = await bcrypt.hash('admin2025',10);
    const sa = await q1('SELECT id FROM administrators WHERE username=$1',['superadmin']);
    if(sa){
      await pool.query(`
        INSERT INTO admins(nama,username,password,created_by)
        VALUES('Admin HIMTI','admin',$1,$2)
        ON CONFLICT(username) DO NOTHING
      `,[h2,sa.id]);
    }

    // Seed rekening
    await pool.query(`
      INSERT INTO rekening(nama_bank,no_rekening,atas_nama,nominal,aktif)
      VALUES('BRI','1234567890','HIMTI UMB',50000,TRUE)
      ON CONFLICT DO NOTHING
    `);

    ok(res,{},'✅ Database berhasil diinisialisasi! SA: superadmin/himti2025 | Admin: admin/admin2025');
  }catch(e){ fail(res,'Setup gagal: '+e.message,500); }
});

// ════════════════════════════════════════════════
// AUTH SUPERADMIN
// ════════════════════════════════════════════════
app.post('/api/superadmin/login', async(req,res)=>{
  const {username,password}=req.body;
  if(!username||!password) return fail(res,'Wajib diisi');
  try{
    const r=await q1('SELECT * FROM administrators WHERE username=$1',[username]);
    if(!r||!await bcrypt.compare(password,r.password)) return fail(res,'Username/password salah',401);
    const token=jwt.sign({id:r.id,username:r.username,nama:r.nama},SA_SECRET,{expiresIn:'8h'});
    ok(res,{token,user:{id:r.id,nama:r.nama,username:r.username}},'Login berhasil');
  }catch(e){ fail(res,e.message,500); }
});

app.post('/api/superadmin/change-password', authSA, async(req,res)=>{
  const {lama,baru}=req.body;
  try{
    const r=await q1('SELECT * FROM administrators WHERE id=$1',[req.user.id]);
    if(!await bcrypt.compare(lama,r.password)) return fail(res,'Password lama salah');
    await pool.query('UPDATE administrators SET password=$1 WHERE id=$2',[await bcrypt.hash(baru,10),req.user.id]);
    ok(res,{},'Password diubah');
  }catch(e){ fail(res,e.message,500); }
});

// ── SA: Kelola Admins ─────────────────────────
app.get('/api/superadmin/admins', authSA, async(req,res)=>{
  try{ ok(res,{data:await q('SELECT id,nama,username,status,created_at FROM admins ORDER BY created_at DESC')}); }
  catch(e){ fail(res,e.message,500); }
});
app.post('/api/superadmin/admins', authSA, async(req,res)=>{
  const {nama,username,password}=req.body;
  if(!nama||!username||!password) return fail(res,'Semua field wajib diisi');
  try{
    const h=await bcrypt.hash(password,10);
    const r=await q1('INSERT INTO admins(nama,username,password,created_by) VALUES($1,$2,$3,$4) RETURNING id',[nama,username,h,req.user.id]);
    ok(res,{id:r.id},'Admin berhasil dibuat');
  }catch(e){
    if(e.code==='23505') return fail(res,'Username sudah dipakai');
    fail(res,e.message,500);
  }
});
app.put('/api/superadmin/admins/:id', authSA, async(req,res)=>{
  const {nama,username,status,password}=req.body;
  try{
    if(password){
      const h=await bcrypt.hash(password,10);
      await pool.query('UPDATE admins SET nama=$1,username=$2,status=$3,password=$4 WHERE id=$5',[nama,username,status,h,req.params.id]);
    } else {
      await pool.query('UPDATE admins SET nama=$1,username=$2,status=$3 WHERE id=$4',[nama,username,status,req.params.id]);
    }
    ok(res,{},'Admin diperbarui');
  }catch(e){ fail(res,e.message,500); }
});
app.delete('/api/superadmin/admins/:id', authSA, async(req,res)=>{
  try{ await pool.query('DELETE FROM admins WHERE id=$1',[req.params.id]); ok(res,{},'Admin dihapus'); }
  catch(e){ fail(res,e.message,500); }
});

// ── SA: Rekening ──────────────────────────────
app.get('/api/superadmin/rekening', authSA, async(req,res)=>{
  try{ ok(res,{data:await q('SELECT * FROM rekening ORDER BY aktif DESC,updated_at DESC')}); }
  catch(e){ fail(res,e.message,500); }
});
app.post('/api/superadmin/rekening', authSA, async(req,res)=>{
  const {nama_bank,no_rekening,atas_nama,nominal,catatan}=req.body;
  if(!nama_bank||!no_rekening||!atas_nama) return fail(res,'Wajib diisi');
  try{
    await pool.query('UPDATE rekening SET aktif=FALSE');
    const r=await q1('INSERT INTO rekening(nama_bank,no_rekening,atas_nama,nominal,catatan,updated_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[nama_bank,no_rekening,atas_nama,nominal||50000,catatan||null,req.user.id]);
    ok(res,{id:r.id},'Rekening ditambahkan & diaktifkan');
  }catch(e){ fail(res,e.message,500); }
});
app.put('/api/superadmin/rekening/:id', authSA, async(req,res)=>{
  const {nama_bank,no_rekening,atas_nama,nominal,aktif,catatan}=req.body;
  try{
    if(aktif) await pool.query('UPDATE rekening SET aktif=FALSE');
    await pool.query('UPDATE rekening SET nama_bank=$1,no_rekening=$2,atas_nama=$3,nominal=$4,aktif=$5,catatan=$6,updated_by=$7,updated_at=NOW() WHERE id=$8',[nama_bank,no_rekening,atas_nama,nominal||50000,aktif||false,catatan||null,req.user.id,req.params.id]);
    ok(res,{},'Rekening diperbarui');
  }catch(e){ fail(res,e.message,500); }
});

// ── SA: Stats & Data ──────────────────────────
app.get('/api/superadmin/stats', authSA, async(req,res)=>{
  try{
    const [[{ta}],[{tadm}],[{tk}],[{tp}]]=await Promise.all([
      q("SELECT COUNT(*) ta FROM anggota WHERE status='aktif'"),
      q("SELECT COUNT(*) tadm FROM admins WHERE status='aktif'"),
      q("SELECT COUNT(*) tk FROM kegiatan"),
      q("SELECT COUNT(*) tp FROM pembayaran WHERE status='menunggu'"),
    ]);
    const anggota=await q('SELECT id,npm,nama,email,status,status_bayar,created_at FROM anggota ORDER BY created_at DESC LIMIT 10');
    ok(res,{data:{anggota_aktif:Number(ta),total_admin:Number(tadm),total_kegiatan:Number(tk),menunggu_verif:Number(tp),anggota_terbaru:anggota}});
  }catch(e){ fail(res,e.message,500); }
});
app.get('/api/superadmin/anggota', authSA, async(req,res)=>{
  try{
    const {search,status}=req.query;
    let sql='SELECT id,npm,nama,email,status,status_bayar,tanggal_bergabung,created_at FROM anggota WHERE 1=1';
    const p=[];
    if(search){p.push(`%${search}%`);sql+=` AND (nama ILIKE $${p.length} OR npm ILIKE $${p.length} OR email ILIKE $${p.length})`;}
    if(status){p.push(status);sql+=` AND status=$${p.length}`;}
    sql+=' ORDER BY created_at DESC';
    ok(res,{data:await q(sql,p)});
  }catch(e){ fail(res,e.message,500); }
});
app.put('/api/superadmin/anggota/:id/status', authSA, async(req,res)=>{
  const {status,status_bayar}=req.body;
  try{
    let sql='UPDATE anggota SET ';const p=[];const sets=[];
    if(status){p.push(status);sets.push(`status=$${p.length}`);}
    if(status_bayar){p.push(status_bayar);sets.push(`status_bayar=$${p.length}`);
      if(status_bayar==='lunas'){sets.push('tanggal_bergabung=NOW()');}}
    p.push(req.params.id);
    await pool.query(sql+sets.join(',')+` WHERE id=$${p.length}`,p);
    ok(res,{},'Status diperbarui');
  }catch(e){ fail(res,e.message,500); }
});

// ── SA: Pembayaran ────────────────────────────
app.get('/api/superadmin/pembayaran', authSA, async(req,res)=>{
  try{
    ok(res,{data:await q(`
      SELECT p.*,a.nama,a.npm,a.email,r.nama_bank,r.no_rekening,r.atas_nama
      FROM pembayaran p
      JOIN anggota a ON p.anggota_id=a.id
      LEFT JOIN rekening r ON p.rekening_id=r.id
      ORDER BY p.created_at DESC
    `)});
  }catch(e){ fail(res,e.message,500); }
});

// ════════════════════════════════════════════════
// AUTH ADMIN
// ════════════════════════════════════════════════
app.post('/api/admin/login', async(req,res)=>{
  const {username,password}=req.body;
  if(!username||!password) return fail(res,'Wajib diisi');
  try{
    const r=await q1("SELECT * FROM admins WHERE username=$1 AND status='aktif'",[username]);
    if(!r||!await bcrypt.compare(password,r.password)) return fail(res,'Username/password salah atau akun tidak aktif',401);
    const token=jwt.sign({id:r.id,username:r.username,nama:r.nama},ADM_SECRET,{expiresIn:'8h'});
    ok(res,{token,user:{id:r.id,nama:r.nama,username:r.username}},'Login berhasil');
  }catch(e){ fail(res,e.message,500); }
});

app.post('/api/admin/change-password', authADM, async(req,res)=>{
  const {lama,baru}=req.body;
  try{
    const r=await q1('SELECT * FROM admins WHERE id=$1',[req.user.id]);
    if(!await bcrypt.compare(lama,r.password)) return fail(res,'Password lama salah');
    await pool.query('UPDATE admins SET password=$1 WHERE id=$2',[await bcrypt.hash(baru,10),req.user.id]);
    ok(res,{},'Password diubah');
  }catch(e){ fail(res,e.message,500); }
});

// ── Admin: Stats ──────────────────────────────
app.get('/api/admin/stats', authADM, async(req,res)=>{
  try{
    const [[{ta}],[{tk}],[{tp}],[{tab}]]=await Promise.all([
      q("SELECT COUNT(*) ta FROM anggota WHERE status='aktif'"),
      q("SELECT COUNT(*) tk FROM kegiatan WHERE status='aktif'"),
      q("SELECT COUNT(*) tp FROM pembayaran WHERE status='menunggu'"),
      q("SELECT COUNT(*) tab FROM absensi"),
    ]);
    const kegiatan=await q('SELECT * FROM kegiatan ORDER BY tanggal DESC LIMIT 5');
    ok(res,{data:{anggota_aktif:Number(ta),kegiatan_aktif:Number(tk),menunggu_verif:Number(tp),total_absensi:Number(tab),kegiatan_terbaru:kegiatan}});
  }catch(e){ fail(res,e.message,500); }
});

// ── Admin: Anggota ────────────────────────────
app.get('/api/admin/anggota', authADM, async(req,res)=>{
  try{
    const {search,status}=req.query;
    let sql='SELECT id,npm,nama,email,status,status_bayar,tanggal_bergabung,created_at FROM anggota WHERE 1=1';
    const p=[];
    if(search){p.push(`%${search}%`);sql+=` AND (nama ILIKE $${p.length} OR npm ILIKE $${p.length})`;}
    if(status){p.push(status);sql+=` AND status=$${p.length}`;}
    sql+=' ORDER BY created_at DESC';
    ok(res,{data:await q(sql,p)});
  }catch(e){ fail(res,e.message,500); }
});

app.post('/api/admin/anggota', authADM, async(req,res)=>{
  const {npm,nama,email}=req.body;
  if(!npm||!nama) return fail(res,'NPM dan nama wajib');
  try{
    const tempPass=await bcrypt.hash('himti'+npm,10);
    const r=await q1(`
      INSERT INTO anggota(npm,nama,email,password,status,status_bayar,tanggal_bergabung)
      VALUES($1,$2,$3,$4,'aktif','lunas',NOW()) RETURNING id
    `,[npm,nama,email||`${npm}@himti.ac.id`,tempPass]);
    ok(res,{id:r.id},'Anggota ditambahkan (status: Aktif, Lunas)');
  }catch(e){
    if(e.code==='23505') return fail(res,'NPM atau email sudah terdaftar');
    fail(res,e.message,500);
  }
});

app.put('/api/admin/anggota/:id', authADM, async(req,res)=>{
  const {nama,status,status_bayar,npm}=req.body;
  try{
    const sets=[],p=[];
    if(nama){p.push(nama);sets.push(`nama=$${p.length}`);}
    if(npm){p.push(npm);sets.push(`npm=$${p.length}`);}
    if(status){p.push(status);sets.push(`status=$${p.length}`);}
    if(status_bayar){
      p.push(status_bayar);sets.push(`status_bayar=$${p.length}`);
      if(status_bayar==='lunas') sets.push('tanggal_bergabung=COALESCE(tanggal_bergabung,NOW())');
    }
    if(!sets.length) return fail(res,'Tidak ada data');
    p.push(req.params.id);
    await pool.query(`UPDATE anggota SET ${sets.join(',')} WHERE id=$${p.length}`,p);
    ok(res,{},'Data anggota diperbarui');
  }catch(e){ fail(res,e.message,500); }
});

// ── Admin: Verifikasi Pembayaran ──────────────
app.get('/api/admin/pembayaran', authADM, async(req,res)=>{
  try{
    ok(res,{data:await q(`
      SELECT p.*,a.nama,a.npm,a.email,r.nama_bank,r.no_rekening,r.atas_nama
      FROM pembayaran p
      JOIN anggota a ON p.anggota_id=a.id
      LEFT JOIN rekening r ON p.rekening_id=r.id
      ORDER BY CASE WHEN p.status='menunggu' THEN 0 ELSE 1 END, p.created_at DESC
    `)});
  }catch(e){ fail(res,e.message,500); }
});

app.put('/api/admin/pembayaran/:id', authADM, async(req,res)=>{
  const {status,catatan}=req.body;
  if(!['lunas','ditolak'].includes(status)) return fail(res,'Status tidak valid');
  try{
    const p=await q1('SELECT * FROM pembayaran WHERE id=$1',[req.params.id]);
    if(!p) return fail(res,'Data tidak ditemukan',404);
    await pool.query('UPDATE pembayaran SET status=$1,catatan=$2,verified_by=$3,verified_at=NOW() WHERE id=$4',[status,catatan||null,req.user.id,req.params.id]);
    if(status==='lunas'){
      await pool.query("UPDATE anggota SET status_bayar='lunas',status='aktif',tanggal_bergabung=COALESCE(tanggal_bergabung,NOW()) WHERE id=$1",[p.anggota_id]);
    } else {
      await pool.query("UPDATE anggota SET status_bayar='belum_bayar' WHERE id=$1 AND status_bayar='menunggu_verifikasi'",[p.anggota_id]);
    }
    ok(res,{},'Pembayaran '+status);
  }catch(e){ fail(res,e.message,500); }
});

// ── Admin: Kegiatan ───────────────────────────
app.get('/api/admin/kegiatan', authADM, async(req,res)=>{
  try{ ok(res,{data:await q('SELECT * FROM kegiatan ORDER BY tanggal DESC')}); }
  catch(e){ fail(res,e.message,500); }
});
app.post('/api/admin/kegiatan', authADM, async(req,res)=>{
  const {judul,deskripsi,tanggal,waktu_mulai,waktu_selesai,lokasi}=req.body;
  if(!judul||!tanggal) return fail(res,'Judul dan tanggal wajib');
  const kode='K'+Date.now().toString(36).toUpperCase().slice(-8);
  try{
    const r=await q1('INSERT INTO kegiatan(judul,deskripsi,tanggal,waktu_mulai,waktu_selesai,lokasi,kode_absen,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',[judul,deskripsi||null,tanggal,waktu_mulai||null,waktu_selesai||null,lokasi||null,kode,req.user.id]);
    ok(res,{id:r.id,kode_absen:kode},'Kegiatan dibuat');
  }catch(e){ fail(res,e.message,500); }
});
app.put('/api/admin/kegiatan/:id', authADM, async(req,res)=>{
  const {judul,deskripsi,tanggal,waktu_mulai,waktu_selesai,lokasi,status}=req.body;
  try{
    await pool.query('UPDATE kegiatan SET judul=$1,deskripsi=$2,tanggal=$3,waktu_mulai=$4,waktu_selesai=$5,lokasi=$6,status=$7 WHERE id=$8',[judul,deskripsi,tanggal,waktu_mulai,waktu_selesai,lokasi,status||'aktif',req.params.id]);
    ok(res,{},'Kegiatan diperbarui');
  }catch(e){ fail(res,e.message,500); }
});
app.delete('/api/admin/kegiatan/:id', authADM, async(req,res)=>{
  try{ await pool.query('DELETE FROM kegiatan WHERE id=$1',[req.params.id]); ok(res,{},'Kegiatan dihapus'); }
  catch(e){ fail(res,e.message,500); }
});

// ── Admin: Absensi ────────────────────────────
app.get('/api/admin/absensi/:kegiatan_id', authADM, async(req,res)=>{
  try{
    ok(res,{data:await q(`
      SELECT ab.*,a.npm,a.nama FROM absensi ab
      JOIN anggota a ON ab.anggota_id=a.id
      WHERE ab.kegiatan_id=$1 ORDER BY ab.waktu_absen ASC
    `,[req.params.kegiatan_id])});
  }catch(e){ fail(res,e.message,500); }
});

// ── Admin: Pengumuman ─────────────────────────
app.get('/api/admin/pengumuman', authADMorSA, async(req,res)=>{
  try{ ok(res,{data:await q('SELECT * FROM pengumuman ORDER BY penting DESC,created_at DESC')}); }
  catch(e){ fail(res,e.message,500); }
});
app.post('/api/admin/pengumuman', authADM, async(req,res)=>{
  const {judul,konten,penting}=req.body;
  if(!judul||!konten) return fail(res,'Judul dan konten wajib');
  try{
    const r=await q1('INSERT INTO pengumuman(judul,konten,penting,created_by) VALUES($1,$2,$3,$4) RETURNING id',[judul,konten,penting||false,req.user.id]);
    ok(res,{id:r.id},'Pengumuman dibuat');
  }catch(e){ fail(res,e.message,500); }
});
app.put('/api/admin/pengumuman/:id', authADM, async(req,res)=>{
  const {judul,konten,penting}=req.body;
  try{
    await pool.query('UPDATE pengumuman SET judul=$1,konten=$2,penting=$3 WHERE id=$4',[judul,konten,penting||false,req.params.id]);
    ok(res,{},'Pengumuman diperbarui');
  }catch(e){ fail(res,e.message,500); }
});
app.delete('/api/admin/pengumuman/:id', authADM, async(req,res)=>{
  try{ await pool.query('DELETE FROM pengumuman WHERE id=$1',[req.params.id]); ok(res,{},'Dihapus'); }
  catch(e){ fail(res,e.message,500); }
});

// ════════════════════════════════════════════════
// AUTH ANGGOTA
// ════════════════════════════════════════════════
app.post('/api/anggota/register', async(req,res)=>{
  const {npm,nama,email,password}=req.body;
  if(!npm||!nama||!email||!password) return fail(res,'Semua field wajib diisi');
  if(password.length<6) return fail(res,'Password minimal 6 karakter');
  try{
    const cek=await q1('SELECT id FROM anggota WHERE npm=$1',[npm]);
    if(cek) return fail(res,'NPM '+npm+' sudah terdaftar. Jika sudah pernah mendaftar hubungi admin.');
    const h=await bcrypt.hash(password,10);
    const r=await q1('INSERT INTO anggota(npm,nama,email,password) VALUES($1,$2,$3,$4) RETURNING id',[npm,nama,email,h]);
    ok(res,{id:r.id},'Registrasi berhasil! Silakan login.');
  }catch(e){
    if(e.code==='23505') return fail(res,'NPM atau email sudah terdaftar');
    fail(res,e.message,500);
  }
});

app.post('/api/anggota/login', async(req,res)=>{
  const {npm,password}=req.body;
  if(!npm||!password) return fail(res,'Wajib diisi');
  try{
    const r=await q1('SELECT * FROM anggota WHERE npm=$1',[npm]);
    if(!r||!await bcrypt.compare(password,r.password)) return fail(res,'NPM atau password salah',401);
    const token=jwt.sign({id:r.id,npm:r.npm,nama:r.nama},ANG_SECRET,{expiresIn:'8h'});
    ok(res,{token,user:{id:r.id,npm:r.npm,nama:r.nama,status:r.status,status_bayar:r.status_bayar}},'Login berhasil');
  }catch(e){ fail(res,e.message,500); }
});

// ── Anggota: Profile ──────────────────────────
app.get('/api/anggota/profile', authANG, async(req,res)=>{
  try{
    const r=await q1('SELECT id,npm,nama,email,foto,status,status_bayar,tanggal_bergabung,created_at FROM anggota WHERE id=$1',[req.user.id]);
    ok(res,{data:r});
  }catch(e){ fail(res,e.message,500); }
});

app.put('/api/anggota/profile', authANG, async(req,res)=>{
  const {nama,email,foto,password_lama,password_baru}=req.body;
  try{
    const r=await q1('SELECT * FROM anggota WHERE id=$1',[req.user.id]);
    if(password_lama&&password_baru){
      if(!await bcrypt.compare(password_lama,r.password)) return fail(res,'Password lama salah');
      const h=await bcrypt.hash(password_baru,10);
      await pool.query('UPDATE anggota SET nama=$1,email=$2,foto=$3,password=$4 WHERE id=$5',[nama||r.nama,email||r.email,foto||r.foto,h,req.user.id]);
    } else {
      await pool.query('UPDATE anggota SET nama=$1,email=$2,foto=$3 WHERE id=$4',[nama||r.nama,email||r.email,foto||r.foto,req.user.id]);
    }
    ok(res,{},'Profil diperbarui');
  }catch(e){ fail(res,e.message,500); }
});

// ── Anggota: Rekening ─────────────────────────
app.get('/api/rekening/aktif', async(req,res)=>{
  try{
    const r=await q1('SELECT id,nama_bank,no_rekening,atas_nama,nominal,catatan FROM rekening WHERE aktif=TRUE LIMIT 1');
    ok(res,{data:r});
  }catch(e){ fail(res,e.message,500); }
});

// ── Anggota: Pembayaran ───────────────────────
app.post('/api/anggota/pembayaran', authANG, async(req,res)=>{
  const {bukti}=req.body;
  if(!bukti) return fail(res,'Bukti pembayaran wajib diupload');
  try{
    const profile=await q1('SELECT * FROM anggota WHERE id=$1',[req.user.id]);
    if(profile.status_bayar==='lunas') return fail(res,'Anda sudah terdaftar sebagai anggota aktif');
    const rek=await q1('SELECT id FROM rekening WHERE aktif=TRUE LIMIT 1');
    const existing=await q1("SELECT id FROM pembayaran WHERE anggota_id=$1 AND status='menunggu'",[req.user.id]);
    if(existing) return fail(res,'Pembayaran sebelumnya masih menunggu verifikasi admin');
    await pool.query('INSERT INTO pembayaran(anggota_id,rekening_id,nominal,bukti,status) VALUES($1,$2,$3,$4,$5)',[req.user.id,rek?.id||null,rek?.nominal||50000,bukti,'menunggu']);
    await pool.query("UPDATE anggota SET status_bayar='menunggu_verifikasi' WHERE id=$1",[req.user.id]);
    ok(res,{},'Bukti pembayaran dikirim! Tunggu verifikasi admin.');
  }catch(e){ fail(res,e.message,500); }
});

app.get('/api/anggota/pembayaran', authANG, async(req,res)=>{
  try{
    ok(res,{data:await q(`
      SELECT p.*,r.nama_bank,r.no_rekening,r.atas_nama
      FROM pembayaran p LEFT JOIN rekening r ON p.rekening_id=r.id
      WHERE p.anggota_id=$1 ORDER BY p.created_at DESC
    `,[req.user.id])});
  }catch(e){ fail(res,e.message,500); }
});

// ── Anggota: Kegiatan & Pengumuman ───────────
app.get('/api/anggota/kegiatan', authANG, async(req,res)=>{
  try{
    const profile=await q1('SELECT status FROM anggota WHERE id=$1',[req.user.id]);
    if(profile.status!=='aktif') return fail(res,'Akses hanya untuk anggota aktif',403);
    ok(res,{data:await q("SELECT * FROM kegiatan WHERE status='aktif' AND tanggal>=CURRENT_DATE ORDER BY tanggal ASC")});
  }catch(e){ fail(res,e.message,500); }
});
app.get('/api/anggota/pengumuman', authANG, async(req,res)=>{
  try{
    const profile=await q1('SELECT status FROM anggota WHERE id=$1',[req.user.id]);
    if(profile.status!=='aktif') return fail(res,'Akses hanya untuk anggota aktif',403);
    ok(res,{data:await q('SELECT * FROM pengumuman ORDER BY penting DESC,created_at DESC LIMIT 20')});
  }catch(e){ fail(res,e.message,500); }
});

// ── Anggota: Absensi ──────────────────────────
app.post('/api/anggota/absensi/cek', authANG, async(req,res)=>{
  const {kode}=req.body;
  try{
    const profile=await q1('SELECT status FROM anggota WHERE id=$1',[req.user.id]);
    if(profile.status!=='aktif') return fail(res,'Hanya anggota aktif yang bisa absen',403);
    const k=await q1("SELECT * FROM kegiatan WHERE kode_absen=$1 AND status='aktif'",[kode]);
    if(!k) return fail(res,'Kode tidak valid atau kegiatan tidak aktif',404);
    ok(res,{data:k});
  }catch(e){ fail(res,e.message,500); }
});
app.post('/api/anggota/absensi', authANG, async(req,res)=>{
  const {kode_absen}=req.body;
  try{
    const profile=await q1('SELECT status FROM anggota WHERE id=$1',[req.user.id]);
    if(profile.status!=='aktif') return fail(res,'Hanya anggota aktif yang bisa absen',403);
    const k=await q1("SELECT * FROM kegiatan WHERE kode_absen=$1 AND status='aktif'",[kode_absen]);
    if(!k) return fail(res,'Kegiatan tidak ditemukan',404);
    const cek=await q1('SELECT id FROM absensi WHERE kegiatan_id=$1 AND anggota_id=$2',[k.id,req.user.id]);
    if(cek) return fail(res,'Anda sudah absen untuk kegiatan ini');
    await pool.query('INSERT INTO absensi(kegiatan_id,anggota_id) VALUES($1,$2)',[k.id,req.user.id]);
    ok(res,{kegiatan:k.judul},'Absen berhasil! Selamat datang di '+k.judul);
  }catch(e){ fail(res,e.message,500); }
});
app.get('/api/anggota/absensi', authANG, async(req,res)=>{
  try{
    ok(res,{data:await q(`
      SELECT ab.*,k.judul,k.tanggal,k.lokasi FROM absensi ab
      JOIN kegiatan k ON ab.kegiatan_id=k.id
      WHERE ab.anggota_id=$1 ORDER BY ab.waktu_absen DESC
    `,[req.user.id])});
  }catch(e){ fail(res,e.message,500); }
});

// Health check
app.get('/api', (req,res)=>res.json({status:'ok',app:'HIMTI Web v3.0'}));

if(require.main===module){
  const PORT=process.env.PORT||3000;
  app.listen(PORT,()=>console.log(`🚀 HIMTI Web: http://localhost:${PORT}`));
}
module.exports=app;
