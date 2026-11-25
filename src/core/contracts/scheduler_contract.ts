export interface SchedulerContract {
  stop(): Promise<void>
  start(): Promise<void>
}
