export async function readApiResponse(response) {
  if (response.status === 204) return null;
  const unavailable = () => {
    const error = new Error('The account service is unavailable. An administrator needs to check the server configuration.');
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
    const error = new Error(typeof data?.error === 'string' ? data.error : 'Request failed. Try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}
