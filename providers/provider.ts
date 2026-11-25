import { type ApplicationService } from '@adonisjs/core/types'
import { type SchedulerContract } from '../src/core/contracts/scheduler_contract.js'
import type { SchedulerConfig } from '../src/types/types.js'

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    scheduler: SchedulerContract
  }
}

export default class SchedulerProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton('scheduler', async () => {
      const { default: Scheduler } = await import('../src/core/scheduler.js')
      const config = (await this.app.config.get('scheduler')) as SchedulerConfig
      return new Scheduler(this.app, config)
    })
  }
}
