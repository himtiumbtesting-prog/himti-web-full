# Panduan Deploy ke Jagoan Hosting (cPanel Node.js Selector)

## Prasyarat
- Sudah beli paket **NextGen** dari Jagoan Hosting (paket ini yang support Node.js)
- Sudah punya domain/subdomain yang diarahkan ke hosting ini
- Database Neon PostgreSQL kamu masih tetap dipakai (TIDAK perlu pindah database)

## Langkah 1 — Setup Node.js App di cPanel

1. Login ke **cPanel** Jagoan Hosting kamu
2. Cari menu **"Setup Node.js App"** (biasanya di bagian "Software")
3. Klik **"Create Application"**
4. Isi:
   - **Node.js version**: pilih versi terbaru yang tersedia (18.x atau 20.x)
   - **Application mode**: Production
   - **Application root**: `himti-app` (folder ini akan otomatis dibuat di dalam home direktori kamu, BUKAN di public_html)
   - **Application URL**: pilih domain/subdomain yang mau dipakai (misal `himti.namadomainkamu.com` atau domain utama)
   - **Application startup file**: `server.js`
5. Klik **Create**

## Langkah 2 — Upload File

Setelah aplikasi dibuat, cPanel akan menunjukkan path folder aplikasi (misal `/home/USERNAME/himti-app`).

**Cara upload (pilih salah satu):**

**A. Lewat File Manager cPanel:**
1. Buka **File Manager** di cPanel
2. Masuk ke folder `himti-app` (yang tadi dibuat)
3. Upload semua isi ZIP ini (server.js, package.json, folder public/) ke situ
4. Extract kalau upload dalam bentuk ZIP

**B. Lewat FTP (FileZilla dll):**
1. Connect ke hosting pakai kredensial FTP dari cPanel
2. Upload ke folder `himti-app`

## Langkah 3 — Isi Environment Variables

1. Kembali ke halaman **Setup Node.js App**
2. Klik aplikasi yang tadi dibuat untuk edit
3. Cari bagian **"Environment Variables"**
4. Tambahkan:
   - `DATABASE_URL` = connection string Neon PostgreSQL kamu
   - `JWT_SECRET` = string acak panjang (bebas, minimal 32 karakter)
5. Klik **Save**

## Langkah 4 — Install Dependencies

1. Masih di halaman Setup Node.js App, cari tombol **"Run NPM Install"**
2. Klik tombol tersebut, tunggu sampai selesai (menginstall semua package di package.json)

## Langkah 5 — Restart Aplikasi

1. Klik tombol **"Restart"** di halaman Setup Node.js App
2. Tunggu beberapa detik

## Langkah 6 — Inisialisasi Database

Buka di browser:
```
https://domainkamu.com/api/setup?key=HIMTI2025SETUP
```
Harus muncul respons sukses menandakan tabel database berhasil dibuat/disinkronkan.

## Langkah 7 — Test Website

Buka:
```
https://domainkamu.com/anggota/login.html
https://domainkamu.com/admin/login.html
https://domainkamu.com/superadmin/login.html
```

## Troubleshooting

**Kalau muncul error 503/502:**
- Cek log aplikasi di halaman Setup Node.js App (ada tombol untuk lihat log)
- Pastikan DATABASE_URL sudah benar
- Pastikan "Run NPM Install" sudah dijalankan dan tidak ada error

**Kalau file tidak ketemu (404) untuk halaman seperti /anggota/login.html:**
- Pastikan folder `public/` ter-upload lengkap dengan semua isinya di dalam Application root

**Setiap kali update kode:**
1. Upload file baru (timpa yang lama)
2. Klik "Restart" lagi di halaman Setup Node.js App
