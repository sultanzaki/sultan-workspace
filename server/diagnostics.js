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
  let message = 'The account service is not ready. Check the database and deployment configuration.';
  if (['42P01', '3F000'].includes(code)) message = 'The database is not ready. An administrator must run the Supabase migrations first.';
  else if (['ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'DATABASE_TIMEOUT'].includes(code))
    message = 'The server cannot reach the database. Check the Supabase session pooler connection on port 5432 in DATABASE_URL.';
  else if (['28P01', '28000'].includes(code)) message = 'Database connection rejected. Check the database username and password in DATABASE_URL.';
  else if (['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code))
    message = 'The database certificate is not trusted. Configure the Supabase CA certificate in DATABASE_CA_PEM.';
  else if (code === 'ENOTFOUND') message = 'Database server not found. Check the hostname in DATABASE_URL.';
  else if (code.startsWith('APP_ORIGIN')) message = 'Set APP_ORIGIN to https://sultan-workspace.vercel.app without a trailing slash.';
  else if (code === 'RESEND_KEY_REQUIRED') message = 'Configure RESEND_API_KEY in Vercel to enable Resend email delivery.';
  else if (code === 'MAIL_FROM_REQUIRED') message = 'Configure MAIL_FROM with an address on your verified Resend domain.';
  else if (code === 'SMTP_HOST_REQUIRED') message = 'Configure SMTP_HOST or use the Resend API for email delivery.';
  else if (code === 'CONFIG_INVALID') message = 'Server configuration is incomplete or invalid. Check the configuration fields listed in the logs.';
  // Only controlled categories and field names are returned/logged, never raw errors.
  const fields = Array.isArray(error.configFields) ? error.configFields.filter(field => typeof field === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(field)) : [];
  return { code, stage, fields, message };
}
