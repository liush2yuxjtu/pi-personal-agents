import { startPersonalAgentServer } from './server.js';

const server = await startPersonalAgentServer({ port: Number(process.env.PORT ?? 8788), apiKey: process.env.OPENMA_PERSONAL_API_KEY });
console.log(JSON.stringify({ ready: true, baseURL: server.baseURL, model: 'openai-codex/gpt-5.6-luna', apiKeySource: process.env.OPENMA_PERSONAL_API_KEY ? 'environment' : 'ephemeral' }));
const stop = async () => { await server.close(); process.exit(0); };
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
