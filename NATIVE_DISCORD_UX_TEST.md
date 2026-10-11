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
    /activitytest preview-event
    /activitytest preview-native

The new /activitytest tests command shows available and planned tests.
The preferred availability editor remains /activitytest invite (the Activity).
Use preview-native only to compare native message-based editing with the Activity.

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
- /activitytest reset: resets all **isolated** Activity, native and simulated
  event test stores. Old test invitation/event buttons become obsolete.

## Planned (NOT available yet)

A polished organizer setup flow, attendance-result presentation, participant
voting end to end, check-ins, event-role unlocking, temporary text/voice
channels and moderator-only archives. Build/validate these here before any
real-server integration.

## Verification

    npm ci
    npm test

Do not manually bump package.json or package-lock.json versions.
