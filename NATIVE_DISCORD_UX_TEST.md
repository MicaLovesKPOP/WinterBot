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

## Availability interaction test (redesigned week-first editor)

The overview is one consistent Components V2 panel. The normal path does NOT
replace the whole page whenever you choose a date. The native modal opens
directly. The message only redraws when you actually save an answer or open
the final review.

1. Open the private weekly overview from the invitation.
2. Under Edit several days, select multiple dates. Choosing dates acknowledges
   without redrawing the message. Then choose Hours to open one modal, or use
   the All Day / Unavailable quick actions for the selected dates.
3. Under Edit one day, select a date. The time editor opens immediately in a
   Discord modal. Choose Available, Tentative, All Day or Unavailable.
4. More Day Tools gives access to extra time windows, duration caps and Copy to
   Days, available only from the selected source date's detail view.
5. Try 12-hour and 24-hour clocks, five-minute precision, and Undo.
6. Review all dates before submitting; missing days block submission.
7. Edit a submitted response; the old submission stays active until re-reviewed.
8. Save My Usual Week, then reuse it in a new round.

Expected improvement: ordinary multi-day edits need far fewer message redraws
and interface changes than the original pilot. Native Discord interactions
still involve network latency; real desktop/mobile testing remains necessary.

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