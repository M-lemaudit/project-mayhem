/**
 * Winston logger: JSON in production (structured), simple text in development.
 * Minimal logging in hot loop; use for lifecycle events (Auth, Error, Win).
 */

import winston from 'winston';

const isProduction = process.env.NODE_ENV === 'production';

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const simpleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}: ${message}${metaStr}`;
  })
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
  format: isProduction ? jsonFormat : simpleFormat,
  transports: [new winston.transports.Console()],
});
