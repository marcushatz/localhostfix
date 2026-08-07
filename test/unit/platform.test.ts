import { describe, expect, test } from 'vitest';
import { parseProcNetTcp, parsePpidFromStat } from '../../src/platform/linux.js';
import { parseLsofFields, portFromSocketName } from '../../src/platform/posix.js';
import { setProcessInspector, unsupportedInspector } from '../../src/platform/index.js';
import { discoverServers } from '../../src/server/discovery.js';
import { nextAdapter } from '../../src/frameworks/adapter.js';

/**
 * Platform parsers are tested against captured real-world output so Linux
 * logic has meaningful coverage without a Linux host. This is why Linux is
 * documented as "Expected" rather than "Verified".
 */

describe('linux /proc/net/tcp parsing', () => {
  // Captured from a real Linux host: a listener on 3000 (0xBB8) and an
  // established connection that must be ignored.
  const SAMPLE = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 48291 1 0000000000000000 100 0 0 10 0
   1: 0100007F:C350 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 48312 1 0000000000000000 20 0 0 10 -1
   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 51002 1 0000000000000000 100 0 0 10 0`;

  test('returns only listening sockets, with decoded ports', () => {
    const result = parseProcNetTcp(SAMPLE);
    expect(result).toEqual([
      { port: 3000, inode: 48291 },
      { port: 8080, inode: 51002 },
    ]);
  });

  test('the established connection on the same port is excluded', () => {
    // State 01 is ESTABLISHED; only 0A (LISTEN) counts as a server.
    expect(parseProcNetTcp(SAMPLE).map((r) => r.inode)).not.toContain(48312);
  });

  test('empty and malformed tables do not throw', () => {
    expect(parseProcNetTcp('')).toEqual([]);
    expect(parseProcNetTcp('sl local_address\ngarbage')).toEqual([]);
  });
});

describe('linux /proc/<pid>/stat parsing', () => {
  test('reads ppid past a comm field containing spaces and parentheses', () => {
    // The comm field is untrusted text, which naive whitespace splitting
    // gets wrong — hence parsing from the last ')'.
    expect(parsePpidFromStat('1234 (next-server (v16)) S 987 1234 1234 0 -1 4194304')).toBe(987);
    expect(parsePpidFromStat('42 (node) S 1 42 42 0 -1 0')).toBe(1);
  });

  test('malformed input yields null rather than a wrong parent', () => {
    expect(parsePpidFromStat('nonsense')).toBeNull();
    expect(parsePpidFromStat('')).toBeNull();
  });
});

describe('lsof field parsing', () => {
  const SAMPLE = ['p101', 'cnode', 'n*:3000', 'p202', 'cPython', 'n127.0.0.1:4620', 'n[::1]:4621'].join(
    '\n',
  );

  test('associates each socket with the process that precedes it', () => {
    expect(parseLsofFields(SAMPLE)).toEqual([
      { pid: 101, command: 'node', name: '*:3000' },
      { pid: 202, command: 'Python', name: '127.0.0.1:4620' },
      { pid: 202, command: 'Python', name: '[::1]:4621' },
    ]);
  });

  test('extracts ports from every socket-name form', () => {
    expect(portFromSocketName('*:3000')).toBe(3000);
    expect(portFromSocketName('127.0.0.1:8080')).toBe(8080);
    expect(portFromSocketName('[::1]:5173')).toBe(5173);
    expect(portFromSocketName('no-port-here')).toBeNull();
  });
});

describe('a platform without process inspection', () => {
  test('reports ownership as unavailable instead of guessing', async () => {
    const restore = setProcessInspector(unsupportedInspector);
    try {
      const result = await discoverServers({
        projectRoot: '/tmp/some-project',
        adapter: nextAdapter,
        configuredPort: 3000,
      });
      expect(result.ownershipUnavailable).toBe(true);
      expect(result.projectServers).toEqual([]);
      // Critically: it must not claim a foreign server either. Unknown is
      // unknown — the honest answer in both directions.
      expect(result.foreignServers).toEqual([]);
    } finally {
      restore();
    }
  });
});
