# Team 1833: Supabase + Vercel setup

The current app uses Vercel Node.js functions for the shared login, role
management, and `/scouting`. Supabase hosts PostgreSQL. No Azure VM, Docker
service, Caddy process, or Azure credentials are needed to run it.

The repository-root `vercel.json` is the deployment definition. `api/index.mjs`
routes to `lib/portal.mjs` and `lib/scouting.mjs`. The protected scouting shell
and APIs are all under `/scouting`; the portal remains at `/`, `/signup` and
`/admin`. Existing email/password accounts and permission names can be retained
by importing the old database. Passwords remain Argon2 hashes and sessions stay
in PostgreSQL. This implementation uses Supabase's **database**, not Supabase
Auth: do not set up a second login or publish Supabase service keys in the browser.

## Fix an immediate 503 on login or backend requests

`DATABASE_URL` is required. The runtime connects directly to PostgreSQL using
`pg`; it does not read `SUPABASE_JWT_SECRET`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`,
`NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Those API keys
cannot be converted into a database password or connection string.

1. In Supabase, open **Connect > Transaction pooler** and copy the PostgreSQL
   URI. Replace the password placeholder with the **database password**, URL-encoded.
2. In Vercel **Settings > Environment Variables**, add `DATABASE_URL` for
   **Production**. Set it for Preview too if deploying previews, using the
   appropriate preview database. Keep the actual URI private.
3. Apply the application schema with `npm.cmd run db:migrate`, using a private
   `.env.local` as described below. Alternatively, for a new database, run the
   contents of `supabase/migrations/202610150001_tools.sql` in Supabase's SQL
   Editor. Creating a Supabase project alone does not create these tables.
4. Redeploy in Vercel so the function receives the new environment variables.
5. Visit `/scouting/api/health`. A `200` with `"ok":true` confirms the database
   connection and required application tables/columns can be read. Then sign up
   and sign in. Accounts live in `shared_login.portal_users`, so accounts created
   only in Supabase Auth cannot sign in here.

Vercel builds reject a missing or malformed `DATABASE_URL` without connecting to
the database. The health check reads no account data and makes no schema changes.
Locally, `npm.cmd run db:check` checks the connection and schema using
`DATABASE_URL`, matching the runtime rather than `MIGRATION_DATABASE_URL`.
Database credentials, network access, and write privileges still need to be valid.
Server logs include safe diagnostic codes and setup advice; browser error
responses keep configuration details private. `42P01`/`42703` mean the schema
needs migration, `28P01` means the database credentials failed, and
`DATABASE_URL_MISSING` means the function has no connection string.

## 1. Create Supabase

1. Sign up at [Supabase](https://supabase.com/dashboard), create an organization,
   and select **New project**.
2. Name it something like `team1833-tools`, choose a region near your users and
   Vercel runtime, and save the database password in your password manager.
   Choose a plan appropriate to your team's usage; check current quotas and
   billing settings before enabling paid options.
3. Once the project is ready, select **Connect**, then **Transaction pooler**.
   Copy the PostgreSQL URI. The shared pooler normally uses port `6543` and a
   username like `postgres.PROJECT_REF`. Use the actual host and project ref from
   the dialog; do not guess them.
4. Replace the password placeholder with your database password, URL-encoded if
   it contains reserved characters. Add `?sslmode=require` if absent. Keep this
   value private; it becomes `DATABASE_URL`.
5. For migrations, also copy the **Session pooler** URI (normally port `5432`)
   as `MIGRATION_DATABASE_URL`. A direct URI works if your machine supports the
   project's IPv6 endpoint. The session pooler works over IPv4.

Supabase recommends the transaction pooler for serverless applications. The
runtime uses one module-scoped connection per warm function and unnamed
parameterized queries, with transaction-scoped advisory locks. It requires TLS
for remote hosts. Optionally set `DATABASE_CA_CERT` to the server root certificate
from Supabase database settings to verify the certificate as well as encrypt
the connection. [Connection instructions](https://supabase.com/docs/guides/database/connecting-to-postgres).

## 2. Prepare the database

Install Node.js 22 on the machine doing setup. From the repository root:

```powershell
npm.cmd ci
Copy-Item .env.example .env.local
```

Edit `.env.local` locally:

```dotenv
DATABASE_URL=your-transaction-pooler-uri-with-sslmode-require
MIGRATION_DATABASE_URL=your-session-pooler-uri-with-sslmode-require
COOKIE_SECURE=false
SESSION_TTL_HOURS=12
TBA_API_KEY=your-private-TBA-read-key
```

Use `COOKIE_SECURE=false` only for local HTTP development. Vercel gets `true`.
`.env.local` is ignored by Git and by the Vercel upload configuration. Do not
commit it or paste its contents into chat. This project needs neither a Supabase
publishable/anon key nor a browser-side database connection.

If importing Azure users/records, follow the optional migration section below
**before** applying the new schema. Otherwise start fresh:

```powershell
npm.cmd run db:migrate
npm.cmd run db:check
npm.cmd run check
npm.cmd test
npm.cmd run build
```

`db:migrate` applies versioned SQL in `supabase/migrations` once, under a database
lock and transaction. It creates the private `shared_login` and `scouting`
schemas, keeps existing users and records, and changes submission uniqueness
to include event and quantitative/qualitative record type. It does not create
an Azure resource. Normal application requests do not run migrations.

For local use, run `npm.cmd run dev`, then visit `http://localhost:3000`.
On macOS/Linux use `npm` instead of `npm.cmd` and `cp` instead of `Copy-Item`.
The Node handler supports both local Node HTTP and Vercel's parsed request bodies.

## 3. Create the Vercel project

1. Push the updated code to your team's Git repository. Keep secrets and backups
   out of Git. No commit or push is performed automatically by this task.
2. Sign up at [Vercel](https://vercel.com/new), connect the Git provider, and
   import that repository. [Vercel getting started](https://vercel.com/docs/getting-started-with-vercel).
3. Set **Root Directory** to the repository root, not `scouting` or `legacy`.
   Select **Other** for the framework if prompted. Use Node.js **22.x**.
4. Keep the settings from `vercel.json`: build command `npm run build`, output
   directory `dist`. The build creates only a robots file in `dist`; protected
   app files are bundled into the Node function rather than served publicly.
5. Add the production environment variables below, then deploy. Environment
   variable changes require a new deployment. Use a separate database/project
   for previews if other contributors can deploy preview code; do not give
   untrusted previews the production database password.

| Variable | Production value |
| --- | --- |
| `DATABASE_URL` | Supabase transaction pooler URI with TLS |
| `COOKIE_SECURE` | `true` |
| `SESSION_TTL_HOURS` | `12` |
| `TBA_API_KEY` | Private TBA Read API key, optional if supplied during each import |
| `DATABASE_CA_CERT` | Optional Supabase root certificate PEM; enables certificate verification |

`MIGRATION_DATABASE_URL` is used by local setup scripts; it does not need to be
added to Vercel. Never prefix database or TBA secrets with `PUBLIC_` or
`NEXT_PUBLIC_`. [Vercel environment variables](https://vercel.com/docs/environment-variables).

The Vercel function duration is capped at 60 seconds. Event import fetches TBA
metadata, teams and matches, then writes the schedule in bulk. No background
server, in-memory session store or local database is required.

## 4. Grant the first administrator

1. Open the Vercel deployment URL and create your account through **Sign up**.
2. On your setup machine, with `.env.local` pointing to the same Supabase
   project, run:

```powershell
npm.cmd run admin:grant -- your-existing-signup-email@example.org
```

3. Sign in and open `/admin`. The grant command preserves the password and
   sessions, requires an active existing account, and grants only `portal:admin`.
4. Grant your own account `scouting:read` and the areas you need. New accounts
   receive no permissions automatically. Removing the last active website
   administrator is blocked.

| Permission | Access |
| --- | --- |
| `portal:admin` | Manage all website users' permission grants |
| `scouting:read` | Required for `/scouting`, quantitative observations and own-record uploads |
| `scouting:qualitative` | Qualitative observations, tags and notes |
| `scouting:analytics` | Event analytics, comparisons and team/match drilldowns |
| `scouting:sync` | Review and synchronize team records |
| `scouting:alliances` | Read and create event alliance plans |
| `scouting:manage` | Import events and manage scouting rotations |

Website administrators can also manage events and rotations when they have
`scouting:read`. They do not automatically receive the other area permissions.

### Quantitative-only accounts and robot assignments

Accounts whose only permission is `scouting:read` select an imported event and
enter a qualification match number. The server resolves the robot from that
account's event station: Red scout 1/2/3 or Blue scout 1/2/3, in TBA alliance
order. The page previews the robot and keeps its team number and alliance
visible while scouting. Robot, alliance, event-key and playoff-key inputs are
not offered to these accounts. An account without an event station or published
match cannot begin a new observation. Scouting begins directly in autonomous.

Any permission in addition to `scouting:read` keeps manual robot and match
selection, including playoffs and unscheduled matches. This override does not
grant permission to manage users, events, or other scouting areas. Submission
locks and schedule validation still apply.

In `/admin`, first grant quantitative scouting access, then use **Event scout
stations** on the user's account to set or remove their station. One rotation
group covers every qualification match. For larger crews, set a common total
group count and assign each user a group. Duplicate stations within a group
are rejected. Use **Scouting administration** to change all event groups together.

The shared assignment rules are enforced on the API as well as in the UI.
Offline work uses the last cached schedule; synchronization checks current
assignments again. If assignments change, a mismatched saved draft is preserved
on the device and flagged for administrator review.

The TBA key can be provided through `TBA_API_KEY` or stored in the private
`shared_login.service_settings` table by a trusted database administrator.
The environment variable takes precedence. Migration
`202610150002_server_settings.sql` creates this table with RLS enabled and no
browser-role access. Keys are never returned in API responses or bundled into
browser assets. An API key supplied in the import form applies to that import.
When a scout resolves a match online, schedules older than five minutes are
refreshed from TBA if a server key is configured. Reimport the event manually
to refresh event/team names too. The supplied project key has been configured
in the existing Supabase database; new databases need their own configuration.

## 5. Import the event and assign rotations

1. Obtain a Read API key from your [TBA account](https://www.thebluealliance.com/account).
   Set `TBA_API_KEY` in Vercel, or paste it into the password field for one import
   in **Scouting administration**. The API key is not stored in browser storage
   or in event rows. [TBA API v3](https://www.thebluealliance.com/apidocs/v3).
2. Enter the actual 2026 event key and choose **Import event, teams and matches**.
   This imports team names, qualification/playoff match keys and both alliances.
   Reimporting updates the schedule while retaining scouting records.
3. Give assigned users `scouting:read` in `/admin`.
4. In **Scouting administration**, choose a total number of rotation groups and
   add each scouter's group, red/blue alliance and driver-station slot (1–3).
   Each account gets one slot per event, and each group/color/station has one
   assigned scouter. The UI reports unfilled slots after saving.
5. For two groups, group 1 scouts qualification matches 1, 3, 5… and group 2
   scouts 2, 4, 6… . The imported alliance station supplies the robot number.
   Assigned quantitative matches appear on that user's page. Completed cards
   are gray and disabled; the API also enforces assignments and immutable
   submission locks. Playoffs use manual selection with the imported match key.

No schedule yet? Users with additional permissions can start observations
manually with a 2026 event key, match number/key, robot and alliance.
Quantitative-only users need an imported schedule and an assigned station before
they can start.

## 6. Connect tools.team1833.org

First verify the Vercel project URL, shared login, role grants and `/scouting`.
Then add `tools.team1833.org` under the Vercel project's **Settings → Domains**.
At your current DNS provider, update only the `tools` record using the exact
record shown by Vercel. Keep other Team 1833 DNS records unchanged. Vercel
provides HTTPS after domain validation. Users sign in again on the custom
hostname because cookies are host-only.

Moving hosting does not automatically stop Azure billing. Review the old Azure
resources separately when you can access them; no resources were stopped,
removed or resized by this refactor.

## Optional: keep Azure accounts and scouting data

If Azure is inaccessible until credits return, the new app can start with an
empty Supabase database. Existing Azure data has not been copied by this task.
Browser-local records stay in IndexedDB on their original browser **and origin**;
an Azure-provided hostname and a Vercel hostname have separate browser storage.
Preserve the original browser and hostname until pending data is synchronized.

If you want to retain existing accounts, import the private application schemas
into an **empty** Supabase project before signing up or running `db:migrate`.
Preserving numeric user IDs avoids attributing an old local record to a different
new account. Do not merge independent databases by reusing numeric IDs.

Use the standard PostgreSQL `pg_dump`/`pg_restore` tools, with credentials in
your local connection service/password files rather than command arguments.
If they are missing, install PostgreSQL client tools first. These examples use
local `pg_service.conf` entries named `team1833_azure` and `team1833_supabase`:

```sh
pg_dump --dbname="service=team1833_azure" --format=custom --no-owner --no-privileges --schema=shared_login --schema=scouting --exclude-table=shared_login.portal_sessions --file=backups/team1833-tools.dump
pg_restore --dbname="service=team1833_supabase" --no-owner --no-privileges --single-transaction --exit-on-error backups/team1833-tools.dump
npm run db:migrate
```

Create the ignored `backups` directory first. The dump includes password hashes,
email addresses and permission grants: keep it private. Old sessions are
excluded so everyone signs in again. Use the session/direct Supabase connection
for restoration. There is no `--clean` flag; restore into an empty project.
If the new project already contains accounts or records, stop and plan an ID
mapping instead of overwriting it. Legacy records without an event appear
under **Legacy records**, separated from 2026 event leaderboards. Missing new
fields such as passing counts remain unknown in legacy analytics, not zeros.
[Supabase migration reference](https://supabase.com/docs/guides/platform/migrating-to-supabase/postgres).

## Analytics and scoring conventions

- Quantitative observations count active-hub fuel, passed fuel, bump/trench
  crossings and robot status. Crossings have only +1 and -1 controls. Starting
  location, climbing, manual cycle counts and separate endgame fuel are omitted.
  Inactive-hub fuel is also omitted. Older JSON fields are retained for existing
  saved matches but do not appear in the scouting form or analytics metrics.
- Cycle estimates are computed per match as
  `Math.trunc(0.9 * (autoBumpCrossings + autoTrenchCrossings + teleopBumpCrossings + teleopTrenchCrossings))`.
  Team averages use those per-match estimates. Missing historical crossing
  counts remain unknown. Historic observed cycle inputs are ignored.
- Estimated fuel per cycle is total active-hub fuel divided by estimated cycles.
  Zero or unknown estimated cycles yield an unknown ratio.
- The stacked chart separates autonomous and full teleop fuel points. Point
  estimates include active-hub fuel only, at one point each; historic climbing
  data is ignored. Passing and inactive-hub fuel earn no points in these
  estimates. Existing raw records are retained. These are scouting estimates,
  not official match scores or TBA OPR.
- Reliability is normal observations / all observed matches ×100. Multiple
  scouters observing the same robot/match count once, using the latest observation.
- Analytics selects one event at a time, uses team names and numbers, and supports
  comma-separated searches. Match drilldowns link to the comparison views.
- Each metric has its own per-team match inclusion and symmetric tail-trimming
  controls. Trimming keeps at least one observation. Means, medians, quartiles
  and 1.5×IQR whiskers use the retained sample; raw records remain unchanged.
- Analytics opens with a team leaderboard and separate Bar chart, Box plot,
  Bubble chart and Fuel breakdown views. Sample filters are collapsed below
  the chart. Box plots use actual quartiles, median, non-outlier whiskers and
  outliers, with shared numerical axes. Hover/focus details show exact values.
- Each bubble represents one team. X and Y metrics are selected independently;
  bubble size defaults to matches scouted and can use another metric. Positions
  use team means. Unknown values are omitted, and all-zero or equal-valued data
  keeps a valid scale. Reliability axes run from 0 to 100 percent. Selecting a
  bubble focuses that team's match history.
- Leaderboard colors reflect percentile rank within the event: red below 33,
  yellow from 33, green from 67. Numeric values display two decimal places.
- Qualitative notes and tags have their own page, including retained legacy
  notes. Alliance plans contain up to three event teams and shared strategy.

Offline work uses the cached app shell, schedule and an unexpired snapshot of
the last signed-in account. The server never trusts that snapshot; reconnecting
rechecks live sessions and permissions before synchronizing. Sensitive APIs and
portal pages are not cached by the service worker.

Backend configuration and failure-path tests are included. See [SCRIPTS.md](SCRIPTS.md) for the included commands.

## Accounts and settings

Migration `202610150003_account_settings.sql` adds first name, last name and
account preferences. Apply it before deploying this version. Existing accounts
keep their passwords and permissions; their names remain blank until updated.
New signup requires both names in the form and on the server.

The gear at the top right opens scouting settings. `/settings` also supports
accounts without scouting access. Account settings include names, read-only
email, permissions, appearance, password/security, data/offline tools and About.
Light, Dark and Bean modes apply immediately and persist on the device; changes
also save to the account online. The reduced-motion preference disables motion.

Password changes require the current password, matching new passwords of
12–256 characters, a live session and CSRF protection. Successful changes keep
the current session and revoke other sessions. Failed attempts are rate limited.
Email password recovery is intentionally not implemented, so no mail service
or email credentials are required.

Users can sign out other sessions, download only their own matches, and retry
their own pending matches without additional permissions. Clearing cached
schedules leaves saved matches untouched. The export merges local matches with
their server copies online, retaining the latest revision; offline it exports
the local matches only. No database table or API field names were renamed, so
existing devices and historical matches remain compatible.

## Brand assets

The scouting theme uses the official site's bean blue `#1b97ad` and bean orange
`#f34732`. The masthead [logo](https://www.team1833.org/wp-content/uploads/2024/09/Bean-Logo-White-Number.png),
[favicon](https://www.team1833.org/wp-content/uploads/2024/09/favicon.png), and
[Chewy font](https://www.team1833.org/wp-content/uploads/fonts/Chewy-Regular.ttf)
were copied from [Team1833.org](https://www.team1833.org/) into `scouting/public`
and are bundled/cached for offline use. Chewy's Apache 2.0 license is included
in `CHEWY-LICENSE.txt`. Headings, navigation, main buttons and large numbers use
Chewy; dense text keeps a standard sans-serif font for readability.
