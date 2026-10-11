# WinterBot native Discord controls - isolated test guild

The native-message UX and simulated event-shutdown prototypes are now
registered **only in Mica's private WinterBot test server**. They no longer
register experimental /schedule subcommands in the Crashday guild.

- Test guild: 818423564901416991
- Test channel: #winterbot-testing (1558470955930755162)
- Boot prerequisites: SCHEDULING_ACTIVITY_TEST_ENABLED=1 with the existing
  opt-in scheduling TEST-mode configuration.
- Test records are stored separately from all main-server scheduling data.
- No real Discord Scheduled Events, check-ins, roles, channels, permissions,
  or registrations are created by these prototypes.

## Launch

As the test-server owner or a moderator with Manage Server permissions,
use the following commands **in #winterbot-testing**:

    /activitytest tests
    /activitytest organizer
    /activitytest results
    /activitytest checkin
    /activitytest preview-event
    /activitytest preview-native

The /activitytest tests command shows available and planned tests.
The connected organizer → invitation → attendance results → voting → check-in
simulation is described in **NATIVE_JOURNEY_TEST.md**. It restores existing
optimizer/voting engine functionality and adds native-message controls.
The preferred availability editor remains /activitytest invite (the Activity).
A participant can **explicitly import** their reviewed Activity week via a
native organizer invitation, after inspecting 5-to-15-minute conversion and
excluded tentative periods. Nothing imports automatically.
Use preview-native only for the old message UX comparison.

Any private test-channel member can open the native availability invitation and
edit their own ephemeral draft. Only test moderators can post invitations or
operate the simulated event-ending controls. Interaction IDs from another
guild/channel are ignored. The private native drafts live in a separate
scheduling-native-isolated-test.json file (or under the test fixture's native
store path) and are never consumed by the production optimizer.

## Event lifecycle preview

The /activitytest preview-event command creates a simulated control message.
Try the grace-period selector (0, 1, 2, 3, 5 default, 10, 15 minutes), start
ending the event, extend by 1/5 minutes, cancel ending, or confirm End Now.
A timer updates the simulated event to Closed when the deadline expires.
No Discord Scheduled Event or event channel is created or deleted.

## Older native availability comparison

The /activitytest preview-native command posts a seven-day test invitation
with a private Discord Components V2 editor.

1. Open the test message with the private-editor button.
2. Select one or more days; set hours, All Day or Unavailable.
3. Add confirmed/tentative windows, and copy from a completed source date.
4. Review the entire week before confirming a TEST submission.
5. Try a saved usual week and a revised submission.

The Activity remains the primary, more polished availability interface.

## Existing isolated commands

- /activitytest invite: current Discord embedded Activity for availability.
- /activitytest next-week: move its test week forward; keep personal templates.
- /activitytest status: checks Discord Activity configuration.
- /activitytest vote: separate legacy scheduling/vote algorithm test, **not**
  connected to the new Activity's submitted weekly availability.
- /activitytest reset: resets all **isolated** Activity, native, connected
  planning-journey and simulated event test stores. Old buttons become obsolete.

## Simulated vs real behavior

The organizer setup, ranked attendance suggestions and optional preference
voting now have a connected native-message **test journey** backed by the
existing scheduling core. Check-ins, event roles, private channels, overtime,
grace periods, and moderator read-only archives are **simulated only**;
Discord permissions, roles, channels and real events are not altered.

Still pending: connecting the preferred Activity submissions to that round,
actual test-server role/channel lifecycle validation, and production rollout.
See **NATIVE_JOURNEY_TEST.md** for a precise test plan and known boundaries.

## Verification

    npm ci
    npm test

Do not manually bump package.json or package-lock.json versions.
