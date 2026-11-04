# Email melalui Resend

Implementasi ini mencakup undangan/kirim ulang undangan, reset password, mention, penugasan, komentar, perubahan status task, pengingat deadline, ringkasan harian, pemberitahuan perubahan password/2FA, preferensi pribadi, unsubscribe, antrean/retry, dan status pengiriman. Login dan 2FA tetap native.

## Aktivasi di Vercel

1. Jalankan seluruh [supabase-migration.sql](supabase-migration.sql) di **Supabase → SQL Editor → New query → Run** sebelum memakai versi aplikasi ini. Migrasi 007 menambahkan data email; akun dan data kerja yang ada dipertahankan.
2. Pastikan seluruh perubahan akun, kolaborasi, dan email sudah masuk ke branch **main** yang dipakai deployment Production. PR yang digabung ke cabang fitur belum otomatis memperbarui production. Setelah kode Resend tersedia di main, di **Vercel → Project → Settings → Environment Variables**, isi untuk environment yang digunakan:

   | Nama             | Nilai                                                                           |
   | ---------------- | ------------------------------------------------------------------------------- |
   | `MAIL_TRANSPORT` | `resend`                                                                        |
   | `RESEND_API_KEY` | API key dari Resend dengan akses mengirim pada domain Anda                      |
   | `MAIL_FROM`      | Alamat pengirim pada domain terverifikasi, misalnya `notifikasi@domainanda.com` |

   `APP_ORIGIN` tetap alamat website production tanpa trailing slash. `DATABASE_URL`, CA database, dan kunci 2FA yang sudah bekerja tetap dipakai. Semua credential hanya untuk backend, tanpa prefix `VITE_`.

3. **Redeploy**. Tidak perlu memasang SMTP jika memakai mode `resend`. Integrasi memakai HTTPS Resend API dan idempotency key, sehingga retry setelah respons terputus memakai pesan yang sama.
4. Buka **Settings → Members → Undang anggota → Kirim email**. Undangan yang masih aktif bisa dikirim ulang dengan **Kirim ulang email**; link lama dibatalkan. Form **Lupa password?** tetap tersedia sebelum login. Undangan manual juga tetap tersedia.

Aktivasi Resend di dashboard belum otomatis mengisi environment Vercel. Kode tidak menaruh API key dalam database, bundle frontend, atau git. Pengujian otomatis memakai provider mock dan file development, tanpa mengirim email sungguhan.

## Preferensi dan unsubscribe

**Settings → Notifications → Email** menyimpan enam pilihan per akun/workspace. Mention, penugasan, dan deadline aktif secara bawaan; komentar, perubahan status, dan ringkasan harian bisa diaktifkan sesuai kebutuhan. Notifikasi aplikasi memiliki pengaturan terpisah.

Email aktivitas hanya dikirim kepada anggota aktif yang masih memiliki akses ke proyek. Tindakan sendiri tidak menghasilkan email aktivitas untuk pelakunya. Assignee, mention, dan komentar diperiksa kembali sebelum kirim. Task/proyek yang diarsipkan tidak dikirim. Event kalender dan permintaan akses proyek belum mengirim undangan/reminder email tersendiri; opsi email yang tersedia di Settings adalah cakupan pengiriman aktivitas ini.

Setiap email aktivitas memiliki link **Berhenti berlangganan**. Link membuka halaman konfirmasi, sehingga pemindai link tidak langsung mematikan email. Konfirmasi menonaktifkan seluruh email aktivitas di workspace itu dan mempertahankan preferensi aplikasi. Pengguna dapat mengaktifkannya kembali lewat Settings. Link tidak dapat dipakai untuk login atau mengubah password.

Email undangan, pemulihan, dan pemberitahuan perubahan password/2FA bersifat transaksional dan tidak mengikuti toggle aktivitas. Pemberitahuan keamanan tidak berisi password, secret authenticator, atau recovery code. Reset password tidak menonaktifkan 2FA.

## Pengiriman terjadwal dan antrean

Pada Vercel, pekerjaan email dijalankan melalui `waitUntil` setelah respons API; pengguna tidak perlu membiarkan tab terbuka. Pemrosesan dibatasi waktu agar tetap sesuai batas Function. Di server Node biasa worker berjalan berkala setiap lima detik.

Untuk pengiriman saat tidak ada pengunjung, set **`CRON_SECRET`** acak minimal 32 karakter pada Vercel Production lalu redeploy. Jadwal dalam `vercel.json` memanggil `/api/internal/maintenance` setiap hari **00:15 UTC**, kompatibel dengan Vercel Hobby. Vercel memasang header bearer secret otomatis.

Ringkasan harian memakai slot tersebut: sekitar **07:15 WIB**, bukan pukul 08:00 dari prototype awal. UI menampilkan jam dalam zona waktu pengguna. Hari kerja ditentukan berdasarkan zona waktu penerima pada slot itu. Setiap akun/workspace mendapat paling banyak satu ringkasan untuk satu slot; tanpa aktivitas tidak ada email kosong. Ringkasan memuat maksimal 50 aktivitas terbaru. Pengiriman Senin dapat mencakup akhir pekan sejak slot hari kerja sebelumnya, dengan riwayat maksimal tujuh hari.

Jika antrean besar atau ingin retry tetap cepat tanpa pengunjung, gunakan scheduler lebih sering—misalnya setiap lima menit melalui cron Vercel Pro atau scheduler HTTP eksternal—ke endpoint yang sama, dengan `Authorization: Bearer <CRON_SECRET>`. Cron harian saja tidak menjamin retry cepat untuk link reset yang berlaku 30 menit. Pengiriman normal tetap dicoba segera sesudah request yang membuat email; perhatikan kuota/rate limit paket Resend.

Antrean dibangun dalam transaksi dan dibatch. Worker menggunakan claim dengan masa berlaku dan row lock agar instance bersamaan tidak mengirim baris yang sama. Pesan HTML/plain text dibekukan sebelum pemanggilan provider; retry mempertahankan payload dan idempotency key. Izin, status anggota, preferensi, serta masa berlaku link tetap diperiksa sebelum kirim.

Pesan yang belum dicoba disimpan maksimal tujuh hari. Setelah dirender untuk percobaan pertama, batas pengiriman dipendekkan menjadi maksimal 23 jam agar tetap berada dalam jendela idempotency Resend. Kegagalan sementara dicoba ulang dengan backoff, maksimal delapan percobaan; penolakan permanen dihentikan. Isi email dan link sensitif dibersihkan dari outbox setelah diterima provider, dibatalkan, atau gagal permanen. Metadata status disimpan maksimal tujuh hari.

## Status delivered dan bounce

**Settings → Email → Status pengiriman email** tersedia untuk owner/admin workspace. Status **Diterima layanan email** berarti Resend menerima request; status tersebut belum membuktikan email sampai di mailbox.

Agar status mailbox ikut diperbarui:

1. Di **Resend → Webhooks**, tambahkan URL `https://alamat-website-anda/api/webhooks/resend`.
2. Pilih `email.delivered`, `email.bounced`, `email.complained`, `email.failed`, dan `email.delivery_delayed`.
3. Simpan signing secret `whsec_…` ke **`RESEND_WEBHOOK_SECRET`** di Vercel lalu redeploy.

Endpoint memverifikasi signature Svix terhadap body asli dan timestamp, serta mencegah pemrosesan ulang berdasarkan ID webhook. Event lama tidak dapat menurunkan status delivered menjadi delayed. Body email dan payload provider tidak ditampilkan di halaman admin.

Bounce dan complaint memblokir pengiriman berikutnya ke alamat tersebut melalui `app_private.email_suppressions`. Periksa alamat/persetujuan penerima dan status suppression di Resend sebelum memulihkannya. Setelah penyebabnya benar-benar selesai, operator database dapat menghapus entri alamat terkait dari tabel suppression aplikasi; pengaturan email pribadi tetap dihormati. Pesan yang sudah gagal/dibatalkan tidak otomatis dikirim ulang.

Pesan yang masih mengantre setelah kegagalan sementara dapat dipercepat melalui **Coba pengiriman lagi**. Untuk undangan gagal atau link kedaluwarsa, gunakan **Kirim ulang email** untuk membuat link baru. Untuk reset, ajukan kembali lewat **Lupa password?**.

## Pengujian

Jalankan `npm test` dan `npm run test:e2e` secara berurutan pada database lokal `_test`. Tes menggunakan PostgreSQL sungguhan, provider Resend mock, dan transport file untuk browser. Cakupannya meliputi payload/idempotency, HTML escaping, kategori email yang terpisah dari push, izin yang dicabut, preferensi berubah sebelum kirim, worker bersamaan, retry, ringkasan hari kerja/akhir pekan, unsubscribe, pemberitahuan keamanan, signature/replay webhook, suppression, dan akses admin. Pengujian browser memastikan email benar-benar terbentuk di outbox serta file development, lalu menguji konfirmasi unsubscribe.
