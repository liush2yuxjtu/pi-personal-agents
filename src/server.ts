import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { buildOpenAISessionRoutes } from '../vendor/open-managed-agents/packages/openai-agents-api/src/sessions.ts';
import { Hono } from 'hono';
import { PiSessionsPort } from './session-port.js';

function equalSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface RunningServer { baseURL: string; apiKey: string; port: PiSessionsPort; close(): Promise<void> }

export async function startPersonalAgentServer(options: { hostname?: string; port?: number; apiKey?: string; dataDir?: string } = {}): Promise<RunningServer> {
  const hostname = options.hostname ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) throw new Error('Personal server is loopback-only');
  const apiKey = options.apiKey ?? randomBytes(32).toString('base64url');
  const sessions = new PiSessionsPort({ dataDir: resolve(options.dataDir ?? '.openma-pi-personal') });
  await sessions.initialize();
  const app = new Hono();
  app.get('/health', (context) => context.json({ ok: true, service: 'openma-pi-personal', model: 'openai-codex/gpt-5.6-luna' }));
  app.use('/openai/*', async (context, next) => {
    const authorization = context.req.header('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : context.req.header('x-api-key');
    if (!equalSecret(token, apiKey)) return context.json({ error: { message: 'Unauthorized', type: 'authentication_error', code: 'invalid_api_key', param: null } }, 401);
    await next();
  });
  app.route('/openai/v1/agents/sessions', buildOpenAISessionRoutes(sessions));
  const server = await new Promise<ServerType>((resolveServer, reject) => {
    const created = serve({ fetch: app.fetch, hostname, port: options.port ?? 0 }, (info) => resolveServer(created));
    created.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Could not resolve server address'); }
  return {
    baseURL: `http://${hostname}:${address.port}/openai/v1`, apiKey, port: sessions,
    async close() { await sessions.close(); await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); },
  };
}
