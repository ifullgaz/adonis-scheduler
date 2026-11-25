# Adonis Scheduler

`@ifullgaz/adonis-scheduler` is an AdonisJS integration that stores cron
schedules in the database and enqueues the matching jobs once a minute.

It integrates with:

- `@adonisjs/core`
- `@adonisjs/cache`
- `@adonisjs/lock`
- `@adonisjs/lucid`
- `@ifullgaz/adonis-lucid`
- `@ifullgaz/adonis-jobs`
- `@vinejs/vine`

Requires Node.js 24 or newer and `@adonisjs/core` 7.

## Installation

```bash
npm install @ifullgaz/adonis-scheduler @adonisjs/cache @adonisjs/lock @adonisjs/lucid @ifullgaz/adonis-lucid @ifullgaz/adonis-jobs
```

Install `@vinejs/vine` when you use the create and update validators.

Register the provider and the command in `adonisrc.ts`:

```ts
{
  providers: [
    () => import('@ifullgaz/adonis-scheduler/provider'),
  ],
  commands: [
    () => import('@ifullgaz/adonis-scheduler/commands'),
  ],
}
```

Create a `schedules` table before inserting rows. The `Schedule` model uses
Lucid's default table and column names.

| Column | Model property | Notes |
| --- | --- | --- |
| `id` | `id` | Primary key |
| `cron_expression` | `cronExpression` | Cron expression, parsed by [`cron-parser`](https://github.com/harrisiirak/cron-parser) |
| `tz` | `tz` | IANA timezone passed to the parser (`UTC`, `Europe/Paris`) |
| `job_name` | `jobName` | Job class name. The jobs registry keys jobs by `class.name` |
| `job_params` | `jobParams` | JSON payload passed to `Job.schedule` |
| `status` | `status` | Boolean. The column writes `true` as `1` and `false` as `0`. The runner loads `1` |
| `created_at` | `createdAt` | |
| `updated_at` | `updatedAt` | |

`@ifullgaz/adonis-jobs` must be configured in the same app. A due schedule
calls `Job.schedule(payload)`, which inserts a queue row with a null due
date. `node ace job-queue:run` picks up those rows. `node ace job-queue:run
--timed` leaves them and takes rows whose due date has passed.

## Configuration

Create `config/scheduler.ts`:

```ts
import { defineConfig } from '@ifullgaz/adonis-scheduler'

export default defineConfig({
  cacheKey: 'scheduler:cache',
  lockKey: 'scheduler:lock',
  lockTtl: 10,
  versionKey: 'scheduler:version',
})
```

`defineConfig` returns the same object. It exists so the config file is
type-checked.

| Option | Role |
| --- | --- |
| `cacheKey` | Cache entry that holds the active schedule rows |
| `lockKey` | Lock name. One process holds it and is the process that enqueues |
| `lockTtl` | Duration passed to `string.seconds.parse`, then to `locks.createLock` as a number |
| `versionKey` | Cache entry that stores the version allowed to enqueue |

`lockTtl` follows `string.seconds.parse` from `@poppinss/utils`. A number is
a count of seconds. A string such as `'10s'` or `'1m'` is parsed and
converted to whole seconds. The scheduler multiplies that count by 1000 and
passes the result to `locks.createLock`, which treats a number as
milliseconds. `10` and `'10s'` both become a 10 second lock. While the lock
is held, `extend` runs every half of the parsed seconds (`seconds * 500`
milliseconds), so every 5 seconds for those values.

The version comes from `getCurrentVersion()` in `@ifullgaz/adonis-lucid`.
That helper reads `config/version` (`version`), then
`process.env.npm_package_version`, then the `version` field of the
application `package.json`. The values are compared with semver.

The provider registers the `scheduler` singleton in every environment and
reads `config/scheduler` when that binding is resolved. `start()` and
`stop()` run only when the application environment is `console`. In any
other environment they log and return without changing state. Run the
runner with `node ace scheduler:run`, not from the HTTP server.

## Usage

### Run the scheduler

```bash
node ace scheduler:run
```

The command boots the application, stays alive, and calls `start()`. On
shutdown it calls `stop()`.

`start()` creates a memory lock named `scheduler:stop`, so the lock config
must define a store named `memory`. It then loads the jobs registry, arms
the extend interval, and arms the wake timer. The first wake is the time
left until the next minute. A clock sitting on second 0 and millisecond 0
produces a delay of 0, so the first wake runs on the next turn. `stop()` on
a scheduler that is not running returns without releasing anything.

`stop()` ends the instance. Status becomes terminated. A later `start()` on
the same instance logs that the scheduler already started and returns. Run
a new process (another `scheduler:run`) when you need the runner again.

### One process, newest version

Each wake calls the eligibility check before it loads schedules.

The version gate and the enqueue lock only coordinate across processes when
their cache store and lock store are shared (for example Redis). A
per-process memory cache or memory lock does not give multi-instance
exclusion: every replica can pass the version check and acquire its own
lock, and each will enqueue. Use a shared store for `cacheKey`,
`versionKey`, and `lockKey` whenever more than one `scheduler:run` process
may run. The in-process `scheduler:stop` lock still uses the `memory`
store.

The cached version is created on first read, with this process's version as
the value and `ttl: null`, so the entry does not use the cache store's
default expiry. A process whose version is older than the cached version
skips the wake, releases the lock when this process holds it, and arms the
next wake. A process whose version is newer writes its version over the
cached value with `ttl: null` and continues. Equal versions continue.

The process then tries the lock once, with `acquireImmediately()`. The
process that gets it enqueues. A process that misses the lock skips the wake
and arms the next wake. `start()` also starts an interval that calls
`extend` while this process holds the lock. A failed extend clears the held
flag and tries to release, so a later wake can acquire the lock again.
`stop()` releases the lock when this process holds it.

### What a wake does

The runner loads active rows through the cache. The factory reads `Schedule`
where `status` is `1`, as plain rows. The list is stored at `cacheKey` for
24 hours (`3600 * 24 * 1000` milliseconds).

For each cached row the runner parses `cron_expression` with `tz` and treats
the row as due when the previous occurrence is the current time with UTC
seconds and milliseconds set to 0. The probe is 1 millisecond later, because
`prev()` skips an instant that is exactly the occurrence. The wake runs at
the start of a minute, so that instant is the start of the current minute.
A five-field expression fires at second 0. A six-field expression is due
only when its previous occurrence is that same instant. A minute the process
did not wake for is not replayed. The parser uses the schedule timezone and
does not add a catch-up for a skipped or repeated local hour.

A row that fails to parse is logged as `Cannot evaluate schedule <id>` and
the rest of the minute continues.

A due row resolves `job_name` from `jobsRegistry` and calls `Job.schedule`.
A string `job_params` is parsed when the result is a plain object. A plain
object is passed through. Any other value becomes `{}`. A missing job is
logged and skipped. A throw from lookup or from `schedule` is logged as
`Cannot schedule job <name>` and skipped.

After the rows, the wake arms the next one. The delay is the time remaining
until the next whole minute, measured when the wake finishes. A wake that
runs past the following minute waits until the minute after that. On an
exact minute boundary the first arm uses a delay of 0 and a rearm uses
60 seconds, so the same minute does not run again.

`stop()` waits until the memory lock `scheduler:stop` is free. A wake holds
that lock only while it schedules the due jobs, then releases it. `stop()`
then clears the wake timer, stops the extend interval, releases the
distributed lock, and closes every Lucid connection. A second `stop()`
returns without doing that again.

`clearCache()` deletes `cacheKey`. `Schedule` `afterSave` and `afterDelete`
resolve the `scheduler` binding and call `clearCache()`.

### Store a schedule

```ts
import Schedule from '@ifullgaz/adonis-scheduler/model'

const schedule = await Schedule.store({
  cronExpression: '0 * * * *',
  tz: 'UTC',
  jobName: 'SendReport',
  jobParams: { reportId: 1 },
  status: true,
})

await schedule.update({ status: false })
await schedule.destroy()
```

`Schedule` is a Lucid model with `withScopedModel()`. `store`, `update`, and
`destroy` are provided by that trait. `status: true` is stored as `1`, which
is the value the runner loads. A row saved with `status: false`, or with no
status, stays out of the query.

Saving and deleting clear the schedule cache through `scheduler.clearCache()`.

### Run one schedule now

```ts
await schedule.run()
await schedule.run({ reportId: 2 })
```

`run` merges the argument over `jobParams` and calls `scheduler.schedule`.
Use it from console commands (or any process where the provider is loaded).
It does not start the minute runner. The model value is the JSON column
after consume, so the payload is an object. The call uses the same path as
a due wake: look up the job class and `Job.schedule` it with a null due
date. An unknown job or a throw is logged and does not reject `run`.

### Validate input

```ts
import {
  createScheduleValidator,
  updateScheduleValidator,
} from '@ifullgaz/adonis-scheduler/validators'

const payload = await createScheduleValidator.validate(request.all())
```

Create requires `cronExpression` (trimmed, 1 to 128 characters, accepted by
`cron-parser`, and rejected when it contains `H`), `tz` (trimmed, at most
255 characters, and a timezone Luxon accepts), `jobName` (trimmed, at most
128, and a name `jobsRegistry.hasJob` accepts), and `jobParams` (an object;
unknown properties are kept). `status` is an optional boolean. Update makes
every field optional and uses the same rules. Unknown keys are stripped.

Importing the validators adds `cronExpression()` to Vine strings. `jobName()`
comes from `@ifullgaz/adonis-jobs/validators`, which this module imports.

## Types

```ts
import type { SchedulerConfig } from '@ifullgaz/adonis-scheduler/types'
import type { SchedulerContract } from '@ifullgaz/adonis-scheduler/contracts'
```

`SchedulerConfig` is `{ cacheKey: string, lockKey: string, lockTtl: string | number, versionKey: string }`.

`SchedulerContract` is `start(): Promise<void>` and `stop(): Promise<void>`.
The container binding `scheduler` uses that contract. `schedule` and
`clearCache` live on the `Scheduler` class. The model reaches them by
importing that class.

## Exports

- `@ifullgaz/adonis-scheduler`
- `@ifullgaz/adonis-scheduler/commands`
- `@ifullgaz/adonis-scheduler/contracts`
- `@ifullgaz/adonis-scheduler/model`
- `@ifullgaz/adonis-scheduler/provider`
- `@ifullgaz/adonis-scheduler/types`
- `@ifullgaz/adonis-scheduler/validators`

`@ifullgaz/adonis-scheduler` exports `configure`, `defineConfig`, and
`stubsRoot`. `configure` is the `node ace configure` hook. It registers the
provider and the command in `adonisrc.ts`, writes `config/scheduler.ts`, and
writes a `schedules` migration under `database/migrations`. `stubsRoot` is
the package stubs directory. Application code does not need it.

## Testing

### Prerequisites

Tests require a `NODE_AUTH_TOKEN` with read access to the `@ifullgaz` GitHub Packages registry (see `.npmrc`). Export it before running:

```bash
export NODE_AUTH_TOKEN=<your_token>
```

### Running the suite

```bash
npm test            # lint → c8 coverage → full Japa suite
npm run quick:test  # Japa only, no lint/coverage — use during iteration
```

### Running a single test or group

Pass Japa filter flags directly to the test entry:

```bash
# by group name
node --import=@poppinss/ts-exec --enable-source-maps bin/test.ts --groups "Example"

# by test title (substring match)
node --import=@poppinss/ts-exec --enable-source-maps bin/test.ts --tests "add two numbers"
```
