import { handler, toBusinessDate } from '../src/lambdas/equities-date';

describe('toBusinessDate', () => {
  test('uses SAST, not UTC, across midnight', () => {
    // 22:30 UTC on 30 Sep = 00:30 SAST on 1 Oct
    expect(toBusinessDate(new Date('2026-09-30T22:30:00Z'))).toBe('20261001');
  });

  test('same calendar day during the ingestion window', () => {
    expect(toBusinessDate(new Date('2026-10-01T01:00:00Z'))).toBe('20261001'); // 03:00 SAST
  });

  test('pads month and day', () => {
    expect(toBusinessDate(new Date('2026-01-05T10:00:00Z'))).toBe('20260105');
  });
});

describe('handler', () => {
  afterEach(() => jest.useRealTimers());

  test('returns the current SAST date', async () => {
    jest.useFakeTimers({ now: new Date('2026-12-31T22:15:00Z') });
    await expect(handler({})).resolves.toEqual({ businessDate: '20270101' });
  });

  test('handles a null payload', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-01T05:00:00Z') });
    await expect(handler(null)).resolves.toEqual({ businessDate: '20261001' });
  });

  test('honours a valid businessDate override', async () => {
    await expect(handler({ businessDate: '20260102' })).resolves.toEqual({ businessDate: '20260102' });
  });

  test('rejects a malformed override', async () => {
    await expect(handler({ businessDate: '2026-01-02' })).rejects.toThrow('Invalid businessDate');
  });
});
