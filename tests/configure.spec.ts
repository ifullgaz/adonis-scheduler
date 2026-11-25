import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import Configure from '@adonisjs/core/commands/configure'
import type { ApplicationService } from '@adonisjs/core/types'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { restoreTestApp } from './helpers/app.js'

test.group('configure', (group) => {
  group.each.timeout(20000)

  test('registers the package and writes the config and migration', async ({ assert }) => {
    const host = await createHostApp()
    let app: ApplicationService | undefined
    try {
      app = await bootHost(host.url)
      const ace = await app.container.make('ace')
      const command = await ace.create(Configure, ['@ifullgaz/adonis-scheduler'])
      command.ui.switchMode('silent')

      const { configure } = await import('../configure.js')
      const result = await configure(command)

      assert.isUndefined(result)
      const rc = await readFile(join(host.directory, 'adonisrc.ts'), 'utf8')
      assert.include(rc, '@ifullgaz/adonis-scheduler/provider')
      assert.include(rc, '@ifullgaz/adonis-scheduler/commands')

      const config = await readFile(join(host.directory, 'config', 'scheduler.ts'), 'utf8')
      assert.include(config, "import { defineConfig } from '@ifullgaz/adonis-scheduler'")
      assert.include(config, 'scheduler:cache')
      assert.include(config, 'lockTtl: 10')

      const migrationsDir = join(host.directory, 'database', 'migrations')
      const files = await readdir(migrationsDir)
      assert.lengthOf(files, 1)
      assert.match(files[0], /^\d+_create_schedules_table\.ts$/)
      const migration = await readFile(join(migrationsDir, files[0]), 'utf8')
      assert.include(migration, "protected tableName = 'schedules'")
      assert.include(migration, "table.tinyint('status')")
    } finally {
      try {
        if (app) {
          await app.terminate()
        }
      } finally {
        restoreTestApp()
        await rm(host.directory, { recursive: true, force: true })
      }
    }
  })
})

async function createHostApp() {
  const directory = await mkdtemp(join(tmpdir(), 'adonis-scheduler-host-'))
  const url = pathToFileURL(directory)
  url.pathname = `${url.pathname}/`

  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify({ name: 'scheduler-app', private: true, type: 'module' }, null, 2)}\n`
  )
  await writeFile(
    join(directory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ESNext',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: true,
        },
        include: ['adonisrc.ts'],
      },
      null,
      2
    )}\n`
  )
  await writeFile(
    join(directory, 'adonisrc.ts'),
    `import { defineConfig } from '@adonisjs/core/app'

export default defineConfig({
  providers: [() => import('@adonisjs/core/providers/app_provider')],
})
`
  )

  return { directory, url }
}

async function bootHost(appRoot: URL) {
  const app = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .create(appRoot, {
      importer: (filePath) => import(filePath),
    })
    .createApp('web')

  await app.init()
  await app.boot()
  return app
}
