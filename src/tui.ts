import { resolve } from 'node:path';
import OpenAI from 'openai';
import { Container, Input, matchesKey, ProcessTerminal, Spacer, Text, TuiMainScreen, type TUI } from '@earendil-works/pi-tui';
import { startPersonalAgentServer } from './server.js';
import { PERSONAL_MODEL_ID } from './session-port.js';
import { buildStyledInstructions, isOutputStyle, loadPreferences, OUTPUT_STYLES, savePreferences, validateLanguage } from './preferences.js';
import { PR_REVIEW_INSTRUCTIONS } from './triage.js';

const color = { cyan: (s: string) => `\x1b[36m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m` };
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }

const preferencesPath = resolve('.openma-pi-personal/preferences.json');
let preferences = await loadPreferences(preferencesPath);
const server = await startPersonalAgentServer();
const client = new OpenAI({ apiKey: server.apiKey, baseURL: server.baseURL, maxRetries: 0 });
const terminal = new ProcessTerminal();
const tui: TUI = new TuiMainScreen(terminal);
const transcript = new Container();
const status = new Text('', 1, 0);
const input = new Input();
let sessionId: string | null = null;
let active = false;
let activeTurn: string | null = null;
const seen = new Set<string>();

function line(role: string, text: string): void { transcript.addChild(new Text(`${role.padEnd(9)} ${text}`, 1, 0)); tui.requestRender(); }
function setStatus(text: string, error = false): void { status.setText(error ? color.red(text) : color.dim(text)); tui.requestRender(); }
async function consume(stream: AsyncIterable<unknown>): Promise<void> {
  let final = '';
  for await (const raw of stream) {
    if (!object(raw) || typeof raw.type !== 'string') continue;
    const eventId = typeof raw.event_id === 'string' ? raw.event_id : undefined;
    if (eventId && seen.has(eventId)) continue;
    if (eventId) seen.add(eventId);
    if (raw.type === 'agent.session.created' && object(raw.session) && typeof raw.session.id === 'string') sessionId = raw.session.id;
    if (raw.type === 'agent.session.turn.created' && object(raw.turn) && typeof raw.turn.id === 'string') activeTurn = raw.turn.id;
    if (raw.type === 'agent.session.turn.output_text.delta' && typeof raw.delta === 'string') final += raw.delta;
    if (raw.type === 'agent.session.turn.output_text.done' && typeof raw.text === 'string') final = raw.text;
    if (raw.type === 'agent.session.turn.failed') throw new Error(object(raw.turn) && object(raw.turn.error) ? String(raw.turn.error.message ?? 'Turn failed') : 'Turn failed');
    if (raw.type === 'agent.session.idle') break;
  }
  if (final) line('assistant', final);
}
async function start(message: string, mode: 'chat' | 'pr-review'): Promise<void> {
  active = true; setStatus(`${mode === 'pr-review' ? 'Reviewing' : 'Thinking'} · ${PERSONAL_MODEL_ID}`);
  try {
    if (mode === 'pr-review' || !sessionId) {
      const stream = await client.beta.agents.sessions.create({
        agent: { model: PERSONAL_MODEL_ID, instructions: buildStyledInstructions(
          mode === 'pr-review' ? PR_REVIEW_INSTRUCTIONS : 'You are a personal engineering assistant.',
          preferences,
        ) },
        environment: { type: 'none' }, input: message, metadata: { mode }, stream: true,
      });
      line('you', mode === 'pr-review' ? `Review ${message}` : message);
      await consume(stream);
    } else {
      line('you', message);
      await client.beta.agents.sessions.events.create(sessionId, { events: [{ type: 'agent.session.input.message', input: [{ role: 'user', content: [{ type: 'input_text', text: message }] }] }] });
      await consume(await client.beta.agents.sessions.events.stream(sessionId));
    }
    setStatus(`idle · ${sessionId ?? 'no session'} · ${preferences.language} · ${preferences.outputStyle} · ${PERSONAL_MODEL_ID}`);
  } catch (error) { line('error', error instanceof Error ? error.message : String(error)); setStatus('failed', true); }
  finally { active = false; activeTurn = null; input.setValue(''); tui.setFocus(input); tui.requestRender(); }
}
async function submit(value: string): Promise<void> {
  const text = value.trim(); if (!text || active) return;
  if (text === '/quit' || text === '/q') return shutdown();
  if (text === '/new') { sessionId = null; seen.clear(); line('system', 'Started a new conversation.'); setStatus(`new · ${PERSONAL_MODEL_ID}`); input.setValue(''); return; }
  if (text === '/sessions') { const page = await client.beta.agents.sessions.list({ order: 'desc', limit: 10 }); line('system', page.data.map((item) => `${item.id} ${item.status}`).join(' · ') || 'No sessions'); input.setValue(''); return; }
  if (text === '/config') { line('system', `language=${preferences.language} · output-style=${preferences.outputStyle}`); input.setValue(''); return; }
  if (text === '/output-style') { line('system', `Output styles: ${OUTPUT_STYLES.join(', ')} · current=${preferences.outputStyle}`); input.setValue(''); return; }
  if (text.startsWith('/output-style ')) {
    const style = text.slice(14).trim().toLowerCase();
    if (!isOutputStyle(style)) { line('error', `Unknown style. Choose: ${OUTPUT_STYLES.join(', ')}`); input.setValue(''); return; }
    preferences = { ...preferences, outputStyle: style }; await savePreferences(preferencesPath, preferences); sessionId = null; seen.clear();
    line('system', `Output style=${style}. Started a new session so the system prompt changes cleanly.`); setStatus(`new · ${preferences.language} · ${style}`); input.setValue(''); return;
  }
  if (text === '/language') { line('system', `Language: ${preferences.language}`); input.setValue(''); return; }
  if (text.startsWith('/language ')) {
    try { preferences = { ...preferences, language: validateLanguage(text.slice(10)) }; await savePreferences(preferencesPath, preferences); sessionId = null; seen.clear(); line('system', `Language=${preferences.language}. Started a new session so the system prompt changes cleanly.`); setStatus(`new · ${preferences.language} · ${preferences.outputStyle}`); }
    catch (error) { line('error', error instanceof Error ? error.message : String(error)); }
    input.setValue(''); return;
  }
  if (text.startsWith('/review ')) return start(text.slice(8).trim(), 'pr-review');
  const pullRequestUrl = text.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/)?.[0];
  if (pullRequestUrl) return start(pullRequestUrl, 'pr-review');
  return start(text, 'chat');
}
async function cancel(): Promise<void> {
  if (!active || !sessionId) return;
  await client.beta.agents.sessions.events.create(sessionId, { events: [{ type: 'agent.session.input.cancel' }] });
  setStatus(`cancel requested${activeTurn ? ` · ${activeTurn}` : ''}`);
}
async function shutdown(): Promise<void> { tui.stop(); await server.close(); process.exit(0); }

input.onSubmit = (value) => void submit(value);
tui.addChild(new Text(color.cyan('╭─ Pi Personal Agents ─────────────────────────────────────────────────╮'), 0, 0));
tui.addChild(new Text(`  OpenMA Agents API · ${PERSONAL_MODEL_ID} · loopback-only`, 0, 0));
tui.addChild(new Text(color.dim('  /review <PR> · /output-style <name> · /language <name> · /config · /new · /sessions · /quit'), 0, 0));
tui.addChild(new Text(color.cyan('╰──────────────────────────────────────────────────────────────────────╯'), 0, 0));
tui.addChild(new Spacer(1)); tui.addChild(transcript); tui.addChild(new Spacer(1)); tui.addChild(status); tui.addChild(input);
tui.setFocus(input);
tui.addInputListener((data) => { if (matchesKey(data, 'ctrl+c')) void (active ? cancel() : shutdown()); });
line('system', color.green('Ready. OpenMA API is backed by Pi.'));
setStatus(`idle · ${preferences.language} · ${preferences.outputStyle} · ${PERSONAL_MODEL_ID}`);
tui.start();
