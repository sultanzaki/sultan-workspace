# Fondasi aplikasi tim

## Status fase 1–5

Setelah login, halaman utama kembali memakai UI workspace asli: dashboard, proyek, task, board/list/table/calendar/timeline/files, pencarian, favorit, dan aktivitas. Panel administrasi akun/anggota/tim tersedia melalui **Kelola workspace** atau `/?manage=1`.

Yang sudah terhubung ke PostgreSQL: akun, sesi, undangan, reset password, workspace, peran, aktivasi anggota, tim, keanggotaan tim, antrean email, audit administrasi, **proyek, task, saved views, preferensi tampilan, dan aktivitas perubahan konten**. Fase 2 mencakup CRUD proyek/task, proyek privat, assignee, status, prioritas, tanggal, label, deskripsi, subtask, dependency, arsip/pemulihan, dan deteksi konflik. Fase 3 menghubungkan Board/List/Table/Calendar/Timeline ke data yang sama, termasuk drag-and-drop board/list/calendar/timeline, edit tabel, pencarian, filter, sorting, dan saved views bersama. Preferensi filter/sort/pencarian/tata letak disimpan per pengguna.

Penyimpanan memakai antrean perubahan per objek dengan debounce 300 ms, satu request aktif, revisi workspace, dan ID mutasi untuk retry yang tidak menggandakan perubahan. Backend memvalidasi input, keanggotaan, akses proyek privat, assignee, tanggal, dan siklus dependency. Edit dari revisi lama ditolak dengan HTTP 409. Status simpan ditampilkan permanen; pesan sukses baru muncul setelah server menerima perubahan. Saat gagal/konflik, draft dicadangkan di browser dan dapat diunduh sebagai JSON sebelum **Muat data terbaru**. Tombol **Coba simpan lagi** tersedia untuk kegagalan jaringan. Refresh manual mengambil data server; konflik perlu ditinjau dan diterapkan ulang, tidak digabung otomatis.

Data anggota lain dimuat sekitar setiap 10 detik saat halaman aktif, tanpa edit tertunda dan tanpa fokus di input. Ini polling, belum realtime WebSocket. Menghapus localStorage tidak menghapus proyek/task yang sudah tersimpan. Data lokal dari versi sebelumnya tidak otomatis menimpa database: tombol **Impor data lokal lama** tersedia pada akun/workspace/browser asal, hanya menambahkan ID yang belum ada. Komentar dan isi file tidak diimpor. Penyimpanan `gr8r.v2` milik demo tetap terpisah.

Workspace native dimulai kosong dengan identitas, anggota, dan tim dari API; tidak memuat proyek, anggota, tagihan, atau sesi fiktif dari data demo. Penyimpanan demo lama `gr8r.v2` tetap dipertahankan dan tidak dicampur dengan data native. Tampilan demo seeded masih bisa dibuka terpisah pada development dengan `VITE_ENABLE_DEMO=true npm run dev:web`.

Fase 4–5 menambahkan komentar/mention/reaksi, penyimpanan isi file asli, notifikasi pribadi, pengingat, dan task berulang dari server. Rincian tersedia di [panduan kolaborasi dan otomatisasi](collaboration.md). MFA dan billing belum tersedia; pengaturan akun/anggota tetap melalui pengelolaan native. Email ditunda sampai SMTP dikonfigurasi. Logout mencabut sesi di server, dan UI workspace hanya dimuat setelah sesi serta keanggotaan diverifikasi.

## Arsitektur

Browser → `/api` pada origin yang sama → Express → PostgreSQL schema `app_private`.

Supabase digunakan **hanya sebagai PostgreSQL**. Tidak memakai Supabase Auth, SDK browser, anon key, service-role key, atau REST API Supabase. Kredensial database hanya ada pada proses backend. Jangan memasukkan kredensial ke variabel `VITE_*`.

Pada development, Vite mem-proxy `/api` ke port 3001. Di Vercel, rewrite eksplisit `/api/:path*` mengarahkan semua kedalaman URL ke `api/index.js`, yang menjalankan API sebagai satu Node.js Function dan `dist/` disajikan sebagai frontend. Pada server biasa, `npm start` tetap menjalankan API sekaligus menyajikan `dist/`.

## Menjalankan lokal

Prasyarat: Node 22, npm, dan Docker lokal. Gunakan checkout yang sudah ada; tidak perlu worktree baru.

```bash
npm ci
npm run db:local
npm run db:migrate
```

`db:local` membuat container PostgreSQL 17 pada `127.0.0.1:55432`, volume `sultan-foundation-postgres`, database `sultan` dan `sultan_test`, serta password acak di file lokal berizin terbatas. File `.env.local` yang sudah ada tidak ditimpa. Jangan hapus volume apabila datanya masih diperlukan. Proses/container harus dijalankan lagi setelah environment dipulihkan; volume dan file bukan proses hidup.

Buat owner pertama melalui CLI privat. Simpan JSON berikut di `.local/bootstrap.json` dengan izin `0600`, isi email/nama/password sendiri (password minimal 12, maksimal 128 karakter), lalu jalankan:

```json
{
  "email": "anda@example.com",
  "name": "Nama Anda",
  "workspace": "Nama Tim",
  "password": "GANTI DENGAN PASSWORD UNIK ANDA"
}
```

```bash
npm run owner:create < .local/bootstrap.json
rm .local/bootstrap.json
npm run dev
```

Jangan menggunakan password contoh. CLI menerima password melalui stdin, bukan argumen proses atau log. Bootstrap hanya berhasil saat belum ada user; tidak ada endpoint registrasi publik atau password default. Email owner awal dipercaya sebagai input operator; email anggota berikutnya diverifikasi lewat kepemilikan tautan undangan. Pastikan email bootstrap milik operator yang sah.

Development memakai `MAIL_TRANSPORT=file`: email hanya ditulis ke `.local/mail/*.json`, **tidak dikirim ke penerima**. File tersebut memuat tautan sensitif; jangan dibagikan, dimasukkan Git, atau diunggah sebagai artefak CI. Aplikasi production menolak mode file. Tanpa konfigurasi SMTP, production memakai `MAIL_TRANSPORT=disabled`: login dan administrasi tetap berjalan, sedangkan undangan dan reset lewat email dinonaktifkan secara eksplisit. Backend membersihkan isi email yang sudah dikirim dari outbox database dan menghapus pesan outbox yang lebih dari tujuh hari.

## Membuat owner lewat website Vercel (tanpa terminal dan SMTP)

1. Setelah merge fitur setup dan deployment selesai, buka **Vercel → Settings → Environment Variables**.
2. Tambahkan **`BOOTSTRAP_TOKEN`** pada environment **Production**. Isi dengan kunci acak dari password generator, minimal 32 karakter (disarankan 64). Simpan kunci untuk langkah berikutnya; tidak perlu mengirimnya melalui chat.
3. **Redeploy** agar backend membaca kunci tersebut.
4. Buka **`https://sultan-workspace.vercel.app/#setup`**. Isi kunci setup, nama lengkap, email owner, nama workspace, dan password akun (minimal 12 karakter), kemudian klik **Buat akun owner**.
5. Setelah berhasil, login dengan email/password yang baru dibuat. Hapus `BOOTSTRAP_TOKEN` dari pengaturan Vercel, lalu redeploy.

Halaman setup tidak aktif tanpa kunci di environment. Backend memeriksa kunci, origin request, input, dan rate limit; transaksi database dengan advisory lock memastikan hanya satu akun pertama dapat dibuat. Setelah ada user, pembuatan owner terkunci meskipun kunci belum dihapus. Kunci dan password hanya dikirim lewat body request HTTPS, tidak dimasukkan ke URL atau localStorage, tidak disertakan dalam respons, dan tidak dicatat pada audit. Operator yang memegang kunci dipercaya menentukan email owner pertama; proses ini tidak memerlukan SMTP. Akun berikutnya tetap melalui undangan.

## Menggunakan Supabase PostgreSQL

1. Buat/pilih project Supabase dan buka panel **Connect**. Gunakan direct connection jika host mendukung IPv6, atau **session pooler port 5432** jika membutuhkan IPv4. Hindari transaction pooler port 6543 untuk workflow ini, terutama migrasi dan pengaturan koneksi.
2. Masukkan `DATABASE_URL` pada secret manager hosting/backend. Untuk lokal, gunakan `.env.local` yang diabaikan Git. Tidak perlu mengaktifkan Supabase Auth atau memberikan API key.
3. Koneksi remote selalu menggunakan TLS dengan verifikasi sertifikat aktif. Jika diperlukan, unduh sertifikat CA database dari project Supabase dan set `DATABASE_CA_FILE` ke file tersebut. Jangan menggunakan `rejectUnauthorized=false` atau menonaktifkan TLS.
4. Jalankan `npm run db:migrate` dari koneksi yang berwenang membuat schema/tabel. Migrasi memakai transaksi, advisory lock, dan checksum; aman dijalankan ulang. Jangan mengubah file migrasi yang telah diterapkan: tambahkan migrasi baru.
5. Buat owner melalui halaman setup satu kali di bawah atau CLI di atas. SMTP dapat menyusul; tanpa SMTP, login owner tetap tersedia tetapi undangan dan reset melalui email belum tersedia.

Schema `app_private` tidak boleh ditambahkan ke daftar exposed schemas Supabase. Migrasi mencabut akses schema dari PUBLIC dan role `anon`/`authenticated` bila tersedia. Migrasi pertama tidak mengubah tabel proyek Supabase lain. Gunakan database/project development terpisah dari production.

Untuk production, gunakan role migrasi pemilik schema dan role runtime terpisah yang hanya memiliki `USAGE` pada `app_private`, `SELECT/INSERT/UPDATE/DELETE` pada tabel aplikasi, serta `USAGE/SELECT` pada sequence yang diperlukan. Role runtime tidak perlu superuser, bypass RLS, kemampuan membuat role, atau DDL. Tetapkan default privileges dari role migrasi untuk tabel/sequence baru. Sesuaikan hostname/username session pooler dengan petunjuk Supabase untuk role pilihan Anda; jangan menebak username. Runtime tidak menjalankan migrasi otomatis.

Verifikasi koneksi Supabase belum dilakukan tanpa kredensial project. Tes yang tersedia menggunakan PostgreSQL lokal; ini membuktikan logika aplikasi, bukan akses/konfigurasi project Supabase tertentu.

## Migrasi melalui Supabase SQL Editor (tanpa terminal)

1. Buka project Supabase yang sama dengan `DATABASE_URL` di Vercel.
2. Pilih **SQL Editor → New query**.
3. Buka [supabase-migration.sql](supabase-migration.sql), salin **seluruh isi file**, lalu tempel ke query tersebut.
4. Klik **Run**. Hasil akhir menampilkan nama dan waktu migrasi yang sudah diterapkan. Ini membuat schema `app_private`, tabel aplikasi, dan catatan versi migrasi. Tidak menghapus data yang sudah ada; jika dijalankan lagi, migrasi yang sudah tercatat dilewati setelah checksum diperiksa.
5. Jika berhasil, jalankan query pemeriksaan berikut. Hasilnya harus memuat `001_foundation.sql`, `002_project_content.sql`, dan `003_collaboration_automation.sql`. Upgrade memakai file SQL yang sama: migrasi yang sudah ada dilewati, lalu tabel baru ditambahkan. Akun owner dan data yang sudah ada tetap dipakai.

```sql
select name, applied_at from app_private.schema_migrations;
```

Jika file versi sebelumnya hanya menampilkan kolom kosong `pg_advisory_xact_lock`, itu adalah hasil normal langkah penguncian. Query pemeriksaan di atas memastikan apakah seluruh migrasi sudah selesai.

File ini dihasilkan dari migrasi yang sama dengan CLI. Pengembang dapat membuat ulang melalui `node scripts/export-migrations.js > docs/supabase-migration.sql`. Tidak ada password atau connection string di file migrasi. Migrasi membuat tabel, **bukan membuat akun login**; owner pertama dibuat melalui halaman setup berkunci atau CLI privat.

## Deployment Vercel

1. Merge perubahan yang menyediakan `api/index.js` dan `vercel.json`. Vercel membangun frontend dan function API dari repository yang sama.
2. Di **Settings → Environment Variables**, simpan `DATABASE_URL` sebagai secret backend. Gunakan **Session pooler Supabase port 5432**. Jangan beri prefix `VITE_`. Pisahkan koneksi Preview dari Production agar percobaan PR tidak memakai database operasional.
3. Set `APP_ORIGIN=https://sultan-workspace.vercel.app` untuk domain utama Anda (ubah jika memakai domain sendiri). Bila tidak diisi, backend menggunakan metadata domain Vercel yang disediakan platform. Nilai harus tanpa slash terakhir atau path.
4. Tanpa SMTP, biarkan `MAIL_TRANSPORT` tidak diisi atau isi `disabled`. Jangan memakai `file` di Vercel. Saat SMTP tersedia, set konfigurasi SMTP di atas.
5. Jika database memerlukan CA khusus, isi `DATABASE_CA_PEM` dengan sertifikat CA database dari Supabase. Verifikasi TLS tidak dinonaktifkan. `DB_POOL_MAX` default 2 per instance function dan pool didaftarkan melalui `attachDatabasePool` agar koneksi idle dapat dilepas saat instance dihentikan.
6. Jalankan migrasi melalui SQL Editor di atas atau CLI privat. Buat akun owner melalui setup berkunci atau CLI. Migrasi tidak dijalankan pada build; pembuatan owner melalui web hanya aktif jika operator mengatur kunci setup.
7. Redeploy setelah mengubah environment variables. Buka `/api/health`: hasil normal adalah `{"status":"ok"}`. Tanpa sesi login, `/api/auth/me` semestinya mengembalikan JSON 401, bukan halaman 404 Vercel. Bila migrasi belum dijalankan, API mengembalikan JSON 503 dengan instruksi migrasi. Log inisialisasi sekarang menyebut kode, tahap (`configuration`, `pool`, `database`, atau `application`), dan nama isian terkait; tidak mencetak nilai kredensial. Contoh: `DATABASE_TIMEOUT` berarti koneksi belum tercapai, sedangkan `APP_ORIGIN_INVALID` berarti format domain perlu diperbaiki.

Endpoint `GET /api/internal/maintenance` memeriksa pengingat dan memproses antrean email dengan jumlah dan waktu yang dibatasi untuk Function Vercel. Endpoint memerlukan `Authorization: Bearer <CRON_SECRET>`, dengan secret acak minimal 32 karakter. `vercel.json` menyediakan jadwal harian pukul 00:15 UTC untuk pengingat; aktifkan dengan `CRON_SECRET` di environment Production Vercel. Login, komentar, file, notifikasi langsung, dan pembuatan task berulang tidak memerlukan scheduler atau SMTP. Jika email diaktifkan, cron harian tidak cukup untuk retry reset password yang berlaku 30 menit; gunakan scheduler lebih sering sebelum mengandalkan email operasional.

## Autentikasi dan izin

- Password di-hash dengan scrypt (`N=65536`, `r=8`, `p=1`), salt acak per password. Maksimal 128 karakter; tidak ada password plaintext di database atau log.
- Sesi memakai token acak 256-bit; hanya hash token disimpan di database. Cookie `HttpOnly`, `SameSite=Lax`, dan `Secure` dengan prefix `__Host-` pada production. Durasi 12 jam atau 30 hari bila pengguna memilih "ingat saya"; tidak ada perpanjangan tanpa batas.
- Request yang mengubah data memerlukan origin persis `APP_ORIGIN`, JSON, dan untuk sesi login token CSRF. Tidak ada CORS lintas origin. Vercel menerima origin utama dan hostname deployment/branch yang disediakan platform secara persis, tanpa wildcard. Jangan mengaktifkan proxy trust tanpa batas; `TRUST_PROXY_HOPS` default 1 pada Vercel dan 0 pada server biasa. Sesuaikan jika Anda menambah proxy sendiri.
- Rate limit tersimpan di PostgreSQL, sehingga berlaku antar-instance/restart. Login dan reset dibatasi menurut IP dan email; hindari mencatat IP/email mentah pada tabel limiter.
- Undangan 48 jam, reset 30 menit; token sekali pakai dan hash-nya disimpan di tabel autentikasi. Tautan membawa token pada URL fragment, lalu frontend menghapusnya dari address bar. Isi email antrean memang memuat token sampai dikirim; batasi akses/backup database dan file development.
- Akun yang sudah terdaftar harus login sebagai penerima undangan. Undangan tidak bisa mengganti password akun tersebut. Reset password mencabut semua sesi akun; logout mencabut sesi yang dipakai saat itu.
- Role selalu dibaca dari database pada operasi workspace. Perubahan hak akses tidak menunggu token kedaluwarsa. Deaktivasi berlaku untuk workspace terkait, bukan menghapus seluruh akun lintas-workspace.

| Tindakan                        | Owner | Admin | Member |
| ------------------------------- | ----- | ----- | ------ |
| Melihat workspace/anggota/tim   | Ya    | Ya    | Ya     |
| Mengubah nama workspace dan tim | Ya    | Ya    | Tidak  |
| Mengundang member               | Ya    | Ya    | Tidak  |
| Mengundang admin                | Ya    | Tidak | Tidak  |
| Mengubah role owner/admin       | Ya    | Tidak | Tidak  |
| Menonaktifkan member            | Ya    | Ya    | Tidak  |
| Melihat audit/status pengiriman | Ya    | Ya    | Tidak  |
| Membuat workspace sendiri       | Ya    | Ya    | Ya     |

Workspace harus selalu memiliki minimal satu owner aktif. Perubahan keanggotaan diserialisasi dengan lock workspace untuk melindungi aturan ini ketika beberapa request berjalan bersamaan. Anggota tim harus merupakan anggota aktif workspace yang sama.

## Email dan operasi production

Untuk server biasa, set `NODE_ENV=production`, `APP_ORIGIN=https://domain-anda`, dan `DATABASE_URL`. Untuk mengaktifkan email, tambahkan `MAIL_TRANSPORT=smtp`, `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, dan bila dibutuhkan `SMTP_USER`/`SMTP_PASSWORD`. Tanpa SMTP, production memakai mode disabled; tidak ada klaim email sudah terkirim. `SMTP_SECURE=true` untuk TLS langsung (umumnya port 465); selain itu STARTTLS wajib. Verifikasi sertifikat tetap aktif. Konfigurasi SPF/DKIM/DMARC pada domain pengirim melalui penyedia email.

Outbox ditulis dalam transaksi yang sama dengan undangan/reset. Pada server biasa, worker berkala mengirim antrean dan menjadwalkan ulang kegagalan dengan backoff. Di Vercel, `waitUntil` menjalankan pekerjaan terbatas setelah respons, tanpa interval yang mengandalkan proses terus hidup. Multiple instance memakai `FOR UPDATE SKIP LOCKED`. Seperti umumnya sistem email, crash setelah SMTP menerima pesan tetapi sebelum commit dapat menyebabkan pengiriman ulang; token tetap hanya dapat digunakan sekali. Status terkirim berarti layanan SMTP menerima pesan, bukan bukti pesan sampai inbox. Pantau antrean dan kegagalan SMTP, serta siapkan alert sebelum penggunaan operasional.

Deployment:

```bash
npm ci
npm run db:migrate
npm run build
npm start
```

Jalankan migrasi sebagai langkah deployment terkontrol, sebelum memulai versi backend baru. `GET /api/health` memeriksa akses database/migrasi; endpoint ini tidak membuktikan kesehatan SMTP. Gunakan reverse proxy HTTPS yang meneruskan origin publik dengan benar. Cek backup database Supabase, retensi, dan uji restore sebelum menyimpan data kerja penting. Jangan menjalankan tes reset schema pada database operasional.

## Validasi

```bash
npm run lint
npm run format:check
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

Tes membutuhkan `TEST_DATABASE_URL` khusus pada localhost dengan nama database berakhiran `_test`. Tes menolak URL remote dan tidak memakai `DATABASE_URL` sebagai fallback. **Tes menghapus schema `app_private` pada database tes**, bukan pada database development. Jalankan suite API dan browser berurutan karena keduanya memakai fixture database yang sama. Browser suite menjalankan API dan Vite sendiri pada port 3001/5173; matikan dev server lebih dahulu.

Jika Chromium sudah tersedia, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` ke executable yang dipilih. Tests mencakup akses lintas-workspace, eskalasi role, CSRF, undangan ulang/kedaluwarsa/sekali pakai, perlindungan owner terakhir saat request bersamaan, reset dan pencabutan sesi, outbox, rendering, CRUD konten bersama, akses proyek privat, validasi dependency, konflik edit, retry jaringan, drag-and-drop, filter/sort, saved views antar-akun, serta ketahanan data setelah localStorage dihapus. CI menjalankan seluruh pemeriksaan dengan database disposable.

## Lisensi asal

Repository ini adalah fork dari `gr8rstudio/gr8r-studio`. Pada 3 November 2026, pengguna menyampaikan bahwa pembuat proyek mengonfirmasi lisensi **MIT** dan mengizinkan penggunaan kode. Keterangan ini dicatat sebagai konfirmasi yang diteruskan oleh pengguna; teks lisensi asli belum tersedia di checkout pada pemeriksaan awal.

Simpan teks lisensi MIT dan copyright notice asli dari pembuatnya saat tersedia, serta pertahankan atribusi upstream. Implementasi fondasi ini tidak mengarang tahun, pemegang hak cipta, atau mengganti pemberitahuan milik pembuat asal.

## Tahap selanjutnya

Fase 4–5 sudah mencakup komentar/mention, file asli, notifikasi, pengingat, task berulang, dan tautan langsung ke objek. Fase 6–8 mencakup MFA dan administrasi/perencanaan. Email melalui Resend tersedia sesuai [panduan email](email.md); billing dan object storage untuk file lebih besar tetap terpisah.

Untuk email baru, gunakan [panduan Resend API](email.md). Dukungan SMTP di atas tetap berlaku sebagai alternatif.
