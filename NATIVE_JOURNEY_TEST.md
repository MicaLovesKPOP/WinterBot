# WinterBot: Complete Native Discord Journey (TEST ONLY)

This experiment restores and connects WinterBot's **existing** organizer
configuration, attendance optimizer, ranked candidate groups and multi-choice
voting rules in a single Discord-message workflow. It then adds an isolated
check-in and event-channel-access simulation. Nothing here creates a Discord
Scheduled Event, assigns roles, creates voice/text channels, or modifies
production scheduling.json.

## Location and commands

Use **Mica's private WinterBot server**, in **#winterbot-testing**:

    /activitytest organizer
    /activitytest results
    /activitytest checkin
    /activitytest tests

Only test-server owner/Manage Server users can create or manage rounds.
Ordinary test-channel members can open invitation buttons and submit their
answers and vote. All custom controls reject other guilds and channels.
The feature is loaded with the existing
`SCHEDULING_ACTIVITY_TEST_ENABLED=1` / `SCHEDULING_TEST_MODE=1` test gates.

The state is in the *ignored and isolated*
`scheduling-private-journey-test.json` file. Activity availability, the
older native preview, the old three-day legacy vote test, and production
scheduling each have their own distinct state files. The Activity does **not**
submit into organizer rounds automatically; participants can explicitly
**Import reviewed Activity week** from a test invitation when the candidate
dates all match their submitted Activity week. Before confirmation the
private preview shows the conservative 5-to-15-minute conversion, excluded
tentative periods and any clipped/dropped windows. The source Activity
submission remains unchanged. The core optimizer still works in
**15-minute** precision; the Activity input UX uses 5-minute editing.

## Suggested complete test (organizer and participants)

1. In the private channel, run **/activitytest organizer**. Choose
   **Create planning round**. Enter a name, the first candidate date, 1–14
   days, event hours, and expected duration. Defaults: next Monday, 7 days,
   12:00–24:00, and 120 minutes. The resulting private organizer summary
   has an **Advanced settings** modal, separated from the normal setup.
2. Advanced allows a minimum/maximum duration, minimum required attendance
   (default 5), collection and voting deadlines, and 15/30/60-minute
   candidate start precision. Settings lock after responses begin.
3. Publish the test invitation in **#winterbot-testing**. It has two
   participant options:
   - **Enter test availability** opens an ephemeral native-message editor.
     Mark every day available or unavailable; the time modal supports up to
     two windows and an optional continuous-stay cap. **Review** is mandatory
     before **Confirm & submit**. No member counts until confirmation.
   - **Import reviewed Activity week** loads only your own previously
     submitted/confirmed Activity week. A review lists the original eligible
     dates, conservative 15-minute rounded confirmed windows, excluded
     tentative windows and any dropped minutes. Click **Confirm imported
     availability** to add it to this planning round. The dates must match
     the Activity submission; missing dates are NEVER assumed unavailable.
     The original Activity submission stays unchanged.
4. To test with meaningful data alone, use **Load 8 sample attendees**.
   Their names are explicitly marked `[SAMPLE]` and are not real Discord
   users. The sample action is one-time, test-only and does not grant roles.
5. Choose **Close collection / Results**. The actual optimization engine
   ranks eligible candidate groups by full-duration attendance. Its normal
   target of five groups and 90%-of-best criterion remain intact, with an
   additional moderator minimum-attendance threshold.
6. Select one or more candidates. Use **Choose exact start times** to pick
   a start within each grouped range (pagination is available for long
   ranges). For multiple candidates choose **Put selected times to vote**,
   or for one choose **Approve 1 test event**.
7. The vote publishes a separate message to this private channel.
   Participating members may approve any number of options, including none,
   and change their vote before closure. Moderators close voting. The
   existing engine preserves ties and does not exclude unvoted candidates.
   Voted-on winning start times are locked.
8. Select a final candidate and **Approve 1 test event**. This publishes
   a **simulated event and check-in invitation** to the private channel.
   It never creates a real Discord Scheduled Event.

## Check-in, channels, overtime and ending

Use **/activitytest checkin** or the event's private moderator controls.
The simulator demonstrates:

- Check-in normally opens **30 minutes before** the event, and can be
  opened immediately by a test moderator for hands-on testing.
- A check-in records which participant would gain the event role and
  unlock the configured text/voice channels. The role is **simulated**, not
  actually granted. A moderator can explicitly test with their own account
  as an override even if they weren't counted as available.
- **Advanced channel settings** are optional. Defaults: event chat, voice
  and check-in channel on, temporary chat, late check-in on, overtime
  manual, grace **5 minutes**. You can toggle persistent moderator-only,
  read-only chat archives, whether late check-ins remain open, and grace
  0/1/2/3/5/10/15 minutes. These do NOT create real channels.
- The moderator can start the simulated event, begin wrap-up, extend grace,
  cancel ending, or confirm **End Now**. New check-ins stop during grace.
- When overtime is disabled, the simulation automatically starts the grace
  period at the scheduled event end. When overtime is enabled (default),
  only a moderator starts ending.
- On closure, temporary participant access is marked revoked; persistent
  chat would be archived read-only for moderators. The bot's real permission
  overwrites remain untouched.

The timer checks due deadlines approximately every 10 seconds. It also
closes collection and ballots after their configured deadlines, including
following bot restarts.

## Other commands and reset

- `/activitytest invite`: preferred calendar Activity, separately testable.
- `/activitytest preview-native`: older standalone message editor.
- `/activitytest preview-event`: standalone event-ending UI comparison.
- `/activitytest vote`: older three-day legacy vote logic trial (not the
  integrated journey described here).
- `/activitytest reset`: clears **all isolated test stores** including
  these integrated planning journeys. It never deletes real Discord events.

## Remaining production work

1. After validating the explicit read-only Activity import bridge,
   automate the opt-in association of reviewed Activity submissions with a
   selected organizer round, and upgrade the optimizer to handle full
   5-minute precision and tentative semantics natively. Import currently
   floors/ceils hours INWARD to avoid overstating confirmed availability.
2. Replace simulated check-in / access outcomes with carefully permissioned
   creation of *real test-server-only* event roles and channels; test
   permission inheritance and cleanup before any public rollout.
3. Finish reminders, notification preferences, official Scheduled Event
   discoverability, owner-provided defaults and organizer archive UX.
4. End-to-end production check with authorization before touching Crashday
   roles, events or channels.

Run `npm test` and inspect `tests/nativeJourney.test.js` for journey
invariants, access controls, persistence and simulated lifecycle tests.
