import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CreateSessionCommand, ListQuery, MessageItemView, Result, SessionEvent, SessionInput,
  SessionsApplicationPort, SessionView, TokenUsage, TurnView,
} from '../vendor/open-managed-agents/packages/openai-agents-api/src/ports.ts';
import { fetchPullRequestEvidence } from './github-pr.js';
import { PiRpcClient, type PiRpcEvent } from './rpc-client.js';
import { normalizeTriageReport, parseTriageSummary, PR_REVIEW_INSTRUCTIONS } from './triage.js';

const MODEL = 'openai-codex/gpt-5.6-luna';
const AGENT_ID = 'agent_pi_personal';
const now = () => Math.floor(Date.now() / 1000);
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;

interface StoredRecord {
  id: string; createdAt: number; lastActiveAt: number; metadata: Record<string, string>;
  instructions: string; sessionFile: string | null; status: SessionView['status']; error: string | null;
  events: SessionEvent[]; items: MessageItemView[]; turns: TurnView[]; idempotencyKeys: string[];
}
interface LiveRecord { state: StoredRecord; rpc: PiRpcClient; listeners: Set<(event: SessionEvent) => void>; currentText: string; currentItemId: string | null }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function responseData(value: PiRpcEvent): Record<string, unknown> { return isRecord(value.data) ? value.data : {}; }
function textFromMessage(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return '';
  return message.content.flatMap((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('');
}
function usageFromMessage(message: unknown): TokenUsage | null {
  if (!isRecord(message) || !isRecord(message.usage)) return null;
  const usage = message.usage;
  const number = (key: string) => typeof usage[key] === 'number' ? usage[key] : 0;
  return {
    inputTokens: number('input'), outputTokens: number('output'), totalTokens: number('totalTokens'),
    inputTokensDetails: { cachedTokens: number('cacheRead') }, outputTokensDetails: { reasoningTokens: 0 },
  };
}
function contentText(input: SessionInput & { type: 'message' }): Result<string> {
  const chunks: string[] = [];
  for (const message of input.input) for (const part of message.content) {
    if (part.type !== 'text') return { type: 'unsupported', message: 'Image input is not connected to the Pi personal adapter' };
    chunks.push(part.text);
  }
  return { type: 'success', value: chunks.join('\n') };
}
function initialText(input: CreateSessionCommand['input']): Result<string> {
  if (typeof input === 'string') return { type: 'success', value: input };
  if (!input) return { type: 'invalidRequest', message: 'Initial input is required', param: 'input' };
  return contentText({ type: 'message', input });
}

export class PiSessionsPort implements SessionsApplicationPort {
  readonly #records = new Map<string, LiveRecord>();
  readonly #dataDir: string; readonly #workspace: string; readonly #sessionsDir: string;

  constructor(options: { dataDir: string }) {
    this.#dataDir = options.dataDir;
    this.#workspace = join(options.dataDir, 'workspace');
    this.#sessionsDir = join(options.dataDir, 'pi-sessions');
  }

  async initialize(): Promise<void> {
    await Promise.all([mkdir(this.#workspace, { recursive: true }), mkdir(this.#sessionsDir, { recursive: true }), mkdir(join(this.#dataDir, 'index'), { recursive: true })]);
    for (const name of await readdir(join(this.#dataDir, 'index')).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      try {
        const state = JSON.parse(await readFile(join(this.#dataDir, 'index', name), 'utf8')) as StoredRecord;
        if (!state.sessionFile) continue;
        const live = await this.#open(state);
        this.#records.set(state.id, live);
      } catch { /* A corrupt local prototype record is omitted, never guessed. */ }
    }
  }

  async createSession(command: CreateSessionCommand): Promise<Result<SessionView>> {
    const created = await this.#create(command);
    if (created.type !== 'success') return created;
    void this.#runPrompt(created.value.live, created.value.prompt);
    return { type: 'success', value: this.#view(created.value.live.state) };
  }

  async createSessionStream(command: CreateSessionCommand, signal: AbortSignal): Promise<Result<AsyncIterable<SessionEvent>>> {
    const created = await this.#create(command);
    if (created.type !== 'success') return created;
    const stream = this.#events(created.value.live, signal, true);
    void this.#runPrompt(created.value.live, created.value.prompt);
    return { type: 'success', value: stream };
  }

  async retrieveSession({ sessionId }: { sessionId: string }): Promise<Result<SessionView>> {
    const live = this.#records.get(sessionId);
    return live ? { type: 'success', value: this.#view(live.state) } : { type: 'notFound', message: 'Session not found' };
  }

  async updateSession(command: { sessionId: string; metadata?: Record<string, string> | null }): Promise<Result<SessionView>> {
    const live = this.#records.get(command.sessionId);
    if (!live) return { type: 'notFound', message: 'Session not found' };
    if (command.metadata !== undefined) live.state.metadata = command.metadata ?? {};
    live.state.lastActiveAt = now(); await this.#save(live.state);
    return { type: 'success', value: this.#view(live.state) };
  }

  async listSessions(query: { after?: string; limit?: number; order?: 'asc' | 'desc'; agentId?: string }): Promise<Result<{ data: SessionView[]; hasMore: boolean }>> {
    if (query.agentId && query.agentId !== AGENT_ID) return { type: 'success', value: { data: [], hasMore: false } };
    const ordered = [...this.#records.values()].sort((a, b) => a.state.createdAt - b.state.createdAt);
    if (query.order === 'desc') ordered.reverse();
    const start = query.after ? Math.max(0, ordered.findIndex((entry) => entry.state.id === query.after) + 1) : 0;
    const limit = query.limit ?? 20; const page = ordered.slice(start, start + limit);
    return { type: 'success', value: { data: page.map((entry) => this.#view(entry.state)), hasMore: start + limit < ordered.length } };
  }

  async deleteSession({ sessionId }: { sessionId: string }): Promise<Result<{ sessionId: string }>> {
    const live = this.#records.get(sessionId);
    if (!live) return { type: 'notFound', message: 'Session not found' };
    await live.rpc.stop(); this.#records.delete(sessionId);
    await rm(join(this.#dataDir, 'index', `${sessionId}.json`), { force: true });
    if (live.state.sessionFile?.startsWith(this.#sessionsDir)) await rm(live.state.sessionFile, { force: true });
    return { type: 'success', value: { sessionId } };
  }

  async sendEvents(command: { sessionId: string; events: SessionInput[]; idempotencyKey?: string }): Promise<Result<void>> {
    const live = this.#records.get(command.sessionId);
    if (!live) return { type: 'notFound', message: 'Session not found' };
    if (command.idempotencyKey && live.state.idempotencyKeys.includes(command.idempotencyKey)) return { type: 'success', value: undefined };
    if (command.events.length !== 1) return { type: 'invalidRequest', message: 'Personal adapter accepts one input event at a time' };
    const event = command.events[0]!;
    if (event.type === 'cancel') {
      const turn = live.state.turns.at(-1);
      if (turn?.status === 'inProgress') {
        turn.status = 'cancelled'; turn.completedAt = now(); live.state.status = 'idle'; live.state.lastActiveAt = now();
      }
      await live.rpc.request({ type: 'abort' });
      if (turn?.status === 'cancelled') {
        this.#emit(live, { type: 'turnCancelled', eventId: uid('evt'), sessionId: live.state.id, turnId: turn.id, turn: structuredClone(turn), usage: turn.usage });
        this.#emit(live, { type: 'idle', eventId: uid('evt'), session: this.#view(live.state) });
      }
      if (command.idempotencyKey) live.state.idempotencyKeys.push(command.idempotencyKey);
      await this.#save(live.state);
      return { type: 'success', value: undefined };
    }
    if (event.type === 'toolResult') return { type: 'unsupported', message: 'Client function tools are not connected' };
    if (live.state.status === 'inProgress') return { type: 'conflict', message: 'Session already has an active turn' };
    const text = contentText(event); if (text.type !== 'success') return text;
    if (command.idempotencyKey) live.state.idempotencyKeys.push(command.idempotencyKey);
    void this.#runPrompt(live, text.value); await this.#save(live.state);
    return { type: 'success', value: undefined };
  }

  async streamEvents({ sessionId }: { sessionId: string }, signal: AbortSignal): Promise<Result<AsyncIterable<SessionEvent>>> {
    const live = this.#records.get(sessionId);
    return live ? { type: 'success', value: this.#events(live, signal, false) } : { type: 'notFound', message: 'Session not found' };
  }

  async listItems(query: ListQuery & { sessionId: string }): Promise<Result<{ data: MessageItemView[]; hasMore: boolean }>> {
    const live = this.#records.get(query.sessionId); if (!live) return { type: 'notFound', message: 'Session not found' };
    return { type: 'success', value: this.#page(live.state.items, query) };
  }
  async listTurns(query: ListQuery & { sessionId: string }): Promise<Result<{ data: TurnView[]; hasMore: boolean }>> {
    const live = this.#records.get(query.sessionId); if (!live) return { type: 'notFound', message: 'Session not found' };
    return { type: 'success', value: this.#page(live.state.turns, query) };
  }
  async retrieveTurn({ sessionId, turnId }: { sessionId: string; turnId: string }): Promise<Result<TurnView>> {
    const live = this.#records.get(sessionId); if (!live) return { type: 'notFound', message: 'Session not found' };
    const turn = live.state.turns.find((entry) => entry.id === turnId);
    return turn ? { type: 'success', value: turn } : { type: 'notFound', message: 'Turn not found' };
  }

  async close(): Promise<void> { await Promise.all([...this.#records.values()].map((entry) => entry.rpc.stop())); }

  async #create(command: CreateSessionCommand): Promise<Result<{ live: LiveRecord; prompt: string }>> {
    if (command.environment.type !== 'none') return { type: 'unsupported', message: 'Only environment.type=none is connected' };
    if (command.agentId) return { type: 'unsupported', message: 'Saved agents are not connected; use an inline agent' };
    if (command.vaultIds?.length) return { type: 'unsupported', message: 'Vaults are not connected' };
    if (command.agent?.multiAgent?.enabled) return { type: 'unsupported', message: 'Subagents are not connected' };
    if (command.agent?.tools?.length) return { type: 'unsupported', message: 'Client function tools are not connected' };
    if (command.agent?.model && command.agent.model !== MODEL) return { type: 'invalidRequest', message: `Model must be ${MODEL}`, param: 'agent.model' };
    const input = initialText(command.input); if (input.type !== 'success') return input;
    const id = uid('sess_pi'); const instructions = command.agent?.instructions?.trim() || 'You are a concise personal assistant.';
    const state: StoredRecord = { id, createdAt: now(), lastActiveAt: now(), metadata: command.metadata ?? {}, instructions, sessionFile: null, status: 'idle', error: null, events: [], items: [], turns: [], idempotencyKeys: [] };
    const live = await this.#open(state); this.#records.set(id, live);
    this.#emit(live, { type: 'created', eventId: uid('evt'), session: this.#view(state) }); await this.#save(state);
    return { type: 'success', value: { live, prompt: input.value } };
  }

  async #open(state: StoredRecord): Promise<LiveRecord> {
    const rpc = new PiRpcClient({ cwd: this.#workspace, sessionDir: this.#sessionsDir, sessionPath: state.sessionFile ?? undefined, instructions: state.instructions });
    const live: LiveRecord = { state, rpc, listeners: new Set(), currentText: '', currentItemId: null };
    rpc.onEvent((event) => void this.#onPiEvent(live, event));
    const response = await rpc.request({ type: 'get_state' }); const data = responseData(response);
    const model = isRecord(data.model) ? data.model : {};
    if (model.provider !== 'openai-codex' || model.id !== 'gpt-5.6-luna') { await rpc.stop(); throw new Error(`Pi resolved unexpected model ${String(model.provider)}/${String(model.id)}`); }
    state.sessionFile = typeof data.sessionFile === 'string' ? data.sessionFile : state.sessionFile;
    return live;
  }

  async #runPrompt(live: LiveRecord, raw: string): Promise<void> {
    const state = live.state;
    const initialReview = state.metadata.mode === 'pr-review' && state.turns.length === 0;
    const turn: TurnView = { id: uid('turn'), agentId: AGENT_ID, sessionId: state.id, subagentId: null, createdAt: now(), startedAt: now(), completedAt: null, status: 'inProgress', error: null, usage: null };
    state.turns.push(turn); state.status = 'inProgress'; state.error = null; state.lastActiveAt = now();
    state.items.push({ type: 'message', id: uid('item'), turnId: turn.id, role: 'user', content: [{ type: 'text', text: raw }], phase: null, status: 'completed' });
    live.currentText = ''; live.currentItemId = uid('item');
    this.#emit(live, { type: 'turnCreated', eventId: uid('evt'), sessionId: state.id, turnId: turn.id, turn: structuredClone(turn) });
    this.#emit(live, { type: 'turnInProgress', eventId: uid('evt'), sessionId: state.id, turnId: turn.id, turn: structuredClone(turn) });
    this.#emit(live, { type: 'inProgress', eventId: uid('evt'), session: this.#view(state) }); await this.#save(state);
    let prompt = raw;
    if (initialReview) {
      try { prompt = `${PR_REVIEW_INSTRUCTIONS}\n\n${await fetchPullRequestEvidence(raw)}`; }
      catch (error) { this.#failTurn(live, turn, error); return; }
    }
    try { await live.rpc.request({ type: 'prompt', message: prompt }, 60_000); }
    catch (error) { this.#failTurn(live, turn, error); }
  }

  async #onPiEvent(live: LiveRecord, event: PiRpcEvent): Promise<void> {
    const state = live.state; const turn = state.turns.at(-1); if (!turn) return;
    const triageTurn = state.metadata.mode === 'pr-review' && state.turns[0]?.id === turn.id;
    if (event.type === 'message_update' && isRecord(event.assistantMessageEvent) && event.assistantMessageEvent.type === 'text_delta' && typeof event.assistantMessageEvent.delta === 'string') {
      const delta = event.assistantMessageEvent.delta; live.currentText += delta;
      if (!triageTurn) this.#emit(live, { type: 'outputTextDelta', eventId: uid('evt'), sessionId: state.id, turnId: turn.id, itemId: live.currentItemId!, contentIndex: 0, outputIndex: 0, delta });
    }
    if (event.type === 'turn_end' && isRecord(event.message)) turn.usage = usageFromMessage(event.message);
    if (event.type === 'agent_settled') {
      if (turn.status !== 'inProgress') return;
      const last = await live.rpc.request({ type: 'get_last_assistant_text' }).catch(() => ({ type: 'response', data: {} }));
      const rawText = typeof responseData(last).text === 'string' ? String(responseData(last).text) : live.currentText;
      let text = rawText;
      if (triageTurn) {
        try { text = normalizeTriageReport(rawText); parseTriageSummary(text); }
        catch (error) { this.#failTurn(live, turn, error); return; }
      }
      turn.status = 'completed'; turn.completedAt = now(); state.status = 'idle'; state.lastActiveAt = now();
      state.items.push({ type: 'message', id: live.currentItemId, turnId: turn.id, role: 'assistant', content: [{ type: 'outputText', text }], phase: 'finalAnswer', status: 'completed' });
      this.#emit(live, { type: 'outputTextDone', eventId: uid('evt'), sessionId: state.id, turnId: turn.id, itemId: live.currentItemId!, contentIndex: 0, outputIndex: 0, text });
      this.#emit(live, { type: 'turnCompleted', eventId: uid('evt'), sessionId: state.id, turnId: turn.id, turn: structuredClone(turn), usage: turn.usage });
      this.#emit(live, { type: 'idle', eventId: uid('evt'), session: this.#view(state) }); await this.#save(state);
    }
    if (event.type === 'rpc_exit' && state.status === 'inProgress') this.#failTurn(live, turn, new Error('Pi RPC process exited'));
  }

  #failTurn(live: LiveRecord, turn: TurnView, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = message === 'Invalid URL' || message.startsWith('Expected https://github.com/') ? 'invalid_request' : 'server_error';
    turn.status = 'failed'; turn.completedAt = now(); turn.error = { code, message };
    live.state.status = 'failed'; live.state.error = message; live.state.lastActiveAt = now();
    this.#emit(live, { type: 'turnFailed', eventId: uid('evt'), sessionId: live.state.id, turnId: turn.id, turn: structuredClone(turn), usage: turn.usage });
    this.#emit(live, { type: 'failed', eventId: uid('evt'), session: this.#view(live.state) }); void this.#save(live.state);
  }

  #emit(live: LiveRecord, event: SessionEvent): void { live.state.events.push(event); for (const listener of live.listeners) listener(event); }
  async *#events(live: LiveRecord, signal: AbortSignal, closeOnTerminal: boolean): AsyncIterable<SessionEvent> {
    let cursor = 0; const wake: Array<() => void> = []; const notify = () => wake.shift()?.(); live.listeners.add(notify);
    try {
      while (!signal.aborted) {
        while (cursor < live.state.events.length) {
          const event = live.state.events[cursor++]!; yield event;
          if (closeOnTerminal && (event.type === 'idle' || event.type === 'failed')) return;
        }
        await new Promise<void>((resolve) => { wake.push(resolve); signal.addEventListener('abort', () => resolve(), { once: true }); });
      }
    } finally { live.listeners.delete(notify); }
  }

  #view(state: StoredRecord): SessionView { return { id: state.id, agent: { id: AGENT_ID, name: 'Pi Personal Agent', model: MODEL, instructions: state.instructions, reasoning: { effort: 'medium', summary: null }, serviceTier: 'auto', multiAgent: { enabled: false, maxConcurrentSubagents: null }, text: { verbosity: 'medium', format: { type: 'text' } }, tools: [] }, createdAt: state.createdAt, lastActiveAt: state.lastActiveAt, environment: { type: 'none' }, error: state.error, metadata: state.metadata, requiredActions: [], status: state.status, usage: state.turns.at(-1)?.usage ?? null, vaultIds: [] }; }
  #page<T extends { id: string | null }>(input: T[], query: ListQuery): { data: T[]; hasMore: boolean } { const ordered = [...input]; if (query.order === 'desc') ordered.reverse(); const start = query.after ? Math.max(0, ordered.findIndex((entry) => entry.id === query.after) + 1) : 0; const limit = query.limit ?? 20; return { data: ordered.slice(start, start + limit), hasMore: start + limit < ordered.length }; }
  async #save(state: StoredRecord): Promise<void> { await writeFile(join(this.#dataDir, 'index', `${state.id}.json`), `${JSON.stringify(state)}\n`, { mode: 0o600 }); }
}

export { MODEL as PERSONAL_MODEL_ID };
