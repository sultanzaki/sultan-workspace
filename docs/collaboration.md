# Kolaborasi dan otomatisasi — fase 4–5

Fitur ini memakai login native, backend Node.js, dan schema `app_private` pada PostgreSQL/Supabase yang sudah tersedia. Tidak membutuhkan Supabase Auth, public bucket, anon key, atau service-role key.

## Aktivasi di Vercel/Supabase

1. Sebelum merge/deploy, salin seluruh [supabase-migration.sql](supabase-migration.sql) ke **Supabase → SQL Editor → New query → Run**. Migrasi lama diverifikasi dan dilewati; migrasi `003_collaboration_automation.sql` menambahkan tabel baru. Akun owner, proyek, dan task dipertahankan.
2. Merge PR dan gunakan deployment Vercel seperti biasa. `DATABASE_URL` dan `DATABASE_CA_PEM` yang sudah bekerja tetap dipakai. Tidak ada kredensial storage baru.
3. Untuk pengingat harian saat tidak ada pengunjung, set `CRON_SECRET` acak minimal 32 karakter pada environment **Production** Vercel, lalu redeploy. Vercel mengirim secret sebagai bearer token pada cron yang tercantum di `vercel.json`: **00:15 UTC setiap hari**. Jangan menaruh secret pada URL atau variabel `VITE_*`.

Komentar, upload/download, notifikasi saat ada aktivitas, dan task berulang tetap bekerja tanpa cron. Pengingat diperiksa saat workspace dibuka, maksimal sekali per menit per workspace. Cron diperlukan untuk pemeriksaan harian tanpa pengunjung. Di server Node biasa, maintenance berjalan dari timer proses. Notifikasi dalam aplikasi tetap bekerja tanpa email. Pengiriman email aktivitas tersedia melalui [integrasi Resend](email.md).

## Komentar dan mention

- Komentar berupa teks biasa, maksimal 5.000 karakter. Identitas penulis dan waktu berasal dari server. Teks HTML ditampilkan sebagai teks, bukan dijalankan.
- Penulis dapat mengedit dengan pemeriksaan versi; perubahan bersamaan menghasilkan konflik, bukan menimpa diam-diam. Penulis, owner, dan admin dapat menghapus komentar yang dapat mereka akses.
- Mention melalui pemilih `@` atau nama lengkap anggota yang unik. Penerima harus aktif dan dapat mengakses proyek. Mention ke anggota tanpa akses ditolak; tidak memberikan akses proyek secara otomatis.
- Reaksi mendukung enam emoji yang tersedia di UI. Operasi menyimpan kondisi yang diinginkan, sehingga retry tidak menggandakan reaksi.
- Komentar baru memberi notifikasi pada anggota yang disebut, assignee, lead proyek, dan peserta percakapan, mengikuti preferensi masing-masing. Penulis tidak diberi notifikasi atas tindakannya sendiri. Mention diprioritaskan agar penerima tidak mendapat dua notifikasi untuk komentar yang sama.
- Riwayat komentar dimuat per 50 item. Tombol **Muat komentar sebelumnya** membuka halaman lebih lama. Draft komentar disimpan lokal per akun/workspace sampai server mengonfirmasi kiriman. Retry kiriman memakai ID yang sama untuk mencegah duplikasi.

## File asli dan lampiran

Isi file disimpan sebagai `bytea` di PostgreSQL bersama metadata, dengan batas **3 MB per file** dan **100 MB atau 500 file per workspace**. Batas ini memungkinkan upload langsung melalui Function Vercel tanpa konfigurasi object storage tambahan. File tidak disimpan di filesystem sementara Vercel atau di localStorage.

Upload dari form task, drawer, tab Files, dan drag-and-drop memakai endpoint yang sama. Indikator menyatakan proses sedang berjalan; keberhasilan baru tampil setelah server menyimpan isi file. Jika koneksi gagal, file tetap berada dalam antrean browser untuk **Coba upload lagi**, dengan ID yang sama, termasuk ketika server sudah menyimpan tetapi responsnya hilang.

Download mengembalikan byte asli. PNG/JPEG/GIF/WebP memiliki pratinjau gambar asli; tipe lain diunduh untuk dibuka di aplikasi yang sesuai. Jenis konten dideteksi dari byte, dan file yang tidak dikenali disajikan sebagai attachment. Mengganti ekstensi menjadi `.png` tidak membuat HTML/SVG dijalankan sebagai gambar. Nama, salinan isi file, dan penghapusan tersimpan di backend.

Setiap baca, preview, rename, copy, dan delete memeriksa sesi serta akses proyek. Tidak ada URL file publik. Lampiran task diturunkan dari file yang benar-benar tersimpan; metadata buatan dari payload task tidak dianggap upload. Saat task dipindahkan, komentar, file, dan notifikasinya mengikuti batas akses proyek tujuan. Menghapus task/proyek menghapus sumber daya terkait melalui foreign key.

## Notifikasi dalam aplikasi

Inbox dan Notifications menampilkan notifikasi pribadi terbaru (hingga 300 item) untuk mention, penugasan, komentar, perubahan status, dan pengingat. Status baca/belum baca serta **Mark all as read** tersimpan per pengguna. Pengguna tidak dapat mengubah status baca milik pengguna lain. Notifikasi proyek yang tidak dapat diakses disaring di server.

**Settings → Notifications** menyimpan preferensi per akun untuk mention, assignment, komentar, status, dan deadline. Ini notifikasi dalam aplikasi; tidak mengklaim mengirim email, desktop push, atau mobile push. Perubahan bersama diperiksa sekitar setiap 10 detik ketika halaman aktif dan tidak sedang diedit.

Tombol Copy link menghasilkan tautan workspace/task/file yang dapat dibuka setelah login. Tautan tetap membutuhkan izin; menyalinnya tidak membuka akses publik.

## Task berulang dan pengingat

Daily, Weekly, Every 2 weeks, dan Monthly memerlukan deadline. Ketika server menerima perubahan ke **done**, transaksi yang sama membuat satu task berikutnya. Aturan kalender menangani panjang bulan dan leap year: 31 Januari → akhir Februari → 31 Maret. Tanggal mulai dan tanggal subtask digeser dengan interval yang sama; checklist dibuka kembali. Isi file dan komentar tidak disalin ke task berikutnya.

Nomor task ditetapkan dari data server, dan catatan occurrence mencegah retry atau reopen/complete membuat duplikasi. Task berikutnya sudah merupakan task tersendiri. Untuk mengubah atau menghentikan pengulangan selanjutnya, ubah aturan pada occurrence aktif yang sudah dibuat. Mengedit occurrence lama yang selesai tidak menghapus occurrence berikutnya.

Pengingat mengikuti tanggal deadline dalam zona waktu penerima (UTC bila belum diatur): sehari sebelumnya, pada hari deadline, dan saat overdue. Setiap kategori dikirim satu kali untuk deadline dan penerima tersebut. Perubahan deadline memungkinkan pengingat baru. Task/proyek yang diarsipkan, task selesai, anggota nonaktif, dan penerima tanpa akses tidak diberi pengingat. Preferensi deadline dihormati.

Pembuatan notifikasi dibatch agar jumlah anggota tidak menambah rangkaian query per penerima. Job memakai lock dan kunci event unik untuk mencegah duplikasi saat request/cron berjalan bersamaan; workspace yang masih segar dilewati. Setiap pemanggilan maintenance menangani hingga 25 workspace, dan workspace aktif juga diperiksa saat dibuka.

## Pengujian

Gunakan database lokal disposable `_test` sesuai [panduan fondasi](foundation.md). Suite API dan browser harus dijalankan berurutan karena memakai fixture database yang sama.

```bash
npm run lint
npm run format:check
npm run build
npm test
npm run test:e2e
```

Tes mencakup akses lintas-workspace/proyek privat, identitas penulis, edit bersamaan, mention, reaksi idempoten, byte file asli, metadata lampiran palsu, pemindahan batas akses, preferensi/status baca pribadi, pagination komentar, recurrence bulanan/leap year, retry/reopen, dan pengingat yang tidak terduplikasi. Browser menguji dua akun dengan komentar, mention, reply, file asli/pratinjau, retry upload saat respons hilang, notifikasi, serta pembuatan occurrence dari UI.
