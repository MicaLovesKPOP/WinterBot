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

## Availability interaction test

1. Open the private editor from the invitation.
2. Edit Multiple Days to apply one answer to several dates.
3. Edit a Day for confirmed and tentative windows, and copy that day to others.
4. Try 12-hour and 24-hour clocks and five-minute increments.
5. Review all dates before submitting; missing days prevent submission.
6. Edit a submitted response; the old submission stays intact until re-reviewed.
7. Save My Usual Week and reuse it in a second test round.

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