import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export type PiRpcEvent = Record<string, unknown> & { type: string };
type Pending = { resolve(value: PiRpcEvent): void; reject(error: Error): void };

export class PiRpcClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Set<(event: PiRpcEvent) => void>();
  #sequence = 0;
  #closed = false;

  constructor(options: { cwd: string; sessionDir: string; sessionPath?: string; instructions: string }) {
    const args = [
      '--mode', 'rpc', '--provider', 'openai-codex', '--model', 'gpt-5.6-luna',
      '--thinking', 'medium', '--session-dir', options.sessionDir,
      '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates',
      '--no-context-files', '--system-prompt', options.instructions,
      ...(options.sessionPath ? ['--session', options.sessionPath] : []),
    ];
    this.#child = spawn(process.env.PI_PERSONAL_PI_COMMAND ?? 'pi', args, {
      cwd: options.cwd,
      env: { ...process.env, PI_SKIP_VERSION_CHECK: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#readJsonl(this.#child.stdout);
    let stderr = '';
    this.#child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-8_000); });
    this.#child.once('exit', (code, signal) => {
      this.#closed = true;
      const error = new Error(`Pi RPC exited code=${String(code)} signal=${String(signal)}${stderr ? `: ${stderr.trim()}` : ''}`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      this.#emit({ type: 'rpc_exit', code, signal });
    });
    this.#child.once('error', (error) => {
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<PiRpcEvent> {
    if (this.#closed) throw new Error('Pi RPC process is closed');
    const id = `rpc_${++this.#sequence}`;
    const promise = new Promise<PiRpcEvent>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    const timeout = setTimeout(() => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      pending.reject(new Error(`Pi RPC ${String(command.type)} timed out`));
    }, timeoutMs);
    try { return await promise; }
    finally { clearTimeout(timeout); }
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#child.kill('SIGTERM');
    await new Promise<void>((resolve) => this.#child.once('exit', () => resolve()));
  }

  #emit(event: PiRpcEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #readJsonl(stream: NodeJS.ReadableStream): void {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line) continue;
        this.#acceptLine(line);
      }
    });
    stream.on('end', () => {
      buffer += decoder.end();
      if (buffer) this.#acceptLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    });
  }

  #acceptLine(line: string): void {
    let event: PiRpcEvent;
    try { event = JSON.parse(line) as PiRpcEvent; }
    catch { this.#emit({ type: 'rpc_parse_error', message: 'Pi emitted invalid JSONL' }); return; }
    const id = typeof event.id === 'string' ? event.id : undefined;
    if (event.type === 'response' && id) {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        if (event.success === false) pending.reject(new Error(typeof event.error === 'string' ? event.error : 'Pi RPC request failed'));
        else pending.resolve(event);
        return;
      }
    }
    this.#emit(event);
  }
}
