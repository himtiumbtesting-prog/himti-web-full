# HIMTI UMB Web Management System v2.1

## ✨ Fitur v2.1 (Update Terbaru)
- ✅ **Single Session** - Satu akun hanya bisa login di 1 perangkat
- ✅ **Auto Kick** - Perangkat lama otomatis keluar jika ada login baru
- ✅ **Notifikasi Session** - Pop-up jelas saat sesi berakhir
- ✅ **Super Admin** bisa lihat data anggota + download Excel
- ✅ Logout proper (hapus session di server)

## ✨ Fitur v2.0
- Dashboard anggota simplified (clean card layout)
- Cari anggota (nama, NPM, tahun bergabung)
- Masa aktif keanggotaan 2 tahun
- Perpanjangan masa aktif oleh anggota + proses admin
- Admin input nomor WA/HP (tampil ke semua anggota)
- Export data anggota per tahun ke Excel
- Info pembayaran di halaman daftar dan beranda
- Kartu anggota digital dengan masa aktif

## Kredensial Default
- Super Admin: `superadmin` / `himti2025`
- Admin: `admin` / `admin2025`

## Cara Update di GitHub
1. Upload semua file (kecuali node_modules)
2. Commit changes
3. Vercel auto-deploy ~1 menit
4. Jalankan `/api/setup?key=HIMTI2025SETUP` untuk update DB schema
