export type Executor = () => Promise<void>;

const MAX_ACTIVE = 5;

class ExecutionQueue {
  public activeIdents: Set<string> = new Set();
  private queue: [string, Executor, Executor][] = [];
  private active = 0;

  public enterQueue = (identifier: string, fn: Executor, errorFn: Executor) => {
    if (this.activeIdents.has(identifier)) return;

    this.activeIdents.add(identifier);
    if (this.active >= MAX_ACTIVE) {
      this.queue.push([identifier, fn, errorFn]);
    } else {
      this.run([identifier, fn, errorFn]);
    }
  }

  private run = (fns: [string, Executor, Executor]) => {
    this.active += 1;
    fns[1]().then(() => this.runNext(fns[0])).catch((err: any) => {
      console.error(err);
      fns[2]().catch(console.error);
      this.runNext(fns[0]);
    });
  }

  private runNext = (lastIdent: string) => {
    this.activeIdents.delete(lastIdent);
    this.active -= 1;
    if (this.queue.length > 0 && this.active < MAX_ACTIVE) {
      this.run(this.queue.shift()!);
    }
  }
}

export default new ExecutionQueue();
