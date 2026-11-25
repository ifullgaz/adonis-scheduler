import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { type SchedulerContract } from '../core/contracts/scheduler_contract.js'

export default class SchedulerRunCommand extends BaseCommand {
  static commandName = 'scheduler:run'
  static description = 'Run the scheduler'
  static options: CommandOptions = {
    startApp: true,
    staysAlive: true,
  }

  private scheduler!: SchedulerContract

  async prepare() {
    this.scheduler = await this.app.container.make('scheduler')
    this.app.terminating(async () => {
      await this.scheduler.stop()
    })
  }

  async run() {
    await this.scheduler.start()
  }
}
