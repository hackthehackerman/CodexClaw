export class PerThreadQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  async enqueue<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextTail = previous.then(() => gate);
    this.tails.set(threadId, nextTail);

    await previous;

    try {
      return await task();
    } finally {
      release();

      if (this.tails.get(threadId) === nextTail) {
        this.tails.delete(threadId);
      }
    }
  }
}

