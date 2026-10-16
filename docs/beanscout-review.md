# BeanScout feature review and integration

Reference: [Calatrux/BeanScout](https://github.com/Calatrux/BeanScout), commit
`22f10a3337da5eab9b22e7675c311004ee07aa47`, inspected October 16, 2026.
The reference checkout is in the ignored `.local/beanscout-reference` folder.
This implementation adapts its workflows into the existing app; it does not
install a second Next.js app, authentication system, theme, or database schema.

## Source feature inventory

| Source area | Behavior in BeanScout | Integration decision |
| --- | --- | --- |
| `QualScoutForm.jsx`: event and match setup | Debounced TBA event loading; cached event info, teams and qualification schedule; persisted event and alliance; automatically loads three alliance robots | Uses this app's imported event/schedule and a match/alliance selector. Offline cached schedules work. Playoff match keys also remain distinct. |
| Overall subjective ranking | Three robot cards, ordered best to weakest; desktop drag, touch movement, and up/down buttons; per-robot written justification | An always-visible matrix explicitly assigns ranks 1–3 to the three robots. Selecting a used rank swaps ranks. All three overall ranks are required. |
| Skill rankings | Separate alliance-relative agility, field awareness and driver ability ranks; no duplicate rank within a skill; ranks can remain unobserved | Preserved as separate matrix rows, with unknown values excluded from averages. Mobile shows all three team numbers and rank choices together. |
| Characterization | Offense, defense, mobility and reliability categories, selected-tag counts and toggle buttons | Preserved, plus teamwork/passing tags and custom tags. Expanded categories survive edits. |
| Attention/status | Star each robot, no-show and incapacitated flags | Preserved per robot and included in the evidence summary. |
| Qualitative submission | Scouter attribution, local-first saving, remote sync with timeout; advances to the next qualification match | Drafts autosave locally. Three ranked observations submit in one database transaction, can queue offline, and retry idempotently. Match selection remains explicit to avoid accidental advancement while reviewing evidence. |
| Autonomous path capture | Field clicks, normalized coordinates, blue/red mirroring, historical overlays, undo/redo, flips, detected starting/end zones and midline flag | Excluded as requested. No map, path coordinates, starting-location inputs, or midline inputs were added. |
| `TeamNotesForm.jsx` | Three alliance robots; text, significant-update and no-significant-change choices; defense observation and minimal/decent/impactful/shutdown effectiveness; stars; local sync | Team notes can be event-wide or match-specific. Significant updates stand out and sort first in evidence. Defense and stars are preserved. An unchanged robot need not receive another note. |
| `PicklistForm.jsx`: personal lists | Multiple named lists per event/scouter; create, rename, delete; event team search; add/remove robots; ordered drag, touch or arrow moves; timestamped notes | The new selection section provides event-wide collaborative lists, per user request. Multiple lists, custom names/columns, duplication, drag, arrows, direct-position moves, per-robot notes, discussion and deletion are supported. |
| `AnalysisDashboard.jsx`: team rankings | Average overall and skill ranks, counts, stars, aggregated tags; AND tag filters; sort by rank, skills, name/number, stars or observation count | Qualitative Team insights includes search, tag filtering, rank/count/star sorting, average skills, stars and evidence. Team popups in selection combine these with quantitative metrics. |
| Analysis evidence | Expandable team cards, match/scouter attribution, ranking notes, status/tag badges, significant updates and defense distributions | Preserved in readable team evidence cards and the selection popup. Multiple scouters' perspectives remain separate. Repeated data for one scouter/robot/match uses the latest submission. |
| Analysis team-wide picklists | Lists with `TEAM_WIDE` scouter marker, admin controls, order and notes | Replaced by a shared event workspace with explicit editor/viewer permissions, live updates, presence, operation history and protected undo. |
| `AutonsTab.jsx` | Team/match path cards, expanded modal, animated path playback with pause/reset, Escape dismissal, deletion of only the selected robot's path fields | Excluded with the pathing feature. Existing administrator match-entry deletion remains available. |
| `PrescoutingForm.jsx`: setup | Event/team/match/alliance setup, cached event name, assigned-team shortcuts | Current quantitative assignment and TBA robot selection remain the source of quantitative data. No second quantitative entry app was introduced. |
| Prescouting performance | Setup/auton/teleop phases; six cycle-size bins; passing timer and pass bins; trench and bump counters; start/end zones; autonomous/endgame climb levels | Current direct fuel/passing counts and ±1 crossing controls are retained. Manual cycles, starting locations and all climbing remain excluded under the existing requirements. Estimated cycles remain trunc(0.9 × crossings). |
| Prescouting analysis/export | Per-event robot averages; raw event/all-event CSV exports of the stored bin/timer fields | Existing quantitative analytics remain authoritative. New exports cover subjective rankings, draft board and configured picklists, using current metrics rather than legacy cycle bins. |
| Source authentication | Supabase Auth, first/last name, username/email/password signup, profiles and scouter/admin roles, profile retries and auth timeout, offline gate, sign-out | Current shared login, required names, settings, password changes, sessions and permissions are retained. No alternate login or offline password was added. |
| `Nav.jsx`, route pages and layout | Role-aware desktop links, mobile navigation, profile menu, homepage entry cards, unauthorized page, protected page wrappers | Existing application navigation gains a distinct Alliance selection section. Alliance plans remain available separately. |
| IndexedDB and `SyncBanner.jsx` | Versioned stores for qualitative entries, team notes, personal picklists, prescouting and TBA cache; timeout handling, pending counts, manual and reconnection sync | Current stores remain intact; schema version 2 adds qualitative groups and team notes. Qualitative work queues locally. Shared selection edits use server-confirmed operations instead of offline whole-list upserts. |
| TBA/cache utilities | Client API calls, normalized team/match data, event cache and event-team fallback | Reuses the existing server-only TBA integration and importer. No public API key is introduced. |
| PWA, worker, icons and styles | Install metadata, offline navigation/static caching, periodic worker update; Geist fonts, custom theme and responsive cards | Current protected shell, Chewy, official logo and Bean colors remain. New modules/assets enter the existing offline shell cache. |
| Debug utilities, config and schema | Diagnostic logging, static Next export/trailing slashes, Supabase table/index/RLS definitions | Current Node/Vercel deployment and private PostgreSQL schema remain. New additive migrations cover only the new functionality. |

The reference picklist write paths save/upsert snapshots and do not subscribe
to live changes. Its application schema file also does not fully define every
profile/picklist dependency used by the components. The integration therefore
uses the current application's authentication and an additive, tested schema,
rather than copying the reference deployment setup.

## Added alliance-selection workflow

- A separate **Alliance selection** page, with an 8 × 3 draft board by default.
  Columns are captain, first pick and second pick; the optional fourth column
  is third pick. Row count is configurable from 1–16.
- An event-team pool excludes selected robots. Choose a pool robot then a slot,
  or choose a slot and type a number. Robots can move or swap; each can occupy
  only one slot. Occupied-slot replacement and occupied-layout removal require
  a concrete confirmation. Marking a robot unavailable is a planning aid and
  does not implement an event rulebook.
- Multiple shared offense, defense, passing or custom lists. Manual ordering,
  metric ordering, configurable columns, per-team notes, shared discussion,
  duplication, selected-robot indicators and CSV export are supported.
- Search suggestions open a team overview on click or Enter, with keyboard
  navigation. Overviews combine fuel/passing OPR, autonomous/teleop fuel,
  passing, reliability, estimated cycles, subjective skills, defense, stars,
  statuses and written evidence. Relative colors invert rank metrics because
  lower ranks are better. Missing benchmarks stay neutral.
- The fuel blend uses the same account/event weight as analytics, initially
  50/50. Passing OPR is the one-hot least-squares estimate of fuel passed,
  equivalent to the robot's qualification-match mean. It does not require an
  official passing statistic or a prior TBA score pull.

## Collaboration and data integrity

All editors/viewers for an event see the same board and lists. Visible workspaces
check for shared changes every two seconds; presence refreshes every 15 seconds
and expires after 45 seconds. Scouting summaries refresh every 30 seconds and
can be refreshed manually. The UI shows disconnected/cached state explicitly.

The server applies individual operations under a workspace row lock. Independent
additions and notes can merge; slot assignments check expected occupants and
source positions, reorder/configuration operations check list revisions, and
notes check their prior text. A conflict preserves the latest server state and
the user's unfinished input. Undo requires the latest shared revision.

Operation IDs make retries safe when the server committed but its response was
lost. A pending confirmation is retained on the device; retrying it cannot add
a second comment or repeat a move. New shared edits are disabled offline.
Qualitative observations and notes can still be collected offline and sync later.

`scouting:alliances` and scouting/portal administrators can edit selection.
Analytics users can view selection and team data. Quantitative-only users cannot
access it. Qualitative entry remains controlled by `scouting:qualitative`.
All mutations require a live session and CSRF token; browser database roles have
no access to the new private tables.

## Validation

The automated tests cover subjective-rank uniqueness and unknowns, schedule
membership, atomic three-robot submission/rollback, immutable submissions,
notes and significant updates, viewer/editor separation, simultaneous additions,
competing slot assignments, stale reorders and notes, idempotent requests and
undo protection. NumPy tests cover passing OPR before official results and
alliance-editor access without administrator-roster access.

Browser checks use an isolated PostgreSQL test database and real NumPy code:
qualitative local autosave, reload, offline submission/reconnection, mobile
rank visibility, team notes/insights, two-session live collaboration, keyboard
and click previews, typed/pool assignments, four-column boards, list changes,
notes/comments, duplication/deletion/undo, CSV downloads, read-only permissions,
dark mode, disconnected controls and a committed request with a lost response.
