import { randomBytes } from 'node:crypto';

export function uuidV7(now: Date = new Date()): string {
  const unixMs = now.getTime();
  if (!Number.isInteger(unixMs) || unixMs < 0) {
    throw new Error('UUID time is invalid.');
  }
  const bytes = randomBytes(16);
  const timestamp = BigInt(unixMs);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  const timeHigh = bytes[6] ?? 0;
  const clock = bytes[8] ?? 0;
  bytes[6] = (timeHigh & 0x0f) | 0x70;
  bytes[8] = (clock & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
