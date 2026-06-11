import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { OUTPUT_DIR } from '../config.js';
import { connectionsRepo, executionsRepo, commandsRepo, ensureLocalConnection } from '../db.js';
import { runLocal, type LocalRunHandle } from './local.js';
import { runSsh, type SshRunHandle } from './ssh.js';
import { render, validateValues } from './template.js';
import { checkSafety } from './safety.js';
import { createLogger, isDebugEnabled } from '../log.js';
import type { Execution, TemplateVar } from '../types.js';

const log = createLogger('runner');

export interface StartRunInput {
  commandId?: string;
  connectionId?: string;
  template?: string;
  /** Optional override / inline interpreter. If commandId is set, the command's own interpreter wins unless this is provided. */
  interpreter?: string;
  values?: Record<string, string>;
  confirmDanger?: boolean;
}

export interface StartRunResult {
  execution: Execution;
  safety: ReturnType<typeof checkSafety>;
}

type Handle = { kill: () => void };

/** Max in-memory replay buffer per execution. ~4MB enough for most ops output. */
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** Keep state around this long after done so late subscribers can replay. */
const POST_DONE_TTL_MS = 60_000;

interface BufferedChunk {
  stream: 'stdout' | 'stderr';
  data: string;
}

interface ActiveRun {
  executionId: string;
  startedAtMs: number;
  handle: Handle | null;
  outputStream: fs.WriteStream | null;
  outputBytes: number;
  /** Replay buffer for late subscribers. Cap-limited (sliding window). */
  buffer: BufferedChunk[];
  bufferBytes: number;
  bufferTruncated: boolean;
  done: { status: Execution['status']; exitCode: number | null } | null;
  gcTimer?: NodeJS.Timeout;
}

const active = new Map<string, ActiveRun>();

export type RunListener = (
  event:
    | { type: 'chunk'; executionId: string; stream: 'stdout' | 'stderr'; data: string }
    | { type: 'done'; executionId: string; status: Execution['status']; exitCode: number | null },
) => void;

const listeners = new Map<string, Set<RunListener>>();

/**
 * Strip non-visual escape sequences that pollute captured output without changing what
 * a real terminal would render visibly. We keep:
 *   - CSI (`\x1b[...`)        — colors, cursor, erase, etc.
 *   - SS2/SS3                 — single-shift sequences (rare but harmless to keep)
 *   - Plain ASCII control chars besides BEL (which is just a beep we silence anyway)
 *
 * We strip everything else commonly emitted by shells/prompts/IDEs:
 *   - OSC  `\x1b]...(\x07|\x1b\\)`   — title, cwd, hyperlinks, shell integration (633/133/1337)
 *   - DCS  `\x1bP...\x1b\\`          — device control / Sixel
 *   - APC  `\x1b_...\x1b\\`          — Kitty graphics
 *   - PM   `\x1b^...\x1b\\`          — privacy message
 *   - SOS  `\x1bX...\x1b\\`          — start of string
 *   - Lone BEL bytes (0x07)         — terminal bell, just noise
 *
 * If a sequence is truncated at chunk boundary (no terminator yet), we leave it for the
 * next chunk; xterm.js doesn't see partial sequences from us because we only strip
 * complete ones. The trailing partial may rarely flicker as text, but it won't accumulate.
 */
const STRIP_RE = new RegExp(
  [
    // OSC: ESC ] ... (BEL | ESC \)
    '\\x1b\\][\\s\\S]*?(?:\\x07|\\x1b\\\\)',
    // DCS / APC / PM / SOS: ESC (P|_|^|X) ... ESC \
    '\\x1b[P_\\^X][\\s\\S]*?\\x1b\\\\',
    // Bell
    '\\x07',
  ].join('|'),
  'g',
);

function stripNoiseOsc(s: string): string {
  return s.replace(STRIP_RE, '');
}

function pushBuffer(ar: ActiveRun, stream: 'stdout' | 'stderr', data: string) {
  const bytes = Buffer.byteLength(data, 'utf8');
  ar.buffer.push({ stream, data });
  ar.bufferBytes += bytes;
  while (ar.bufferBytes > MAX_BUFFER_BYTES && ar.buffer.length > 0) {
    const oldest = ar.buffer.shift()!;
    ar.bufferBytes -= Buffer.byteLength(oldest.data, 'utf8');
    ar.bufferTruncated = true;
  }
}

/**
 * Subscribe to live events for an execution.
 *
 * Replay semantics (synchronous, in order):
 *   1. If we have state in memory:
 *      a. If buffer was truncated, emit a sentinel notice line first.
 *      b. Replay every buffered chunk.
 *      c. If already done, emit 'done' and return (no live listener registered).
 *      d. Otherwise, register fn for future events.
 *   2. If state is gone (GC'd long after done), fall back to reading the output file from disk
 *      and emit it as a single chunk plus the persisted done event. This happens via setImmediate
 *      since we need to read the file.
 */
export function subscribe(executionId: string, fn: RunListener): () => void {
  const ar = active.get(executionId);

  if (ar) {
    if (ar.bufferTruncated) {
      try { fn({ type: 'chunk', executionId, stream: 'stderr', data: '\n[opslab] (replay truncated — earlier output is in execution history)\n' }); } catch { /* swallow */ }
    }
    for (const c of ar.buffer) {
      try { fn({ type: 'chunk', executionId, stream: c.stream, data: c.data }); } catch { /* swallow */ }
    }
    if (ar.done) {
      try { fn({ type: 'done', executionId, status: ar.done.status, exitCode: ar.done.exitCode }); } catch { /* swallow */ }
      return () => {};
    }
    // Register for live events
    let set = listeners.get(executionId);
    if (!set) {
      set = new Set();
      listeners.set(executionId, set);
    }
    set.add(fn);
    return () => {
      const s = listeners.get(executionId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) listeners.delete(executionId);
    };
  }

  // No active state — execution either never existed or was GC'd. Try disk.
  setImmediate(() => {
    const ex = executionsRepo.get(executionId);
    if (!ex) return;
    const output = readOutput(executionId);
    if (output) {
      try { fn({ type: 'chunk', executionId, stream: 'stdout', data: output }); } catch { /* swallow */ }
    }
    if (ex.status !== 'running') {
      try { fn({ type: 'done', executionId, status: ex.status, exitCode: ex.exitCode }); } catch { /* swallow */ }
    }
  });
  return () => {};
}

function emit(executionId: string, ev: Parameters<RunListener>[0]) {
  const set = listeners.get(executionId);
  if (!set) return;
  for (const fn of set) {
    try { fn(ev); } catch { /* swallow */ }
  }
}

export class RunnerError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function startRun(input: StartRunInput): StartRunResult {
  let template = input.template;
  let commandId: string | null = input.commandId ?? null;
  let vars: TemplateVar[] = [];
  let interpreter = input.interpreter ?? 'auto';

  if (input.commandId) {
    const cmd = commandsRepo.get(input.commandId);
    if (!cmd) throw new RunnerError('command not found', 404);
    template = cmd.template;
    vars = cmd.vars;
    commandId = cmd.id;
    if (!input.interpreter) interpreter = cmd.interpreter ?? 'auto';
  }

  if (!template) throw new RunnerError('template is required');

  const values = input.values ?? {};
  const validation = validateValues(vars, values);
  if (!validation.ok) {
    throw new RunnerError(validation.errors.join('; '));
  }
  const { rendered, missing } = render(template, values);
  if (missing.length > 0) {
    throw new RunnerError(`missing variables: ${missing.join(', ')}`);
  }

  const safety = checkSafety(rendered);
  if (safety.level === 'danger' && !input.confirmDanger) {
    log.warn('高危命令已拦截', { reasons: safety.reasons, command: rendered.slice(0, 200) });
    throw new RunnerError(
      `dangerous command blocked (${safety.reasons.join(', ')}). re-run with confirmDanger=true.`,
      409,
    );
  }

  const connection = input.connectionId
    ? connectionsRepo.get(input.connectionId)
    : ensureLocalConnection();
  if (!connection) throw new RunnerError('connection not found', 404);

  const id = nanoid(14);
  const outputPath = path.join(OUTPUT_DIR, `${id}.log`);
  const outputStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });

  const execution = executionsRepo.create({
    id,
    commandId,
    connectionId: connection.id,
    renderedCmd: rendered,
    status: 'running',
    exitCode: null,
  });

  log.info('执行开始', {
    executionId: id,
    connection: `${connection.name} (${connection.type})`,
    interpreter,
    command: rendered.slice(0, 300),
  });

  // Pre-register active state synchronously BEFORE spawning, so any chunk that arrives
  // (even sync-ish) can be buffered.
  const ar: ActiveRun = {
    executionId: id,
    startedAtMs: Date.now(),
    handle: null,
    outputStream,
    outputBytes: 0,
    buffer: [],
    bufferBytes: 0,
    bufferTruncated: false,
    done: null,
  };
  active.set(id, ar);

  const onChunk = (stream: 'stdout' | 'stderr', rawData: string) => {
    // isDebugEnabled guard keeps JSON.stringify off the hot path when debug is off.
    if (isDebugEnabled()) {
      log.debug(`raw ${stream} (${id})`, JSON.stringify(rawData));
    }
    const data = stripNoiseOsc(rawData);
    if (!data) return;
    if (isDebugEnabled() && data !== rawData) {
      log.debug(`clean ${stream} (${id})`, JSON.stringify(data));
    }
    // Same cleaned bytes go to disk + buffer + live listeners — so History and Runner agree.
    ar.outputStream?.write(data);
    ar.outputBytes += Buffer.byteLength(data, 'utf8');
    pushBuffer(ar, stream, data);
    emit(id, { type: 'chunk', executionId: id, stream, data });
  };
  const onDone = (status: Execution['status'], exitCode: number | null) => {
    ar.outputStream?.end();
    ar.outputStream = null;
    executionsRepo.finish(id, status, exitCode, ar.outputBytes);
    log[status === 'failed' ? 'warn' : 'info']('执行结束', {
      executionId: id,
      status,
      exitCode,
      outputBytes: ar.outputBytes,
      durationMs: Date.now() - ar.startedAtMs,
    });
    ar.done = { status, exitCode };
    ar.handle = null;
    // Keep state around for late subscribers; GC after TTL.
    ar.gcTimer = setTimeout(() => {
      active.delete(id);
      listeners.delete(id);
    }, POST_DONE_TTL_MS);
    ar.gcTimer.unref?.();
    emit(id, { type: 'done', executionId: id, status, exitCode });
  };

  let handle: Handle;
  if (connection.type === 'local') {
    const h: LocalRunHandle = runLocal({
      command: rendered,
      interpreter,
      onStdout: (d) => onChunk('stdout', d),
      onStderr: (d) => onChunk('stderr', d),
      onError: (err) => {
        onChunk('stderr', `\n[opslab] error: ${err.message}\n`);
      },
      onExit: (code, signal) => {
        const status: Execution['status'] = signal === 'SIGTERM' || signal === 'SIGKILL'
          ? 'killed'
          : code === 0
            ? 'completed'
            : 'failed';
        onDone(status, code);
      },
    });
    handle = h;
  } else {
    const h: SshRunHandle = runSsh({
      connection,
      command: rendered,
      interpreter,
      onStdout: (d) => onChunk('stdout', d),
      onStderr: (d) => onChunk('stderr', d),
      onError: (err) => onChunk('stderr', `\n[opslab] ssh error: ${err.message}\n`),
      onExit: (code, signal) => {
        const status: Execution['status'] = signal
          ? 'killed'
          : code === 0
            ? 'completed'
            : 'failed';
        onDone(status, code ?? null);
      },
    });
    handle = h;
  }

  ar.handle = handle;
  return { execution, safety };
}

export function stopRun(executionId: string): boolean {
  const ar = active.get(executionId);
  if (!ar || !ar.handle || ar.done) return false;
  log.info('手动停止执行', { executionId });
  ar.handle.kill();
  return true;
}

/** Executions still running right now (for the debug state panel). */
export function activeRunCount(): number {
  let n = 0;
  for (const ar of active.values()) if (!ar.done) n++;
  return n;
}

export function readOutput(executionId: string): string {
  const p = path.join(OUTPUT_DIR, `${executionId}.log`);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}
