import { formatAbsoluteDate, formatDate } from '../formatDate';

describe('formatDate timezone and daylight-saving boundaries', () => {
  it.each([
    {
      timezone: 'America/New_York',
      now: '2025-03-09T07:30:00.000Z',
      date: '2025-03-09T06:30:00.000Z',
    },
    {
      timezone: 'America/New_York',
      now: '2025-11-02T06:30:00.000Z',
      date: '2025-11-02T05:30:00.000Z',
    },
    {
      timezone: 'Europe/Berlin',
      now: '2025-03-30T01:30:00.000Z',
      date: '2025-03-30T00:30:00.000Z',
    },
  ])(
    'uses elapsed instants across the DST transition in $timezone',
    ({ now, date }) => {
      expect(
        formatDate(new Date(date), { now: new Date(now) }),
      ).toMatch(/^1\s+(?:h|hr\.?|hour)\s+ago$/i);
    },
  );

  it('formats absolute dates in an explicit timezone independent of the host', () => {
    const date = new Date('2025-03-01T00:30:00.000Z');
    expect(formatAbsoluteDate(date, { locale: 'en-US', timeZone: 'UTC' })).toContain(
      'Mar 1',
    );
    expect(
      formatAbsoluteDate(date, {
        locale: 'en-US',
        timeZone: 'America/Los_Angeles',
      }),
    ).toContain('Feb 28');
  });
});