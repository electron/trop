import { EventEmitter } from 'events';
import { log } from './utils/log-util';
import { LogLevel } from './enums';

export type Executor = () => Promise<void>;
export type ErrorExecutor = (err: unknown) => Promise<void>;
type Job = [string, Executor, ErrorExecutor, (() => void) | undefined];

const DEFAULT_MAX_ACTIVE = 5;

export class ExecutionQueue extends EventEmitter {
  public activeIdents: Set<string> = new Set();
  private queue: Job[] = [];
  private active = 0;

  constructor(private maxActive = DEFAULT_MAX_ACTIVE) {
    super();
  }

  /**
   * Queues `fn` (and `errorFn` if it throws), unless a job with the same
   * identifier is queued or running already. `onSettled` is called once the
   * job is over, or right away if it was not queued.
   */
  public enterQueue = (
    identifier: string,
    fn: Executor,
    errorFn: ErrorExecutor,
    onSettled?: () => void,
  ) => {
    if (this.activeIdents.has(identifier)) {
      onSettled?.();
      return;
    }

    this.activeIdents.add(identifier);
    const job: Job = [identifier, fn, errorFn, onSettled];
    if (this.active >= this.maxActive) {
      log('enterQueue', LogLevel.INFO, `Adding ${identifier} to queue`);
      this.queue.push(job);
    } else {
      this.run(job);
    }
  };

  private run = (fns: Job) => {
    this.active += 1;
    fns[1]()
      .then(() => this.runNext(fns))
      .catch((err: unknown) => {
        if (!process.env.SPEC_RUNNING) {
          console.error(err);
        }
        void fns[2](err)
          .catch((e) => {
            if (!process.env.SPEC_RUNNING) console.error(e);
          })
          .then(() => this.runNext(fns));
      });
  };

  private runNext = ([lastIdent, , , onSettled]: Job) => {
    try {
      onSettled?.();
    } catch (err) {
      if (!process.env.SPEC_RUNNING) console.error(err);
    }
    log(
      'runNext',
      LogLevel.INFO,
      `Running queue item with identifier ${lastIdent}`,
    );

    this.activeIdents.delete(lastIdent);
    this.active -= 1;
    if (this.queue.length > 0 && this.active < this.maxActive) {
      this.run(this.queue.shift()!);
    } else {
      this.emit('empty');
    }
  };
}

export default new ExecutionQueue();
