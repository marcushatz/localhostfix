import { describe, expect, test } from 'vitest';
import {
  VERDICTS,
  VERDICT_LAYER,
  verdictDomain,
  verdictExitCode,
} from '../../src/diagnose/verdict.js';

describe('verdict model', () => {
  test('every verdict maps to a layer', () => {
    for (const v of VERDICTS) {
      expect(VERDICT_LAYER[v], `missing layer for ${v}`).toBeTruthy();
    }
  });

  test('setup failures and application failures are distinguished', () => {
    expect(verdictDomain('BROWSER_NOT_INSTALLED')).toBe('setup');
    expect(verdictDomain('SERVER_START_FAILED')).toBe('setup');
    expect(verdictDomain('SERVER_PORT_CONFLICT')).toBe('setup');
    expect(verdictDomain('APPLICATION_RUNTIME_FAILURE')).toBe('application');
    expect(verdictDomain('LIKELY_BLANK_RENDER')).toBe('application');
    expect(verdictDomain('HEALTHY_RENDER')).toBe('healthy');
    expect(verdictDomain('INDETERMINATE')).toBe('unknown');
  });

  test('exit codes follow the documented contract', () => {
    expect(verdictExitCode('HEALTHY_RENDER')).toBe(0);
    expect(verdictExitCode('APPLICATION_RUNTIME_FAILURE')).toBe(1);
    expect(verdictExitCode('BROWSER_NOT_INSTALLED')).toBe(2);
    expect(verdictExitCode('INDETERMINATE')).toBe(3);
  });

  test('only HEALTHY_RENDER exits zero', () => {
    const zero = VERDICTS.filter((v) => verdictExitCode(v) === 0);
    expect(zero).toEqual(['HEALTHY_RENDER']);
  });
});
