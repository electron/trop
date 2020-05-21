import { EventEmitter } from 'events';
import { log } from './utils/log-util';
import { LogLevel } from './enums';

export type Executor = () => Promise<void>;
export type ErrorExecutor = (err: any) => Promise<void>;

const DEFAULT_MAX_ACTIVE = 5;

export class ExecutionQueue extends EventEmitter {
  public activeIdents: Set<string> = new Set();
  private queue: [string, Executor, ErrorExecutor][] = [];
  private active = 0;

  constructor(private maxActive = DEFAULT_MAX_ACTIVE) {
    super();
  }

  public enterQueue = (
    identifier: string,
    fn: Executor,
    errorFn: ErrorExecutor,
  ) => {
    if (this.activeIdents.has(identifier)) return;

    this.activeIdents.add(identifier);
    if (this.active >= this.maxActive) {
      log('enterQueue', LogLevel.INFO, `Adding ${identifier} to queue`);
      this.queue.push([identifier, fn, errorFn]);
    } else {
      this.run([identifier, fn, errorFn]);
    }
  };

  private run = (fns: [string, Executor, ErrorExecutor]) => {
    this.active += 1;
    fns[1]()
      .then(() => this.runNext(fns[0]))
      .catch((err: any) => {
        if (!process.env.SPEC_RUNNING) {
          console.error(err);
        }
        fns[2](err)
          .catch((e) => {
            if (!process.env.SPEC_RUNNING) console.error(e);
          })
          .then(() => this.runNext(fns[0]));
      });
  };

  private runNext = (lastIdent: string) => {
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
