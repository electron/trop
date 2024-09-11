import { EventEmitter } from 'events';

import { ExecutionQueue } from '../src/Queue';

const waitForEvent = (emitter: EventEmitter, event: string) => {
  return new Promise<void>((resolve) => {
    emitter.once(event, resolve);
  });
};

const delayedEvent = async (
  emitter: EventEmitter,
  event: string,
  fn: () => Promise<void>,
) => {
  const waiter = waitForEvent(emitter, event);
  await fn();
  await waiter;
};

const fakeTask = (name: string) => {
  const namedArgs = {
    name,
    taskRunner: jest.fn().mockResolvedValue(undefined),
    errorHandler: jest.fn().mockResolvedValue(undefined),
    args: () =>
      [name, namedArgs.taskRunner, namedArgs.errorHandler] as [
        string,
        () => Promise<void>,
        () => Promise<void>,
      ],
  };
  return namedArgs;
};

describe('ExecutionQueue', () => {
  it('should run task immediately when queue is empty', async () => {
    const q = new ExecutionQueue();

    const task = fakeTask('test');
    await delayedEvent(q, 'empty', async () => q.enterQueue(...task.args()));
    expect(task.taskRunner).toHaveBeenCalledTimes(1);
  });

  it('should run the tasks error handler if the task throws', async () => {
    const q = new ExecutionQueue();

    const task = fakeTask('test');
    task.taskRunner.mockRejectedValue('err');
    await delayedEvent(q, 'empty', async () => q.enterQueue(...task.args()));
    expect(task.taskRunner).toHaveBeenCalledTimes(1);
    expect(task.errorHandler).toHaveBeenCalledTimes(1);
    expect(task.errorHandler).toHaveBeenNthCalledWith(1, 'err');
  });

  it('should run the next task if the current task succeeds', async () => {
    const q = new ExecutionQueue();

    const task = fakeTask('test');
    const task2 = fakeTask('test2');
    await delayedEvent(q, 'empty', async () => {
      q.enterQueue(...task.args());
      q.enterQueue(...task2.args());
    });
    expect(task.taskRunner).toHaveBeenCalledTimes(1);
    expect(task2.taskRunner).toHaveBeenCalledTimes(1);
  });

  it('should run the next task if the current task fails', async () => {
    const q = new ExecutionQueue();

    const task = fakeTask('test');
    task.taskRunner.mockRejectedValue('err');
    const task2 = fakeTask('test2');
    await delayedEvent(q, 'empty', async () => {
      q.enterQueue(...task.args());
      q.enterQueue(...task2.args());
    });
    expect(task.taskRunner).toHaveBeenCalledTimes(1);
    expect(task2.taskRunner).toHaveBeenCalledTimes(1);
  });

  it("should run the next task if the current task fails and it's error handler fails", async () => {
    const q = new ExecutionQueue();

    const task = fakeTask('test');
    task.taskRunner.mockRejectedValue('err');
    task.errorHandler.mockRejectedValue('bad error');
    const task2 = fakeTask('test2');
    await delayedEvent(q, 'empty', async () => {
      q.enterQueue(...task.args());
      q.enterQueue(...task2.args());
    });
    expect(task.taskRunner).toHaveBeenCalledTimes(1);
    expect(task2.taskRunner).toHaveBeenCalledTimes(1);
  });
});
