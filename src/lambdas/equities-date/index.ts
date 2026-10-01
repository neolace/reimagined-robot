import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'equities-date' });
export const TIME_ZONE = 'Africa/Johannesburg';

export interface DateEvent {
  /** Optional YYYYMMDD override for backfills. */
  businessDate?: string;
}

export interface DateResult {
  businessDate: string;
}

/** Calendar date of `now` in `timeZone`, formatted YYYYMMDD. */
export const toBusinessDate = (now: Date, timeZone = TIME_ZONE): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Missing ${type} in formatted date`);
    return part.value;
  };
  return `${get('year')}${get('month')}${get('day')}`;
};

export const handler = async (event: DateEvent | null = {}): Promise<DateResult> => {
  const override = event?.businessDate;
  if (override !== undefined) {
    if (!/^\d{8}$/.test(override)) throw new Error(`Invalid businessDate: ${override}`);
    logger.info('Using businessDate override', { businessDate: override });
    return { businessDate: override };
  }
  const businessDate = toBusinessDate(new Date());
  logger.info('Resolved businessDate', { businessDate });
  return { businessDate };
};
