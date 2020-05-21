import { EventEmitter } from 'events';
import * as sinon from 'sinon';

import { ExecutionQueue } from '../src/Queue';

const noop = async () => {};

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
    taskRunner: sinon.stub().returns(Promise.resolve()),
    errorHandler: sinon.stub().returns(Promise.resolve()),
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
    expect(task.taskRunner.callCount).toBe(1);
  });

  it('should run the tasks error handler if the task throws', async () => {
    const q = new ExecutionQueue();

    const task = fakeTask('test');
    task.taskRunner.returns(Promise.reject('err'));
    await delayedEvent(q, 'empty', async () => q.enterQueue(...task.args()));
    expect(task.taskRunner.callCount).toBe(1);
    expect(task.errorHandler.callCount).toBe(1);
    expect(task.errorHandler.firstCall.args[0]).toBe('err');
  });

  it('should run the next task if the current task succeeds', async () => {
    const q = new ExecutionQueue();

    const task = fakeTask('test');
    const task2 = fakeTask('test2');
    await delayedEvent(q, 'empty', async () => {
      q.enterQueue(...task.args());
      q.enterQueue(...task2.args());
    });
    expect(task.taskRunner.callCount).toBe(1);
    expect(task2.taskRunner.callCount).toBe(1);
  });

  it('should run the next task if the current task fails', async () => {
    const q = new ExecutionQueue();

    const task = fakeTask('test');
    task.taskRunner.returns(Promise.reject('err'));
    const task2 = fakeTask('test2');
    await delayedEvent(q, 'empty', async () => {
      q.enterQueue(...task.args());
      q.enterQueue(...task2.args());
    });
    expect(task.taskRunner.callCount).toBe(1);
    expect(task2.taskRunner.callCount).toBe(1);
  });

  it("should run the next task if the current task fails and it's error handler fails", async () => {
    const q = new ExecutionQueue();

    const task = fakeTask('test');
    task.taskRunner.returns(Promise.reject('err'));
    task.errorHandler.returns(Promise.reject('bad error'));
    const task2 = fakeTask('test2');
    await delayedEvent(q, 'empty', async () => {
      q.enterQueue(...task.args());
      q.enterQueue(...task2.args());
    });
    expect(task.taskRunner.callCount).toBe(1);
    expect(task2.taskRunner.callCount).toBe(1);
  });
});
