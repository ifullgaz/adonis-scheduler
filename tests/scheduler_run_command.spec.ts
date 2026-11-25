import { test } from '@japa/runner'
import type { ApplicationService } from '@adonisjs/core/types'
import type { BaseCommand } from '@adonisjs/core/ace'
import SchedulerRunCommand from '../src/commands/run.js'
import { withClock } from './helpers/clock.js'
import { bindScheduler, getApp, resetStorage } from './helpers/app.js'

const DUE_AT = '2026-11-19T15:30:10.250Z'
const STATUS_RUNNING = 2
const STATUS_TERMINATED = 4

test.group('scheduler:run', (group) => {
  group.each.setup(async () => {
    await resetStorage()
  })

  test('starts the scheduler and stops it when the application terminates', async ({ assert }) => {
    const scheduler = await bindScheduler()
    const app = getApp()
    const hooks: Array<(application: ApplicationService) => Promise<void>> = []
    const terminating = app.terminating.bind(app)
    app.terminating = ((handler: (application: ApplicationService) => Promise<void>) => {
      hooks.push(handler)
      return terminating(handler)
    }) as typeof app.terminating

    try {
      await withClock(DUE_AT, async () => {
        try {
          const command = await run([])
          const state = readState(scheduler)

          assert.equal(command.exitCode, 0)
          assert.isUndefined(command.error)
          assert.equal(state.status, STATUS_RUNNING)
          assert.lengthOf(hooks, 1)

          await run([])
          assert.equal(readState(scheduler).status, STATUS_RUNNING)

          await hooks[0](app)
          assert.equal(readState(scheduler).status, STATUS_TERMINATED)
        } finally {
          await scheduler.stop()
        }
      })
    } finally {
      app.terminating = terminating as typeof app.terminating
    }
  })

  test('describes itself as a long-running command', ({ assert }) => {
    assert.equal(SchedulerRunCommand.commandName, 'scheduler:run')
    assert.equal(SchedulerRunCommand.description, 'Run the scheduler')
    assert.isTrue(SchedulerRunCommand.options.startApp)
    assert.isTrue(SchedulerRunCommand.options.staysAlive)
  })
})

async function run(argv: string[]) {
  const ace = await getApp().container.make('ace')
  const command = await ace.create(SchedulerRunCommand, argv)
  command.ui.switchMode('silent')
  await command.exec()
  return command as SchedulerRunCommand & BaseCommand
}

function readState(scheduler: object) {
  return scheduler as { status: number }
}
