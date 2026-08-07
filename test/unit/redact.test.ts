import { describe, expect, test } from 'vitest';
import { redactHeaders, redactUrl, REDACTED } from '../../src/security/redact.js';

describe('redactHeaders', () => {
  test('redacts authorization and cookie headers regardless of case', () => {
    const result = redactHeaders({
      Authorization: 'Bearer sk-live-abc123',
      COOKIE: 'session=deadbeef',
      'x-api-key': 'key-123',
      'content-type': 'application/json',
    });
    expect(result.Authorization).toBe(REDACTED);
    expect(result.COOKIE).toBe(REDACTED);
    expect(result['x-api-key']).toBe(REDACTED);
    expect(result['content-type']).toBe('application/json');
  });

  test('leaves benign headers untouched', () => {
    const headers = { accept: 'text/html', 'user-agent': 'agentview' };
    expect(redactHeaders(headers)).toEqual(headers);
  });
});

describe('redactUrl', () => {
  test('redacts sensitive query parameters', () => {
    const out = redactUrl('http://localhost:3000/api?token=secret123&page=2');
    expect(out).toContain(encodeURIComponent(REDACTED));
    expect(out).not.toContain('secret123');
    expect(out).toContain('page=2');
  });

  test('returns the original url when nothing is sensitive', () => {
    const url = 'http://localhost:3000/api/users?page=2';
    expect(redactUrl(url)).toBe(url);
  });

  test('does not throw on malformed urls', () => {
    expect(redactUrl('not a url')).toBe('not a url');
  });
});
