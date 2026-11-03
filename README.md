# Gr8r Studio — workspace tim

Aplikasi tim dengan **login native dan PostgreSQL**, siap dikoneksikan ke **Supabase Database tanpa Supabase Auth**. Frontend menggunakan JavaScript ES Modules/CSS/Vite; backend menggunakan Node.js/Express.

Fondasi yang sudah diimplementasikan:

- Login/logout, cookie sesi aman, reset password, dan akun baru melalui undangan.
- Workspace, role owner/admin/member, aktivasi anggota, tim, dan audit administrasi.
- Proyek dan task bersama: CRUD, assignee, status, prioritas, tanggal, label, subtask, dependency, arsip, dan pemulihan.
- Board/List/Table/Calendar/Timeline memakai data database yang sama, termasuk drag-and-drop, pencarian, filter, sorting, dan saved views.
- Deteksi konflik edit, retry penyimpanan, serta pembatasan akses proyek privat di backend.
- Komentar/mention, edit/hapus komentar, reaksi, file asli privat, serta aktivitas kolaborasi.
- Inbox/notifikasi pribadi, status baca dan preferensi per akun, pengingat deadline, serta task berulang dari server.
- Migrasi PostgreSQL dalam schema privat, antrean email dengan retry, serta validasi dan izin di backend.
- Tes API dengan PostgreSQL sungguhan, browser tests, dan CI.

## Mulai lokal

Memerlukan Node 22 dan Docker.

```bash
npm ci
npm run db:local
npm run db:migrate
```

Buat owner pertama melalui `npm run owner:create` dengan JSON melalui stdin, kemudian jalankan `npm run dev`. Ikuti [panduan fondasi](docs/foundation.md) untuk format input, pengiriman email development, konfigurasi Supabase, SMTP, deployment, dan pengujian.

## Vercel dan migrasi Supabase

API Vercel tersedia melalui `api/index.js`; frontend dan backend dideploy bersama. Login tidak membutuhkan SMTP. Tanpa SMTP, undangan dan pemulihan lewat email ditampilkan sebagai belum tersedia.

Untuk membuat tabel tanpa terminal, buka **Supabase → SQL Editor → New query**, salin seluruh [file migrasi SQL](docs/supabase-migration.sql), lalu klik **Run**. Setelah itu buat owner pertama melalui halaman `/#setup` dengan `BOOTSTRAP_TOKEN` di Vercel, atau gunakan CLI privat. Panduan konfigurasi Vercel dan pemeriksaannya ada di [docs/foundation.md](docs/foundation.md).

## Status integrasi

Setelah login, tampilan workspace asli tersedia kembali, termasuk Projects, Tasks, board/list/table/calendar/timeline/files. Pengelolaan akun dan anggota tersedia melalui **Kelola workspace**.

**Proyek, task, saved views, komentar, file asli, dan notifikasi sudah tersimpan di PostgreSQL.** Akses mengikuti izin workspace/proyek. Preferensi tampilan dan notifikasi disimpan per akun. Perubahan anggota lain dimuat sekitar setiap 10 detik saat halaman aktif dan tidak sedang diedit. Email tetap ditunda. Lihat [panduan fase 4–5](docs/collaboration.md) untuk batas file, task berulang, dan pengingat.

**Upgrade dari versi sebelumnya:** sebelum merge/deploy, jalankan seluruh [file migrasi SQL terbaru](docs/supabase-migration.sql) di Supabase SQL Editor. Migrasi lama dilewati; `003_collaboration_automation.sql` menambahkan tabel komentar, isi file, notifikasi, dan catatan otomatisasi tanpa menghapus akun/proyek/task. Data proyek/task browser lama dapat dipindahkan lewat **Impor data lokal lama** pada akun dan browser asal; data demo tidak diimpor otomatis.

File maksimal **3 MB per file**, dengan kuota **100 MB/500 file per workspace**. Pengingat diperiksa saat workspace dibuka. Untuk pemeriksaan harian tanpa pengunjung di Vercel, tambahkan `CRON_SECRET` acak minimal 32 karakter; jadwal harian sudah tersedia di `vercel.json`. SMTP tidak diperlukan.

```bash
npm run lint
npm run format:check
npm run build
npm test
npm run test:e2e
```

Tes membutuhkan database lokal disposable khusus; lihat panduan sebelum menjalankan. Tidak ada kredensial Supabase atau SMTP yang disertakan di repository.

Menurut konfirmasi pengguna dari pembuat proyek, kode asal berlisensi **MIT**. Catatan atribusi dan status teks lisensi asli tersedia di [panduan fondasi](docs/foundation.md).

Catatan arsitektur UI asal tersedia di [dokumentasi prototype](docs/prototype.md).
