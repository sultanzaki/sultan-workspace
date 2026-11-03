export async function readApiResponse(response) {
  if (response.status === 204) return null;
  const unavailable = () => {
    const error = new Error('Layanan akun belum tersedia. Konfigurasi server perlu diperiksa oleh admin.');
    error.status = 503;
    return error;
  };
  // Platforms may return a plain-text 404, HTML error page, or interrupted JSON.
  // Never display their raw response (which can include internal diagnostics).
  if (!/\bapplication\/(?:[a-z0-9.-]+\+)?json\b/i.test(response.headers.get('content-type') || '')) throw unavailable();
  let data;
  try {
    data = await response.json();
  } catch {
    throw unavailable();
  }
  if (!response.ok) {
    const error = new Error(typeof data?.error === 'string' ? data.error : 'Permintaan gagal. Coba lagi.');
    error.status = response.status;
    throw error;
  }
  return data;
}
