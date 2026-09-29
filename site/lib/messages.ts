// Human messages for the `error` codes the backend and the site's own route handlers return.
// Checkout and wallet codes are mapped next to the checkout flow.

export type MessageContext = 'signin' | 'code' | 'verify' | 'alerts' | 'alert-delete' | 'export' | 'admin' | 'resolve' | 'signout';

const SOON = 'Subscriber sign-in opens soon. Today’s index stays free for everyone in the meantime.';
const RETRY = 'Something went wrong on our side. Please try again.';
const ALERT_INPUT = 'Choose above or below and enter a level from 0 to 100000, with at most one decimal place.';
const TRANSFER_REF = 'That transfer reference is not valid. Reload the page and try again.';

export const MESSAGES: Record<string, string> = {
  // Service and transport
  backend_unavailable: 'The service is not responding right now. Please try again in a minute.',
  accounts_disabled: 'Accounts are not available right now. Please try again later.',
  site_key_required: 'Accounts are not available right now. Please try again later.',
  temporarily_unavailable: 'The service is temporarily unavailable. Please try again in a minute.',
  internal_error: RETRY,
  invalid_response: RETRY,
  bad_request: 'The request could not be read. Reload the page and try again.',
  invalid_json: 'The request could not be read. Reload the page and try again.',
  json_required: 'The request could not be read. Reload the page and try again.',
  method_not_allowed: 'The request could not be read. Reload the page and try again.',
  payload_too_large: 'That is too much text. Please shorten it and try again.',
  forbidden: 'This request was blocked because it did not come from this site. Reload the page and try again.',
  rate_limit: 'Too many attempts. Please wait a few minutes and try again.',
  code_locked: 'Too many wrong codes for this email today. Use the sign-in link in the email instead, or try again tomorrow.',
  session_required: 'Your session has ended. Please sign in again.',
  not_found: 'That item was not found. Reload the page and try again.',
  // Sign-in
  invalid_email: 'Enter a valid email address.',
  mail_failed: 'We couldn’t send the email just now. Please try again in a few minutes.',
  mail_not_configured: SOON,
  signin_not_open: SOON,
  invalid_or_expired: 'This sign-in link has expired or was already used. Request a new one.',
  invalid_code: 'Enter the 6-digit code from the email.',
  missing_token: 'This sign-in link is incomplete. Open the link from the email again, or request a new one.',
  // Pro features
  subscription_required: 'Email alerts and the CSV export need an active Pro subscription.',
  valid_api_key_required: 'Please sign in again to download the CSV.',
  index_not_ready: 'The index has not been published yet, so there is nothing to export.',
  export_failed: 'The CSV could not be downloaded. Please try again.',
  too_many_alerts: 'You can have up to 5 alerts. Delete one to add another.',
  duplicate_alert: 'You already have an alert for that level and direction.',
  invalid_alert: ALERT_INPUT,
  invalid_direction: ALERT_INPUT,
  invalid_threshold: ALERT_INPUT,
  alert_not_found: 'That alert no longer exists.',
  invalid_id: 'That alert no longer exists. Reload the page.',
  // Admin
  invalid_days: 'Days must be a whole number from 1 to 400.',
  invalid_note: 'Add a note of 1 to 500 characters.',
  invalid_tx_hash: TRANSFER_REF,
  invalid_log_index: TRANSFER_REF,
  invalid_network: TRANSFER_REF,
  unmatched_not_found: 'That transfer was not found. Reload the page.',
  transfer_not_found: 'That transfer was not found. Reload the page.',
  already_resolved: 'That transfer is already resolved.',
};

const CONTEXT: Partial<Record<MessageContext, Record<string, string>>> = {
  code: { invalid_or_expired: 'That code is not valid or has expired. Check the latest email, or request a new code.' },
  'alert-delete': { not_found: 'That alert no longer exists.' },
  resolve: { not_found: 'That transfer was not found. Reload the page.' },
  export: { session_required: 'Please sign in again to download the CSV.' },
};

/** A message for any error code; unknown codes get a generic message that names the code for support. */
export function errorMessage(code: unknown, context?: MessageContext): string {
  const key = typeof code === 'string' ? code : '';
  const overrides = context ? CONTEXT[context] : undefined;
  if (overrides && Object.hasOwn(overrides, key)) return overrides[key];
  if (Object.hasOwn(MESSAGES, key)) return MESSAGES[key];
  return /^[a-z0-9_]{1,40}$/.test(key) ? `Something went wrong (${key}). Please try again.` : RETRY;
}
