# Sultan Workspace

Brand aplikasi memakai nama **Sultan Workspace** dan monogram S berwarna indigo. Identitas ini diterapkan pada judul/metadata browser, favicon, ikon homescreen, tampilan login dan pemulihan akun, logo demo, email baru, label setup authenticator baru, serta nama file recovery codes.

`public/favicon.svg` adalah sumber ikon. Versi PNG tersedia dalam ukuran 180, 192, dan 512 piksel; `public/site.webmanifest` menyediakan metadata homescreen. URL favicon pada halaman memakai penanda versi untuk memperbarui cache ikon lama.

Login desktop memakai panel pengantar dan kartu formulir; pada ponsel formulir menjadi satu kolom. Formulir tetap memakai autentikasi native, undangan, reset password, dan 2FA yang sudah ada. Screenshot desktop/mobile dihasilkan oleh tes browser di `test-results/sultan-login-*.png` sebelum kredensial diisi.

Nama workspace dan isi record pengguna tetap mengikuti data yang tersimpan. Kunci penyimpanan browser lama dipertahankan agar draft lokal tetap terbaca. Label pada authenticator yang sudah terdaftar dikelola melalui aplikasi authenticator pengguna; secret/kode yang ada tetap berlaku.

Email baru memakai display name Sultan Workspace dengan alamat MAIL_FROM yang telah dikonfigurasi. Envelope pesan yang sudah dibekukan tetap dipertahankan untuk keamanan retry/idempotensi. Lisensi dan atribusi proyek asal dipertahankan.

Perubahan ini tidak membutuhkan migrasi atau environment variable baru.

## Preview

[Desktop](branding/login-desktop.png) · [Mobile](branding/login-mobile.png)
