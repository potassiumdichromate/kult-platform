import { FastifyInstance, FastifyRequest } from 'fastify';
import { WebSocket } from 'ws';
import Redis from 'ioredis';
import { winstonLogger } from '../middleware/logger';

export type Channel =
  | 'match-updates'
  | 'leaderboard'
  | 'agent-events'
  | 'tournament';

const ALL_CHANNELS: Channel[] = [
  'match-updates',
  'leaderboard',
  'agent-events',
  'tournament',
];

interface ClientMessage {
  type: 'subscribe' | 'unsubscribe' | 'ping';
  channel?: Channel;
  payload?: unknown;
}

interface ServerMessage {
  type: 'welcome' | 'subscribed' | 'unsubscribed' | 'event' | 'pong' | 'error';
  channel?: Channel;
  payload?: unknown;
  timestamp: number;
}

interface ConnectedClient {
  socket: WebSocket;
  wallet: string | null;
  subscriptions: Set<Channel>;
  lastPing: number;
}

const clients = new Map<string, ConnectedClient>();

function sendMessage(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(channel: Channel, payload: unknown): void {
  const message: ServerMessage = {
    type: 'event',
    channel,
    payload,
    timestamp: Date.now(),
  };

  for (const [, client] of clients) {
    if (client.subscriptions.has(channel)) {
      sendMessage(client.socket, message);
    }
  }
}

let heartbeatInterval: NodeJS.Timeout | null = null;

function startHeartbeat(): void {
  const intervalMs = parseInt(
    process.env.WS_HEARTBEAT_INTERVAL_MS || '30000',
    10
  );

  heartbeatInterval = setInterval(() => {
    const now = Date.now();
    const staleThreshold = intervalMs * 2;

    for (const [clientId, client] of clients) {
      if (now - client.lastPing > staleThreshold) {
        winstonLogger.warn('WebSocket client timed out, disconnecting', {
          clientId,
        });
        client.socket.terminate();
        clients.delete(clientId);
        continue;
      }

      sendMessage(client.socket, {
        type: 'pong',
        payload: { serverTime: now },
        timestamp: now,
      });
    }
  }, intervalMs);
}

export async function setupWebSocketHandler(
  fastify: FastifyInstance,
  redis: Redis
): Promise<void> {
  // Redis subscriber for pub/sub
  const subscriber = redis.duplicate();

  // Subscribe to all channels
  await subscriber.subscribe(...ALL_CHANNELS);

  subscriber.on('message', (channel: string, message: string) => {
    if (ALL_CHANNELS.includes(channel as Channel)) {
      try {
        const payload = JSON.parse(message);
        broadcast(channel as Channel, payload);
      } catch (err) {
        winstonLogger.error('Failed to parse Redis pub/sub message', {
          channel,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
  });

  startHeartbeat();

  fastify.get(
    '/ws',
    { websocket: true },
    async (socket: WebSocket, request: FastifyRequest) => {
      const clientId = `${request.ip}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;

      let wallet: string | null = null;

      // Attempt to authenticate via query param token
      const url = new URL(
        request.url,
        `http://${request.headers.host || 'localhost'}`
      );
      const token = url.searchParams.get('token');

      if (token) {
        try {
          const payload = await (fastify as any).jwt.verify(token) as {
            wallet: string;
          };
          wallet = payload.wallet;
        } catch {
          // Anonymous connection allowed; some channels may be restricted
        }
      }

      const client: ConnectedClient = {
        socket,
        wallet,
        subscriptions: new Set(),
        lastPing: Date.now(),
      };

      clients.set(clientId, client);

      winstonLogger.info('WebSocket client connected', {
        clientId,
        wallet,
        totalClients: clients.size,
      });

      sendMessage(socket, {
        type: 'welcome',
        payload: {
          clientId,
          wallet,
          availableChannels: ALL_CHANNELS,
          authenticated: wallet !== null,
        },
        timestamp: Date.now(),
      });

      socket.on('message', (raw: Buffer | string) => {
        client.lastPing = Date.now();

        let parsed: ClientMessage;
        try {
          parsed = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
          sendMessage(socket, {
            type: 'error',
            payload: { message: 'Invalid JSON message' },
            timestamp: Date.now(),
          });
          return;
        }

        switch (parsed.type) {
          case 'ping': {
            sendMessage(socket, {
              type: 'pong',
              payload: { serverTime: Date.now() },
              timestamp: Date.now(),
            });
            break;
          }

          case 'subscribe': {
            if (!parsed.channel || !ALL_CHANNELS.includes(parsed.channel)) {
              sendMessage(socket, {
                type: 'error',
                payload: {
                  message: `Unknown channel: ${parsed.channel}. Valid channels: ${ALL_CHANNELS.join(', ')}`,
                },
                timestamp: Date.now(),
              });
              return;
            }

            // Certain channels require authentication
            const authRequired: Channel[] = ['agent-events'];
            if (authRequired.includes(parsed.channel) && !wallet) {
              sendMessage(socket, {
                type: 'error',
                payload: {
                  message: `Channel '${parsed.channel}' requires authentication. Connect with a valid JWT token.`,
                },
                timestamp: Date.now(),
              });
              return;
            }

            client.subscriptions.add(parsed.channel);
            sendMessage(socket, {
              type: 'subscribed',
              channel: parsed.channel,
              payload: { channel: parsed.channel },
              timestamp: Date.now(),
            });

            winstonLogger.info('Client subscribed to channel', {
              clientId,
              channel: parsed.channel,
            });
            break;
          }

          case 'unsubscribe': {
            if (parsed.channel && client.subscriptions.has(parsed.channel)) {
              client.subscriptions.delete(parsed.channel);
              sendMessage(socket, {
                type: 'unsubscribed',
                channel: parsed.channel,
                payload: { channel: parsed.channel },
                timestamp: Date.now(),
              });
            }
            break;
          }

          default: {
            sendMessage(socket, {
              type: 'error',
              payload: { message: `Unknown message type: ${parsed.type}` },
              timestamp: Date.now(),
            });
          }
        }
      });

      socket.on('close', () => {
        clients.delete(clientId);
        winstonLogger.info('WebSocket client disconnected', {
          clientId,
          wallet,
          totalClients: clients.size,
        });
      });

      socket.on('error', (err) => {
        winstonLogger.error('WebSocket client error', {
          clientId,
          error: err.message,
        });
        clients.delete(clientId);
      });
    }
  );
}

export async function publishToChannel(
  redis: Redis,
  channel: Channel,
  payload: unknown
): Promise<void> {
  await redis.publish(channel, JSON.stringify(payload));
}

export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

export function getConnectedClientCount(): number {
  return clients.size;
}
