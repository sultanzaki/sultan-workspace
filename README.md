# Gr8r Studio — fondasi aplikasi tim

Aplikasi tim dengan **login native dan PostgreSQL**, siap dikoneksikan ke **Supabase Database tanpa Supabase Auth**. Frontend menggunakan JavaScript ES Modules/CSS/Vite; backend menggunakan Node.js/Express.

Fondasi yang sudah diimplementasikan:

- Login/logout, cookie sesi aman, reset password, dan akun baru melalui undangan.
- Workspace, role owner/admin/member, aktivasi anggota, tim, dan audit administrasi.
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

**Akun, anggota, dan tim memakai database; proyek/task/komentar masih disimpan lokal di browser dan belum tersinkron ke tim.** Penanda ini ditampilkan pada UI. Data lokal dipisahkan per akun dan workspace, tanpa memuat data demo sebagai data tim. Penyimpanan isi file dan beberapa simulasi akun asal belum tersedia; integrasi domain ke backend adalah tahap berikutnya.

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
