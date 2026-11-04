# Akun, administrasi, dan perencanaan — fase 6–8

Login tetap native dengan backend Node.js. Supabase dipakai sebagai PostgreSQL, tanpa Supabase Auth.

## Aktivasi

1. Sebelum merge/deploy, jalankan seluruh [supabase-migration.sql](supabase-migration.sql) melalui **Supabase → SQL Editor → New query → Run**. Migrasi yang sudah pernah dijalankan diverifikasi lalu dilewati. Migrasi 004–006 menambah profil/2FA, pengaturan dan izin, serta event kalender. Akun dan data yang ada dipertahankan.
2. Deploy aplikasi dengan `DATABASE_URL`, `DATABASE_CA_PEM`, dan `APP_ORIGIN` yang sudah bekerja. Undangan manual, profil, sesi, izin, milestone, dan kalender tidak membutuhkan SMTP atau credential baru.
3. Untuk mengaktifkan setup 2FA, tambahkan **AUTH_ENCRYPTION_KEY** pada environment server Vercel lalu redeploy. Buat nilai acak 32 byte dalam base64, misalnya `openssl rand -base64 32`, dan simpan di pengelola secret. Jangan gunakan prefix `VITE_`. Kunci ini harus tetap sama pada deployment berikutnya; menggantinya sembarangan membuat secret authenticator yang ada tidak dapat dibaca. Cadangkan kunci bersama backup database secara aman.

Perubahan ini menambah fitur melalui PR; tidak menjalankan migrasi pada database produksi atau mengganti konfigurasi Vercel secara otomatis. Pastikan seluruh perubahan fitur sudah berada di branch main sebelum deployment Production. Untuk PR bertingkat, gunakan PR rilis yang menyatukan cabang fitur ke main, atau ubah base PR berikutnya ke main sebelum merge.

## Akun dan keamanan

Buka **Settings** dari sidebar atau **Kelola workspace**, lalu pilih **Profile**, **Password**, **Sessions**, atau **Two-factor authentication**.

- Nama, jabatan, warna avatar, dan foto profil disimpan di server. Foto PNG/JPEG/WebP maksimal 256 KB disimpan dalam database; URL foto tetap memerlukan sesi dan hubungan workspace/proyek yang sesuai. Email login ditampilkan untuk identitas akun dan tidak dapat diganti melalui form profil.
- Password saat ini diverifikasi sebelum perubahan. Password baru minimal 12 karakter. Perubahan password mencabut seluruh sesi, challenge login, dan link reset password akun tersebut.
- Daftar sesi menampilkan user agent, waktu login, kedaluwarsa, dan penanda sesi ini. Pengguna dapat mencabut satu sesi atau seluruh sesi lain. Token sesi dan CSRF tidak ditampilkan dalam daftar.
- 2FA memakai TOTP standar: aplikasi seperti Google Authenticator, Aegis, 1Password, atau Authy. QR dibuat lokal di browser. Setup harus dikonfirmasi dengan kode sungguhan sebelum aktif. Secret di database dienkripsi AES-256-GCM dengan identitas akun sebagai associated data.
- Setelah 2FA aktif, password hanya menghasilkan challenge sementara; cookie sesi baru diterbitkan sesudah kode kedua benar. Kode TOTP yang sudah dipakai ditolak. Challenge dibatasi percobaan dan berlaku lima menit.
- Sepuluh recovery code ditampilkan saat dibuat dan bisa diunduh. Setiap kode hanya dapat dipakai sekali; database menyimpan hash. Membuat ulang recovery code membatalkan kode lama. Menonaktifkan 2FA atau membuat ulang kode memerlukan password dan faktor kedua. Setup 2FA mencabut sesi lain.
- Jika authenticator hilang, pakai recovery code pada form login. Reset password melalui email tidak menonaktifkan 2FA. Jangan mengganti kunci enkripsi untuk mencoba memulihkan akun.

## Undangan tanpa SMTP

Di **Settings → Members → Undang anggota**, isi email dan role, pilih **Link manual**, lalu buat undangan. Untuk guest, pilih proyek dan tingkat izinnya. Salin link yang ditampilkan dan kirim sendiri ke penerima. Tidak ada email yang dikirim oleh mode ini.

Link ditampilkan sekali, berlaku 48 jam, dan hanya bisa digunakan sekali. Penerima membuat password sendiri. Akun yang sudah ada harus login sebagai email penerima. Undangan yang belum digunakan bisa dibatalkan atau dibuatkan link baru; link lama langsung tidak berlaku. Daftar undangan tidak menyimpan token dalam respons API. Menerima undangan tidak menurunkan role anggota aktif.

Resend API kini didukung langsung; ikuti [panduan email](email.md) untuk aktivasi yang disarankan. Alternatif SMTP tetap tersedia sesuai [panduan fondasi](foundation.md): `MAIL_TRANSPORT=smtp`, `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER=resend`, `SMTP_PASSWORD` berisi API key Resend, dan `MAIL_FROM` pada domain pengirim yang sudah diverifikasi. Redeploy. Pilihan kirim email tersedia setelah layanan email diaktifkan. Jangan kirim API key ke chat atau commit ke git.

## Administrasi dan izin

Owner/admin dapat mengedit nama, slug, warna, kebijakan workspace, serta membuat/mengedit/menghapus tim. Slug bisa dipakai pada `/?workspace=slug`; link lama dengan ID workspace tetap berlaku. Menghapus tim melepaskan hubungan proyek dengan tim tersebut; proyek/task dipertahankan.

Owner dapat mengatur role owner/admin/member/guest. Admin hanya mengelola member dan guest. Workspace harus tetap memiliki satu owner aktif. Menonaktifkan anggota mencabut sesi login dan mengeluarkannya dari tim; mengubah role menjadi guest juga mengeluarkannya dari tim internal.

**Share proyek** mengatur proyek privat, anggota, dan izin khusus:

| Izin                 | Kemampuan                                                                          |
| -------------------- | ---------------------------------------------------------------------------------- |
| Viewer               | Membaca proyek, task, komentar, file, event                                        |
| Commenter            | Viewer + membuat/mengedit komentar sendiri dan bereaksi                            |
| Editor               | Commenter + mengubah task, metadata proyek, milestone, event, saved view, dan file |
| Lead / owner / admin | Editor + mengelola akses, arsip, dan penghapusan proyek                            |

Anggota internal mewarisi izin editor pada proyek terbuka. Izin khusus dapat menurunkan akses anggota menjadi viewer/commenter. Menghapus izin khusus dari anggota internal mengembalikan akses bawaan; gunakan proyek privat bila ingin membatasi hanya anggota terpilih. Guest selalu perlu ditambahkan ke proyek secara khusus, termasuk pada proyek terbuka. Guest tidak dapat membuat proyek, menjadi lead, atau mengelola workspace.

Kebijakan **Members can create projects** berlaku di server. Kebijakan **lead boleh mengundang guest** hanya mengizinkan lead mengundang guest ke proyek yang dikelolanya.

Anggota internal bisa meminta akses proyek privat lewat link proyek. Pengguna yang sudah memiliki akses dapat meminta peningkatan izin lewat Share. Lead/owner/admin memutuskan lewat **Settings → Permissions**. Persetujuan benar-benar mengubah akses proyek. Guest tidak bisa meminta proyek yang belum pernah dibagikan kepadanya. Permintaan dan statusnya disimpan di database; tidak mengirim email.

Hanya owner dapat menghapus workspace permanen, setelah mengetik nama workspace, password, dan faktor kedua bila 2FA aktif. Penghapusan memakai foreign key untuk menghapus data workspace itu saja.

## Milestone dan event kalender

**Project → Overview → Milestones** menyediakan tambah, edit, hapus, dan penanda selesai pada milestone beserta nama/tanggal target. Data yang sama muncul pada ringkasan dan timeline. Perubahan membutuhkan izin editor.

**Calendar → Buat event** membuat jadwal terpisah dari deadline task. Event berisi proyek, judul, tanggal/jam, zona waktu IANA, durasi, jenis, peserta, deskripsi, lokasi, dan link meeting HTTP/HTTPS. Peserta harus anggota aktif yang dapat membaca proyek. Event bisa diedit, dihapus, atau dipindah tanggal dengan drag-and-drop. Penghapusan proyek menghapus event proyek itu.

Server menghitung waktu mulai/selesai UTC dari jadwal dan zona waktu. Kalender menampilkan waktu sesuai preferensi pengguna, termasuk jika konversinya berpindah hari. Event sepanjang hari mempertahankan tanggal kalender. Jam yang tidak ada saat pergantian DST ditolak; jam ambigu memakai occurrence pertama dan tetap stabil ketika metadata event diedit. Event kalender tidak otomatis membuat task atau mengirim reminder/email; pengingat deadline tetap untuk task.

## Preferensi pribadi

Tema, aksen, density, motion, navigasi sidebar, layout/filter/sort, tampilan awal aplikasi/proyek, panel task, konfirmasi hapus, tampil/sembunyikan task selesai di board, serta favorit proyek/task disimpan per akun/workspace. Memberi bintang tidak memerlukan izin editor dan tidak mengubah favorit anggota lain.

Bahasa navigasi tersedia dalam English/Bahasa Indonesia; tanggal dan nama hari/bulan mengikuti bahasa yang dipilih. Judul, nama orang/tim, komentar, serta isi proyek/task tidak diterjemahkan. Pengaturan waktu memakai zona IANA, awal minggu, format tanggal, dan format jam 12/24. Event dikonversi ke zona itu; tanggal deadline task tetap tanggal kalender. Pengingat task memakai zona waktu penerima, dengan UTC sebagai fallback bagi pengaturan lama/tidak valid.

## Pengujian

`npm test` menggunakan PostgreSQL lokal disposable `_test`; `npm run test:e2e` mereset database yang sama, sehingga jalankan berurutan. Tes mencakup vektor TOTP RFC 6238, enkripsi yang terikat akun, replay/recovery, sesi dan password, undangan manual tanpa SMTP, matriks izin guest/internal, akses lintas workspace, last-owner, tim/workspace, milestone, jadwal UTC/DST, preferensi pribadi dan pengingat sesuai timezone. Browser menguji alur pengaturan utama, undangan guest, QR/2FA/login recovery, profil, milestone, event, dan persistensi setelah reload.
