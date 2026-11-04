import { readApiResponse } from '../foundation/http.js';
export async function nativeApi(session, path, method = 'GET', body) {
  if (method !== 'GET') body ??= {};
  try {
    return await readApiResponse(
      await fetch('/api' + path, {
        method,
        credentials: 'same-origin',
        headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Koneksi terputus. Perubahan belum dikonfirmasi. Coba lagi.');
    throw error;
  }
}
export function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const fileBase64 = file =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('File gagal dibaca.'));
    reader.readAsDataURL(file);
  });
