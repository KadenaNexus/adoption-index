import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES, errorMessage } from '../lib/messages.ts';

// Every code the account, sign-in, alert, export and admin routes can return (backend and site-side).
const CODES = [
  'backend_unavailable', 'accounts_disabled', 'site_key_required', 'temporarily_unavailable', 'internal_error', 'invalid_response', 'bad_request', 'invalid_json',
  'json_required', 'method_not_allowed', 'payload_too_large', 'forbidden', 'rate_limit', 'code_locked', 'session_required', 'not_found',
  'invalid_email', 'mail_failed', 'mail_not_configured', 'signin_not_open', 'invalid_or_expired', 'invalid_code', 'missing_token',
  'subscription_required', 'valid_api_key_required', 'index_not_ready', 'export_failed', 'too_many_alerts', 'duplicate_alert', 'invalid_alert', 'invalid_direction',
  'invalid_threshold', 'alert_not_found', 'invalid_id', 'invalid_days', 'invalid_note', 'invalid_tx_hash', 'invalid_log_index', 'invalid_network',
  'unmatched_not_found', 'transfer_not_found', 'already_resolved', 'invalid_indicator', 'invalid_description', 'invalid_evidence', 'reports_busy',
];

test('every known error code has its own human message', () => {
  for (const code of CODES) {
    assert.ok(Object.hasOwn(MESSAGES, code), code);
    const message = errorMessage(code);
    assert.ok(message.length > 10 && !message.includes(code) && !/Something went wrong \(/.test(message), `${code}: ${message}`);
    assert.match(message, /[.!]$/, `${code} reads as a sentence`);
  }
  assert.deepEqual(Object.keys(MESSAGES).sort(), [...CODES].sort(), 'the list above covers every mapped code');
});

test('sign-in messages say what to do next', () => {
  assert.match(errorMessage('signin_not_open', 'signin'), /^Subscriber sign-in opens soon/);
  assert.equal(errorMessage('mail_not_configured', 'signin'), errorMessage('signin_not_open', 'signin'));
  assert.match(errorMessage('rate_limit'), /wait a few minutes/);
  assert.match(errorMessage('mail_failed'), /couldn’t send the email/);
  assert.match(errorMessage('invalid_or_expired', 'verify'), /Request a new one/);
  assert.match(errorMessage('invalid_or_expired', 'code'), /code is not valid/);
  assert.match(errorMessage('too_many_alerts', 'alerts'), /up to 5 alerts/);
  assert.match(errorMessage('not_found', 'alert-delete'), /alert no longer exists/);
  assert.match(errorMessage('session_required', 'export'), /download the CSV/);
});

test('unknown codes get a generic message naming a plain code only', () => {
  assert.equal(errorMessage('brand_new_code'), 'Something went wrong (brand_new_code). Please try again.');
  for (const odd of ['<img src=x>', 'a'.repeat(80), '', null, undefined, 42, { error: 'x' }, 'constructor', 'toString', '__proto__'])
    assert.ok(!/[<>]/.test(errorMessage(odd)) && errorMessage(odd).length < 120, String(odd));
  assert.equal(errorMessage('constructor'), 'Something went wrong (constructor). Please try again.', 'prototype names are not messages');
  assert.equal(errorMessage('toString'), 'Something went wrong on our side. Please try again.');
  for (const context of ['signin', 'code', 'verify', 'alerts', 'alert-delete', 'export', 'admin', 'resolve', 'signout', 'report', 'report-resolve'])
    for (const name of ['constructor', '__proto__', 'hasOwnProperty']) assert.equal(typeof errorMessage(name, context), 'string', `${context}/${name}`);
});

test('report messages say how to fix the field or when to try again', () => {
  assert.match(errorMessage('invalid_description', 'report'), /10 to 2,000 characters/);
  assert.match(errorMessage('invalid_evidence', 'report'), /supporting link or transaction ID/);
  assert.match(errorMessage('invalid_email', 'report'), /or leave it blank/);
  assert.match(errorMessage('rate_limit', 'report'), /up to 5 reports an hour and 10 a day/);
  assert.match(errorMessage('reports_busy', 'report'), /in the last 24 hours, so the form is paused/);
  assert.doesNotMatch(errorMessage('accounts_disabled', 'report'), /Accounts/, 'a report is not about an account');
  assert.match(errorMessage('not_found', 'report-resolve'), /report was not found/);
  assert.match(errorMessage('already_resolved', 'report-resolve'), /report is already resolved/);
  assert.match(errorMessage('already_resolved', 'resolve'), /transfer is already resolved/);
});
