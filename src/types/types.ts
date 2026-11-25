export interface SchedulerConfig {
  cacheKey: string
  lockKey: string
  lockTtl: string | number
  versionKey: string
}
