export function initializationDiagnostic(error) {
  const stage = error.setupStage || 'initialization';
  const found = [error, error.cause, ...(Array.isArray(error.errors) ? error.errors : [])].filter(Boolean);
  const known = found.find(item => typeof item.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(item.code));
  let code = known?.code;
  if (!code) {
    if (stage === 'configuration') code = 'CONFIGURATION_ERROR';
    else if (stage === 'database' && found.some(item => /timeout|timed out/i.test(item.message || ''))) code = 'DATABASE_TIMEOUT';
    else if (stage === 'database') code = 'DATABASE_CONNECTION_ERROR';
    else if (stage === 'pool') code = 'DATABASE_POOL_ERROR';
    else code = 'API_INITIALIZATION_ERROR';
  }
  let message = 'Layanan akun belum siap. Admin perlu memeriksa konfigurasi database dan deployment.';
  if (['42P01', '3F000'].includes(code)) message = 'Database belum disiapkan. Admin perlu menjalankan migrasi Supabase terlebih dahulu.';
  else if (['ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'DATABASE_TIMEOUT'].includes(code))
    message = 'Server belum dapat menjangkau database. Periksa koneksi Session pooler Supabase port 5432 pada DATABASE_URL.';
  else if (['28P01', '28000'].includes(code)) message = 'Koneksi database ditolak. Admin perlu memeriksa username dan password database pada DATABASE_URL.';
  else if (['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code))
    message = 'Sertifikat koneksi database belum dikenali. Admin perlu memasang sertifikat CA Supabase melalui DATABASE_CA_PEM.';
  else if (code === 'ENOTFOUND') message = 'Alamat server database tidak ditemukan. Periksa hostname pada DATABASE_URL.';
  else if (code.startsWith('APP_ORIGIN'))
    message = 'Alamat website belum dikonfigurasi dengan benar. Isi APP_ORIGIN dengan https://sultan-workspace.vercel.app tanpa slash terakhir.';
  else if (code === 'RESEND_KEY_REQUIRED') message = 'Email Resend belum lengkap. Admin perlu mengisi RESEND_API_KEY pada Vercel.';
  else if (code === 'MAIL_FROM_REQUIRED')
    message = 'Alamat pengirim email belum diatur. Isi MAIL_FROM dengan alamat pada domain yang sudah diverifikasi di Resend.';
  else if (code === 'SMTP_HOST_REQUIRED') message = 'Pengiriman SMTP belum lengkap. Periksa SMTP_HOST atau gunakan konfigurasi Resend API.';
  else if (code === 'CONFIG_INVALID') message = 'Konfigurasi server belum lengkap atau tidak valid. Admin perlu memeriksa nama isian yang tercantum pada log.';
  // Only controlled categories and field names are returned/logged, never raw errors.
  const fields = Array.isArray(error.configFields) ? error.configFields.filter(field => typeof field === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(field)) : [];
  return { code, stage, fields, message };
}
