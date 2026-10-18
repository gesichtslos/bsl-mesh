export function redactDatabaseUrl(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-database-url]');
}
