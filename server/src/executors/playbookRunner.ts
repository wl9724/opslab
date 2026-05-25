import { nanoid } from 'nanoid';
import { playbooksRepo, commandsRepo, ensureLocalConnection, executionsRepo } from '../db.js';
import { startRun, stopRun, subscribe, readOutput, RunnerError } from './runner.js';
import type {
  Playbook,
  PlaybookRun,
  PlaybookStep,
  PlaybookStepResult,
  ExecStatus,
} from '../types.js';

export type PlaybookEvent =
  | { type: 'step-start'; playbookRunId: string; index: number; executionId: string; renderedCmd: string }
  | { type: 'chunk'; playbookRunId: string; index: number; executionId: string; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'step-done'; playbookRunId: string; index: number; executionId: string; status: ExecStatus; exitCode: number | null; captured?: { name: string; value: string } }
  | { type: 'step-skipped'; playbookRunId: string; index: number; reason: string }
  | { type: 'done'; playbookRunId: string; status: PlaybookRun['status']; capturedVars: Record<string, string> };

type PlaybookListener = (ev: PlaybookEvent) => void;

const runs = new Map<string, PlaybookRun>();
const listeners = new Map<string, Set<PlaybookListener>>();
const aborts = new Map<string, boolean>();

export function subscribePlaybook(playbookRunId: string, fn: PlaybookListener): () => void {
  let set = listeners.get(playbookRunId);
  if (!set) {
    set = new Set();
    listeners.set(playbookRunId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(playbookRunId);
  };
}

function emit(playbookRunId: string, ev: PlaybookEvent) {
  const set = listeners.get(playbookRunId);
  if (!set) return;
  for (const fn of set) {
    try { fn(ev); } catch { /* swallow */ }
  }
}

export interface StartPlaybookInput {
  playbookId?: string;
  /** ad-hoc playbook (not saved) */
  inline?: Omit<Playbook, 'id' | 'createdAt' | 'updatedAt'>;
  /** initial variable values, applied to every step that references the var */
  initialValues?: Record<string, string>;
  /** allow danger commands in steps */
  confirmDanger?: boolean;
}

export function getPlaybookRun(id: string): PlaybookRun | undefined {
  return runs.get(id);
}

export function abortPlaybook(playbookRunId: string): boolean {
  if (!runs.has(playbookRunId)) return false;
  aborts.set(playbookRunId, true);
  return true;
}

export function startPlaybook(input: StartPlaybookInput): { playbookRunId: string; playbook: Playbook | { name: string; steps: PlaybookStep[] } } {
  let playbook: Playbook | null = null;
  let steps: PlaybookStep[];
  let defaultConnectionId: string | undefined;
  let name: string;

  if (input.playbookId) {
    playbook = playbooksRepo.get(input.playbookId);
    if (!playbook) throw new RunnerError('playbook not found', 404);
    steps = playbook.steps;
    defaultConnectionId = playbook.defaultConnectionId;
    name = playbook.name;
  } else if (input.inline) {
    steps = input.inline.steps;
    defaultConnectionId = input.inline.defaultConnectionId;
    name = input.inline.name || '(inline)';
  } else {
    throw new RunnerError('playbookId or inline is required');
  }

  if (steps.length === 0) throw new RunnerError('playbook has no steps');

  const playbookRunId = nanoid(14);
  const localFallback = ensureLocalConnection();

  const run: PlaybookRun = {
    id: playbookRunId,
    playbookId: playbook?.id ?? null,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    steps: steps.map((s, i) => ({
      index: i,
      step: s,
      executionId: null,
      status: 'skipped',
      exitCode: null,
      startedAt: '',
      endedAt: null,
    })),
    capturedVars: {},
  };
  runs.set(playbookRunId, run);

  void executePlaybook(playbookRunId, steps, {
    defaultConnectionId: defaultConnectionId ?? localFallback.id,
    initialValues: input.initialValues ?? {},
    confirmDanger: input.confirmDanger ?? false,
  });

  return { playbookRunId, playbook: playbook ?? { name, steps } };
}

interface ExecuteCtx {
  defaultConnectionId: string;
  initialValues: Record<string, string>;
  confirmDanger: boolean;
}

async function executePlaybook(playbookRunId: string, steps: PlaybookStep[], ctx: ExecuteCtx) {
  const run = runs.get(playbookRunId)!;
  const capturedVars: Record<string, string> = { ...ctx.initialValues };

  for (let i = 0; i < steps.length; i++) {
    if (aborts.get(playbookRunId)) {
      run.status = 'aborted';
      break;
    }

    const step = steps[i];
    const result = run.steps[i];
    result.startedAt = new Date().toISOString();

    // Resolve template / vars for this step
    let template: string | undefined;
    let stepVars: { name: string; required: boolean }[] = [];
    let targetConn = step.connectionId ?? ctx.defaultConnectionId;

    if (step.commandId) {
      const cmd = commandsRepo.get(step.commandId);
      if (!cmd) {
        result.status = 'failed';
        result.endedAt = new Date().toISOString();
        emit(playbookRunId, { type: 'step-skipped', playbookRunId, index: i, reason: `command ${step.commandId} not found` });
        if (!step.continueOnError) {
          run.status = 'failed';
          break;
        }
        continue;
      }
      template = cmd.template;
      stepVars = cmd.vars.map((v) => ({ name: v.name, required: v.required }));
    } else if (step.inlineTemplate) {
      template = step.inlineTemplate;
    } else {
      result.status = 'failed';
      emit(playbookRunId, { type: 'step-skipped', playbookRunId, index: i, reason: 'step has no command' });
      if (!step.continueOnError) {
        run.status = 'failed';
        break;
      }
      continue;
    }

    // Merge values: capturedVars (from earlier steps) < step.values (explicit override)
    const values: Record<string, string> = { ...capturedVars, ...(step.values ?? {}) };

    let startResult;
    try {
      startResult = startRun({
        commandId: step.commandId ?? undefined,
        connectionId: targetConn,
        template: step.commandId ? undefined : template,
        values,
        confirmDanger: ctx.confirmDanger,
      });
    } catch (e) {
      const msg = (e as Error).message;
      result.status = 'failed';
      result.endedAt = new Date().toISOString();
      emit(playbookRunId, { type: 'step-skipped', playbookRunId, index: i, reason: msg });
      if (!step.continueOnError) {
        run.status = 'failed';
        break;
      }
      continue;
    }

    const execId = startResult.execution.id;
    result.executionId = execId;
    result.status = 'running';
    emit(playbookRunId, {
      type: 'step-start',
      playbookRunId,
      index: i,
      executionId: execId,
      renderedCmd: startResult.execution.renderedCmd,
    });

    // Subscribe to underlying execution and wait for done
    const exitInfo = await new Promise<{ status: ExecStatus; exitCode: number | null }>((resolve) => {
      let settled = false;
      const abortPoll = setInterval(() => {
        if (aborts.get(playbookRunId)) stopRun(execId);
      }, 500);
      abortPoll.unref();

      const finish = (v: { status: ExecStatus; exitCode: number | null }) => {
        if (settled) return;
        settled = true;
        clearInterval(abortPoll);
        unsub();
        resolve(v);
      };

      const unsub = subscribe(execId, (ev) => {
        if (ev.type === 'chunk') {
          emit(playbookRunId, {
            type: 'chunk',
            playbookRunId,
            index: i,
            executionId: execId,
            stream: ev.stream,
            data: ev.data,
          });
        } else if (ev.type === 'done') {
          finish({ status: ev.status, exitCode: ev.exitCode });
        }
      });

      // Safety net: if the execution finished before we subscribed, fall back to DB
      setImmediate(() => {
        if (settled) return;
        const ex = executionsRepo.get(execId);
        if (ex && ex.status !== 'running') {
          finish({ status: ex.status, exitCode: ex.exitCode });
        }
      });
    });

    result.status = exitInfo.status;
    result.exitCode = exitInfo.exitCode;
    result.endedAt = new Date().toISOString();

    // Capture variable from stdout (read from disk; ANSI-strip)
    let captured: { name: string; value: string } | undefined;
    if (step.captureAs && exitInfo.status === 'completed') {
      const raw = readOutput(execId);
      const stripped = stripAnsi(raw).trim();
      capturedVars[step.captureAs] = stripped;
      captured = { name: step.captureAs, value: stripped };
    }

    emit(playbookRunId, {
      type: 'step-done',
      playbookRunId,
      index: i,
      executionId: execId,
      status: exitInfo.status,
      exitCode: exitInfo.exitCode,
      captured,
    });

    if (exitInfo.status !== 'completed' && !step.continueOnError) {
      run.status = 'failed';
      break;
    }
  }

  if (run.status === 'running') run.status = 'completed';
  run.endedAt = new Date().toISOString();
  run.capturedVars = capturedVars;
  emit(playbookRunId, { type: 'done', playbookRunId, status: run.status, capturedVars });

  // Keep run for 1 hour for late subscribers, then GC
  setTimeout(() => {
    runs.delete(playbookRunId);
    listeners.delete(playbookRunId);
    aborts.delete(playbookRunId);
  }, 60 * 60 * 1000).unref();
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}
