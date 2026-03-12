import winston from 'winston';

const { combine, timestamp, json, colorize, simple } = winston.format;

const isDev = process.env['NODE_ENV'] !== 'production';

export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: isDev
    ? combine(colorize(), simple())
    : combine(timestamp(), json()),
  defaultMeta: { service: 'wallet-service' },
  transports: [
    new winston.transports.Console({
      handleExceptions: true,
      handleRejections: true,
    }),
  ],
  exitOnError: false,
});
