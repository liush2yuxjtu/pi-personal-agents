import OpenAI from 'openai';
import { parsePullRequestUrl } from './github-pr.js';
import { startPersonalAgentServer } from './server.js';
import { PERSONAL_MODEL_ID } from './session-port.js';
import { normalizeTriageReport, parseTriageSummary, PR_REVIEW_INSTRUCTIONS } from './triage.js';

const value = process.argv.slice(2).find((argument) => argument.startsWith('https://'));
if (!value) throw new Error('Usage: pnpm pr-review https://github.com/OWNER/REPO/pull/NUMBER');
const target = parsePullRequestUrl(value);
const server = await startPersonalAgentServer();
try {
  const client = new OpenAI({ apiKey: server.apiKey, baseURL: server.baseURL, maxRetries: 0 });
  const stream = await client.beta.agents.sessions.create({
    agent: { model: PERSONAL_MODEL_ID, instructions: PR_REVIEW_INSTRUCTIONS },
    environment: { type: 'none' }, metadata: { mode: 'pr-review' }, input: target.url, stream: true,
  });
  let report = '';
  for await (const event of stream) {
    if (event.type === 'agent.session.turn.output_text.delta') report += event.delta;
    if (event.type === 'agent.session.turn.output_text.done') report = event.text;
    if (event.type === 'agent.session.turn.failed') throw new Error(event.turn.error?.message ?? 'Review failed');
  }
  report = normalizeTriageReport(report);
  const triage = parseTriageSummary(report);
  process.stdout.write(`${report}\n\nTriage: ${triage.verdict} · P0 ${triage.p0} · P1 ${triage.p1} · P2 ${triage.p2}\n`);
} finally { await server.close(); }
