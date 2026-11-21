import { formatDate, formatRelativeTime, formatAbsoluteDate } from '@/app/lib/utils/formatDate';

describe('formatDate utility and formatters', () => {
  it('formats recent timestamps as relative time', () => {
    const now = new Date('2026-10-18T12:00:00.000Z');
    const recent = new Date('2026-10-18T11:59:30.000Z');
    expect(formatDate(recent, { now })).toBe('just now');
  });

  it('formats dates safely when null or undefined are passed', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
  });

  it('formats absolute dates accurately', () => {
    const date = new Date('2026-10-18T12:00:00Z');
    expect(formatAbsoluteDate(date, { locale: 'en-US', timeZone: 'UTC' })).toContain('Oct 18, 2026');
  });
});
