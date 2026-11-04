export const EMAIL_DEFAULTS = { email_mention: true, email_assign: true, email_comment: false, email_status: false, email_due: true, email_digest: false };
export const emailPreference = (preferences, key) => preferences?.notifPrefs?.[key] ?? EMAIL_DEFAULTS[key] ?? false;
