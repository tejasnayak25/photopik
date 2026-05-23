class DriveQueue {
  constructor(concurrency = 2) {
    this.queue = []
    this.running = 0
    this.concurrency = concurrency
    this.successCount = 0
    this.failureCount = 0
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, attempt: 0 })
      this._next()
    })
  }

  _next() {
    if (this.running >= this.concurrency) return
    const item = this.queue.shift()
    if (!item) return
    this.running++
    this._runItem(item).finally(() => {
      this.running--
      this._next()
    })
  }

  async _runItem(item) {
    const maxAttempts = 5
    const baseDelay = 500 // ms
    while (item.attempt < maxAttempts) {
      try {
        const result = await item.fn()
        item.resolve(result)
        this.successCount++
        return
      } catch (err) {
        item.attempt++
        if (item.attempt >= maxAttempts) {
          item.reject(err)
          this.failureCount++
          return
        }
        const delay = baseDelay * Math.pow(2, item.attempt - 1) + Math.floor(Math.random() * 200)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
}

const driveQueue = new DriveQueue(2)
export default driveQueue

export function getDriveQueueStats() {
  return {
    pending: driveQueue.queue.length,
    running: driveQueue.running,
    concurrency: driveQueue.concurrency,
    successCount: driveQueue.successCount,
    failureCount: driveQueue.failureCount,
  }
}
