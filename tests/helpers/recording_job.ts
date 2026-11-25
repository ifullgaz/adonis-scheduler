export class RecordingJob {
  static scheduled: unknown[] = []

  static beforeSchedule: (() => Promise<void>) | undefined

  static async schedule(payload: unknown) {
    if (this.beforeSchedule) {
      await this.beforeSchedule()
    }
    this.scheduled.push(payload)
  }

  static reset() {
    this.scheduled = []
    this.beforeSchedule = undefined
  }
}

export class ExplodingJob {
  static async schedule() {
    throw new Error('schedule failed')
  }
}
