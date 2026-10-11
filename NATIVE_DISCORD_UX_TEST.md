# WinterBot native scheduling UX pilot

This is an isolated, test-only Discord-components prototype.
It does not create real Discord events, channels, roles, or registrations.

## Start

Run these commands as a moderator in #bot-logs while the scheduler is in TEST mode:

    /schedule preview
    /schedule preview-event

Both commands are absent in normal scheduling mode.
The first command posts a seven-day invitation with a private availability editor.
The second posts a fake event and moderator graceful-shutdown controls.

## Availability interaction test (one date selector)

The weekly overview is a persistent Components V2 panel. There is now only
ONE date selector: choose a single date or multiple dates, then choose Available
Hours, All Day or Unavailable. Changing selection does not redraw the message.

1. Open the private weekly overview from the invitation.
2. Select Monday, Tuesday and Thursday, then use Available Hours. The modal has
   FOUR relevant dropdowns (start/end hour/minute), not five; no separate
   status selector. Existing answers are replaced, with Undo available.
3. Select one date and choose Unavailable. It applies immediately: no needless
   time dropdowns, no modal. Likewise All Day.
4. More Day Tools gives access to additional confirmed/tentative windows,
   maximum-stay limits and Copy to Days from the source date.
5. Try the 12h/24h clock, five-minute precision and Undo Last Edit.
6. Review all answers in the dedicated review stage. The review keeps a date
   selector for quick corrections and stays closer to the overview width.
7. Confirm & Submit, which now shows a distinct submitted receipt rather than
   silently returning to the editing view.
8. Reopen the same invitation or save My Usual Week. Previously submitted
   answers stay active until revisions are reviewed and submitted again.

This UI simplification does not change the core scheduler. The modal warning
about sharing sensitive information is supplied by Discord itself, not by
WinterBot, and cannot be removed by the bot. Discord still requires a server
round-trip for each control. Desktop/mobile usability testing is essential.

## Grace-period interaction test

The grace options are 0, 1, 2, 3, 5, 10 and 15 minutes.
The default is 5 minutes. There is no 30-minute option.
Test start, extend, cancel and immediate closure. The timer closes the fake event.

## Scope boundary

All test data is isolated in scheduling-native-preview.json.
Production availability, voting and registration are unchanged.
Actual check-in, event roles and channel access are future integration work.
Owner defaults and advanced organizer settings also await hands-on UX feedback.

## Verify

    npm ci
    npm test

Do not manually bump package or lockfile versions.