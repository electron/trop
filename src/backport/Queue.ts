export type Executor = () => Promise<void>;

class ExecutionQueue {
  private queue: [Executor, Executor][] = [];
  private locked = false;

  public enterQueue = (fn: Executor, errorFn: Executor) => {
    if (this.locked) {
      this.queue.push([fn, errorFn]);
    } else {
      this.run([fn, errorFn]);
    }
  }

  private run = (fns: [Executor, Executor]) => {
    this.locked = true;
    fns[0]().then(this.runNext).catch((err: any) => {
      console.error(err);
      fns[1]().catch(console.error);
      this.runNext();
    });
  }

  private runNext = () => {
    if (this.queue.length === 0) {
      this.locked = false;
    } else {
      this.run(this.queue.shift());
    }
  }
}

export default new ExecutionQueue();
