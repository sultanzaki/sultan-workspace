# Fondasi aplikasi tim

## Batas tahap ini

Halaman utama sekarang memakai akun dan data workspace sungguhan melalui API. Yang sudah terhubung ke PostgreSQL: akun, sesi, undangan, reset password, workspace, peran, aktivasi anggota, tim, keanggotaan tim, antrean email, dan audit administrasi. Belum ada sinkronisasi proyek/task/komentar/file dari prototype ke database. Jangan memasukkan pekerjaan operasional ke prototype.

Kode prototype dipertahankan di `src/demo.js` untuk tahap integrasi berikutnya. Hanya dapat dibuka dalam development dengan `VITE_ENABLE_DEMO=true npm run dev:web`; build production menghilangkan jalur tersebut. Data demo `gr8r.v2` di localStorage tidak diimpor otomatis menjadi data tim atau akun.

## Arsitektur

Browser → `/api` pada origin yang sama → Express → PostgreSQL schema `app_private`.

Supabase digunakan **hanya sebagai PostgreSQL**. Tidak memakai Supabase Auth, SDK browser, anon key, service-role key, atau REST API Supabase. Kredensial database hanya ada pada proses backend. Jangan memasukkan kredensial ke variabel `VITE_*`.

Pada development, Vite mem-proxy `/api` ke port 3001. Pada production, `npm start` menjalankan API sekaligus menyajikan `dist/`. Hosting static saja (termasuk konfigurasi Vercel lama) tidak cukup untuk aplikasi ini.

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

Development memakai `MAIL_TRANSPORT=file`: email hanya ditulis ke `.local/mail/*.json`, **tidak dikirim ke penerima**. File tersebut memuat tautan sensitif; jangan dibagikan, dimasukkan Git, atau diunggah sebagai artefak CI. Aplikasi production menolak mode file. Backend membersihkan isi email yang sudah dikirim dari outbox database dan menghapus pesan outbox yang lebih dari tujuh hari.

## Menggunakan Supabase PostgreSQL

1. Buat/pilih project Supabase dan buka panel **Connect**. Gunakan direct connection jika host mendukung IPv6, atau **session pooler port 5432** jika membutuhkan IPv4. Hindari transaction pooler port 6543 untuk workflow ini, terutama migrasi dan pengaturan koneksi.
2. Masukkan `DATABASE_URL` pada secret manager hosting/backend. Untuk lokal, gunakan `.env.local` yang diabaikan Git. Tidak perlu mengaktifkan Supabase Auth atau memberikan API key.
3. Koneksi remote selalu menggunakan TLS dengan verifikasi sertifikat aktif. Jika diperlukan, unduh sertifikat CA database dari project Supabase dan set `DATABASE_CA_FILE` ke file tersebut. Jangan menggunakan `rejectUnauthorized=false` atau menonaktifkan TLS.
4. Jalankan `npm run db:migrate` dari koneksi yang berwenang membuat schema/tabel. Migrasi memakai transaksi, advisory lock, dan checksum; aman dijalankan ulang. Jangan mengubah file migrasi yang telah diterapkan: tambahkan migrasi baru.
5. Buat owner dengan CLI di atas, lalu konfigurasi SMTP sungguhan sebelum deployment production.

Schema `app_private` tidak boleh ditambahkan ke daftar exposed schemas Supabase. Migrasi mencabut akses schema dari PUBLIC dan role `anon`/`authenticated` bila tersedia. Migrasi pertama tidak mengubah tabel proyek Supabase lain. Gunakan database/project development terpisah dari production.

Untuk production, gunakan role migrasi pemilik schema dan role runtime terpisah yang hanya memiliki `USAGE` pada `app_private`, `SELECT/INSERT/UPDATE/DELETE` pada tabel aplikasi, serta `USAGE/SELECT` pada sequence yang diperlukan. Role runtime tidak perlu superuser, bypass RLS, kemampuan membuat role, atau DDL. Tetapkan default privileges dari role migrasi untuk tabel/sequence baru. Sesuaikan hostname/username session pooler dengan petunjuk Supabase untuk role pilihan Anda; jangan menebak username. Runtime tidak menjalankan migrasi otomatis.

Verifikasi koneksi Supabase belum dilakukan tanpa kredensial project. Tes yang tersedia menggunakan PostgreSQL lokal; ini membuktikan logika aplikasi, bukan akses/konfigurasi project Supabase tertentu.

## Autentikasi dan izin

- Password di-hash dengan scrypt (`N=65536`, `r=8`, `p=1`), salt acak per password. Maksimal 128 karakter; tidak ada password plaintext di database atau log.
- Sesi memakai token acak 256-bit; hanya hash token disimpan di database. Cookie `HttpOnly`, `SameSite=Lax`, dan `Secure` dengan prefix `__Host-` pada production. Durasi 12 jam atau 30 hari bila pengguna memilih "ingat saya"; tidak ada perpanjangan tanpa batas.
- Request yang mengubah data memerlukan origin persis `APP_ORIGIN`, JSON, dan untuk sesi login token CSRF. Tidak ada CORS lintas origin. Jangan mengaktifkan proxy trust tanpa batas; set `TRUST_PROXY_HOPS` sesuai jumlah proxy yang benar-benar Anda kelola.
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

Set `NODE_ENV=production`, `APP_ORIGIN=https://domain-anda`, `DATABASE_URL`, `MAIL_TRANSPORT=smtp`, `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, dan bila dibutuhkan `SMTP_USER`/`SMTP_PASSWORD`. `SMTP_SECURE=true` untuk TLS langsung (umumnya port 465); selain itu STARTTLS wajib. Verifikasi sertifikat tetap aktif. Konfigurasi SPF/DKIM/DMARC pada domain pengirim melalui penyedia email.

Outbox ditulis dalam transaksi yang sama dengan undangan/reset. Worker dalam proses backend mengirim antrean dan menjadwalkan ulang kegagalan dengan backoff. Multiple instance memakai `FOR UPDATE SKIP LOCKED`. Seperti umumnya sistem email, crash setelah SMTP menerima pesan tetapi sebelum commit dapat menyebabkan pengiriman ulang; token tetap hanya dapat digunakan sekali. Status terkirim berarti layanan SMTP menerima pesan, bukan bukti pesan sampai inbox. Pantau antrean dan kegagalan SMTP, serta siapkan alert sebelum penggunaan operasional.

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

Jika Chromium sudah tersedia, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` ke executable yang dipilih. Tests mencakup akses lintas-workspace, eskalasi role, CSRF, undangan ulang/kedaluwarsa/sekali pakai, perlindungan owner terakhir saat request bersamaan, reset dan pencabutan sesi, outbox, rendering, serta navigasi login/join/logout. CI menjalankan seluruh pemeriksaan dengan database disposable.

## Lisensi asal

Repository ini adalah fork dari `gr8rstudio/gr8r-studio`. Pada 3 November 2026, pengguna menyampaikan bahwa pembuat proyek mengonfirmasi lisensi **MIT** dan mengizinkan penggunaan kode. Keterangan ini dicatat sebagai konfirmasi yang diteruskan oleh pengguna; teks lisensi asli belum tersedia di checkout pada pemeriksaan awal.

Simpan teks lisensi MIT dan copyright notice asli dari pembuatnya saat tersedia, serta pertahankan atribusi upstream. Implementasi fondasi ini tidak mengarang tahun, pemegang hak cipta, atau mengganti pemberitahuan milik pembuat asal.

## Tahap selanjutnya

Hubungkan proyek/task/komentar melalui API berizin, tambahkan skema domain beserta migrasi data yang disetujui, pengelolaan file sungguhan, notifikasi, konflik edit, dan URL langsung ke objek. Jangan mengirim seluruh snapshot state browser ke database: backend harus memvalidasi operasi serta hak akses per objek.
