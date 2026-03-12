import { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';

export const winstonLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'gateway-service' },
  transports: [
    new winston.transports.Console({
      format:
        process.env.NODE_ENV === 'development'
          ? winston.format.combine(
              winston.format.colorize(),
              winston.format.simple()
            )
          : winston.format.json(),
    }),
  ],
});

export function requestLogger(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
  const requestId = (request.headers['x-request-id'] as string) || uuidv4();
  request.headers['x-request-id'] = requestId;
  reply.header('x-request-id', requestId);

  const startTime = Date.now();

  winstonLogger.info('Incoming request', {
    requestId,
    method: request.method,
    url: request.url,
    ip: request.ip,
    userAgent: request.headers['user-agent'],
  });

  reply.addHook('onSend', (_req, _rep, payload, next) => {
    const duration = Date.now() - startTime;
    winstonLogger.info('Request completed', {
      requestId,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      duration,
    });
    next(null, payload);
  });

  done();
}
