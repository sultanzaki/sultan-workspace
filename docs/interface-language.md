# Bahasa antarmuka

English adalah bahasa dasar antarmuka, halaman login/setup/reset password, pesan API, dan email baru. Pilihan **Settings → Language → English** menampilkan copy English; pilihan **Bahasa Indonesia** memakai katalog di `src/core/messages.js`.

Terjemahan antarmuka mencakup workspace, dialog, label aksesibilitas, tooltip, dan toast. Pesan sistem notifikasi lama yang sudah tersimpan dalam bahasa Indonesia dinormalisasi saat ditampilkan. Nama workspace/proyek/task, profil, komentar, isi file, dan input pengguna dipertahankan.

Tambahkan copy baru dalam English di komponen atau server. Terjemahan Indonesian ditempatkan dalam katalog dan diproses melalui `translate` di `src/core/locale.js`. Jangan menaruh copy Indonesian langsung di komponen English atau menerjemahkan isi record pengguna.

Baris tindakan permanen di atas workspace dihapus. Pengaturan tetap tersedia dari **Settings** di sidebar; keluar akun melalui **Account menu → Sign out**. Area sinkronisasi tidak terlihat saat bersih dan tetap menyediakan pesan kegagalan, retry, serta cadangan draft ketika diperlukan.

Tidak ada migrasi atau environment variable tambahan. Pengujian browser memeriksa login dan pengaturan dalam English, perpindahan bahasa dan reload, konten proyek berbahasa Indonesia yang tetap utuh, pemulihan kegagalan simpan, serta akses pengaturan dan keluar akun melalui menu.
