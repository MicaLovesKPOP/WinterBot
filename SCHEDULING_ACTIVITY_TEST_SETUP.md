# WinterBot Discord Activity — isolated test-server setup

This is a **test-only embedded Discord Activity**, not a production rollout.
It is deliberately restricted to:

- Discord test guild: 818423564901416991
- Discord test channel: 1558470955930755162
- Crashday's real scheduling data, permissions, roles and channels stay untouched.
  Only its two obsolete test-only preview subcommands are de-registered after restart.

The experiment uses the existing DiscordBotHosting WinterBot process and test-only
ngrok tunnel, but uses a separate scheduling-activity-test.json data file.
It cannot create real Discord Scheduled Events and cannot post to League/Public.

## Requirements

- WinterBot must be invited to the test server.
- You need Manage Server permission there (or be its owner).
- Unverified Activities can launch only in servers with **fewer than 25 members**,
  by the application developer, team members, or authorized Activity testers.
- The Activity's STATIC frontend is hosted at GitHub Pages (no ngrok warning):
  https://micaloveskpop.github.io/WinterBot/
- The existing test-only JSON API continues through the ngrok tunnel:
  https://pension-aground-bullpen.ngrok-free.dev/activity/api/config
- The repository's GitHub Pages deployment must have succeeded (from the
  "Deploy Activity Test UI" GitHub Actions workflow).
- The existing Discord OAuth2 client ID, client secret and 32+ character
  scheduling session secret must already be configured in DiscordBotHosting.

## Discord Developer Portal setup

Open https://discord.com/developers/applications and choose the **existing
WinterBot application**. Do not create or rotate bot tokens.

1. Under **OAuth2 → Redirects**, add https://127.0.0.1 if absent, for the
   Embedded App SDK's OAuth flow. Retain the existing ngrok /oauth/callback.
   Discord handles the Activity OAuth redirect without navigating there.
2. Under **Activities → URL Mappings**, REMOVE the old mapping
   **/ → pension-aground-bullpen.ngrok-free.dev/activity/** and replace it
   with these two mappings IN THIS ORDER:

   | Prefix | Target (no https://) |
   | --- | --- |
   | **/api** | **pension-aground-bullpen.ngrok-free.dev/activity/api/** |
   | **/** | **micaloveskpop.github.io/WinterBot/** |

   The **/api** mapping MUST appear above **/**. Discord applies the first
   matching prefix and a misplaced /** will shadow the API mapping.

   The static Activity HTML, JavaScript and CSS are now served by GitHub Pages,
   avoiding ngrok's forced browser-warning response. The API requests add the
   ngrok-skip-browser-warning header and remain OAuth/session authenticated.
   Both targets are DIRECTORIES and must omit https://.
3. Under **Activities → Settings**, keep **Enable Activities** enabled and
   enable desktop/web (and mobile when testing). Save changes.
4. Keep the app private/unverified while testing. Do not post this invitation
   to the main Crashday server.

IMPORTANT: the old one-mapping configuration causes a white/blank Activity!
The Discord proxy receives the free ngrok warning (HTTP 200 text/plain)
instead of HTML/JS/CSS. Retrying, restarting and CSS edits do not fix it.
If GitHub Pages is temporarily 404, wait for its deployment workflow to finish
before launching the Activity.

Discord docs:
- https://docs.discord.com/developers/activities/building-an-activity
- https://docs.discord.com/developers/activities/development-guides/local-development
- https://docs.discord.com/developers/activities/development-guides/networking

## DiscordBotHosting configuration

Add just one new setting to WinterBot's existing .env:

    SCHEDULING_ACTIVITY_TEST_ENABLED=1

Keep the existing test-mode HTTPS setup:

    SCHEDULING_ENABLED=1
    SCHEDULING_TEST_MODE=1
    SCHEDULING_NGROK_ENABLED=1
    SCHEDULING_NGROK_DOMAIN=pension-aground-bullpen.ngrok-free.dev

Do not share secrets or alter the Discord bot token. The Activity test
refuses to enable in normal production mode.

Restart WinterBot after the GitHub PR has passed tests and merged into main,
so the usual hosting Git startup pulls the new code. The Activity SDK
is already bundled; no new startup command or separate server is needed.

## Testing the Activity in Discord

Open the isolated test channel:
https://discord.com/channels/818423564901416991/1558470955930755162

Run these as the test-server owner or a member with Manage Server permission.

All experimental **Discord message-based** controls now live here too:
- **/activitytest tests** explains the available tests and what remains planned.
- **/activitytest organizer** starts the connected organizer → invitation →
  attendance → optional vote → simulated event/check-in Discord-message flow.
- **/activitytest results** opens the most recent test planning results.
- **/activitytest checkin** inspects the latest simulated event role and
  channel-access lifecycle.
- **/activitytest preview-event** simulates moderator event overtime, a grace
  period and shutdown; it never creates or deletes real event channels.
- **/activitytest preview-native** posts the older private, native-message
  availability UX for side-by-side comparison with the Activity.
- **/activitytest invite** launches the preferred embedded calendar Activity.

**IMPORTANT:** The connected native test journey and the calendar Activity
have separate test data by default. A participant can use **Import reviewed
Activity week** on the organizer's invitation to preview and explicitly
confirm transferring their already-submitted availability to that round.
The conversion conservatively rounds confirmed periods inward to the
existing **15-minute** optimizer and excludes tentative periods from
confirmed-attendance calculations. The Activity submission remains unchanged.
The journey's check-in, channels, event role, grace and archives are
**simulated** and do not modify Discord permissions.
See NATIVE_JOURNEY_TEST.md for the full walkthrough and integration limits.

After a WinterBot restart, the old **/schedule preview** and
**/schedule preview-event** commands will no longer be registered in the
Crashday server. The core /schedule organizer commands are not affected.
The native prototypes have their own isolated state file; resetting test data
clears these previews too. See NATIVE_DISCORD_UX_TEST.md for details.

## Activity test walkthrough

1. Run **/activitytest invite**. This posts a fresh invitation only to the test channel.
2. Click **Open availability planner in Discord**. This launches the embedded Activity,
   NOT a browser link. The new prototype opens a familiar seven-day calendar.
3. Click a day card. Press the large **+ Add availability** placeholder.
   This opens the clock without inserting any predetermined hours. The clock
   starts with **From --:-- / Until --:--**, and Apply remains disabled until a
   complete valid range is selected. Once you've added a window, use the
   **+ Add another time window** placeholder beneath it. The day header,
   availability actions and timeline stay fixed while only the time-window
   list scrolls.
   - Click From or Until to open one small range picker with both endpoints.
   - Tap **or hold and drag** around the clock face (mouse or touch); the
     hand/time preview follows continuously as you consider different values.
     Only releasing the pointer finishes that choice.
   - The dial follows the familiar four-step sequence automatically:
     **From hour → From minutes → Until hour → Until minutes**. Selecting
     minutes on From advances to Until immediately; no extra tab tap needed.
     After Until minutes, **Apply range** remains mandatory.
   - In 24h mode: 01–12 on the outer hour ring / 13–00 on the inner ring,
     followed by five-minute positions around the minute dial.
   - Within the clock dialog, the checked/unchecked **24-hour clock** option
     switches between 24h and 12h; in 12h mode use the 1–12 ring and AM/PM.
   - Hours outside moderator-defined daily limits or conflicting with other
     saved windows are disabled/grayed. Restrictions are enforced on the backend.
   - Selecting 00:00 for **Until** means 24:00 (end of selected day).
   - Manual From/Until and Hour/Minute tabs stay available for fine-tuning.
     Cancelling a drag restores its provisional value without saving.
   - Select End of day (24:00) only for the Until endpoint.
   - Apply both times together. Invalid/overlapping ranges display an error
     in the picker without saving a partially edited day.
   - The exact same picker is used when configuring multiple days at once.
   Try extra windows and optional duration limits. Editing responds locally;
   the saved-draft indicator reflects remote persistence.
4. Use the full-width **Single day / Multiple days** mode control **above**
   the weekly calendar. Select multiple days in the calendar (the editor might
   be beside them, not above/below), then choose common availability and
   apply. The certainty control has two clearly colored options: green
   Available and amber Tentative, instead of an OS-themed dropdown.
   Existing answers get a green/amber/slate-gray overwrite preview.
5. Use **Copy this day** to copy all its windows to chosen dates.
6. Choose **Review week**. Every date shows a compact timeline: green confirmed,
   amber/yellow tentative, and muted slate-gray unavailable. Unselected gaps
   inside a reviewed day are unavailable too, so the bar never leaves them
   ambiguously blank. Tentative ranges read `19:00–22:00 (tentative)`; multiple
   ranges stack without extra separator rows. Review every date, then submit.
7. To try revising an existing submission, choose Edit availability and
   change a date. The fixed footer now presents **Cancel** and **Submit changes**.
   Cancel asks permission to discard autosaved draft edits and restores the
   last real submission; with no changes it exits immediately. Submit changes
   opens mandatory review before confirming, and then returns to the submitted
   receipt. The template shortcut is kept at the bottom of the calendar panel.
8. Click **Create usual week** (or **Edit usual week**) to open a separate,
   reusable Monday–Sunday editor. It starts with an existing saved template,
   otherwise your submitted week, otherwise your current draft or a blank week.
   Modify each weekday freely; **Reset** offers a blank week or copying back
   from the submitted week. **Cancel** leaves the saved template unchanged.
   **Review template** and **Save usual week** are explicit actions; saving a
   template never revises or submits availability for an actual event.
9. Run **/activitytest next-week** to test reusing your saved usual week and
   editing exceptions. Unanswered weekdays in a partial template stay unanswered.
10. Close/reopen the Activity to verify persistence.
11. Use **Exit** at the upper right to close the Activity through the official
    Discord SDK. Exit confirms what will happen to an unsubmitted event draft
    (it stays saved) or a locally edited usual-week template (it is discarded).
    Cancel keeps the Activity open. The 12-hour Android/Material dial remains a
    single 1–12 ring with AM/PM; 24-hour mode retains two rings.
12. **/activitytest reset** removes all isolated test records, including
    Activity availability/templates, the old native comparison's drafts,
    and simulated event countdowns. It does not modify real events or roles.
    Previously posted test controls may stop working after this reset.

The older test-server **/activitytest vote** backend exists for legacy algorithm
verification, but voting is NOT connected to this focused weekly-calendar UX pilot.
Do not use it as an end-to-end test of the new Activity's voting interface.

### UX prototype implementation

- Seven-day, locally responsive Activity UI with desktop/mobile layouts.
- Optimized for the measured Discord Activity viewport: approximately 460 CSS px
  high, 462 px wide in the narrow window and 1018 px wide in the large window.
  Wide layout places the week and editor in separate panes; narrow layout uses
  a single compact row of seven day cards above the editor. The Activity footer
  stays visible and the detailed editor scrolls internally for additional windows.
  At very wide viewport sizes, the content width is capped at 900 CSS px and
  horizontally centered rather than stretched indefinitely.
- Review keeps its confirmation controls visible; if the complete list does not
  fit, participants must scroll to the bottom before they can submit.
- Certainty per window is a short Available/Tentative toggle rather than an
  extra dropdown; optional duration limits remain independently selectable.
- Private test-only data file: scheduling-activity-weekly-ux.json; production
  scheduling.json and the legacy Activity test state remain untouched.
- Confirmed and tentative ranges, five-minute precision, optional duration limits,
  copy-day, multi-day editing, usual-week template, required review, explicit submit.
- Controls remain usable while event drafts save in the background. Save failures
  show retry. A draft does not count as a submission, and a template is edited
  locally until you explicitly review and save it. Discarding an event revision
  restores the previously submitted state on the backend.
- No real event check-in, Discord role/channel changes, organizer controls or
  Scheduled Event publishing in this prototype. Those remain later milestones.

The Activity verifies the logged-in Discord user through OAuth and confirms
membership and View Channel access on the test server.

## Troubleshooting

- **No /activitytest command:** Ensure WinterBot joined the test guild,
  the PR has deployed, and SCHEDULING_ACTIVITY_TEST_ENABLED=1 is set.
  Check WinterBot logs for Activity test startup issues.
- **Button shows "This interaction failed":** after restarting with this
  version, run **/activitytest status** in the test channel. It queries the
  application's EMBEDDED flag directly from Discord and tells you whether
  Activities are enabled. If enabled, inspect DiscordBotHosting console for
  "WinterBot test Activity launch failed" and its Discord error code; then
  confirm Activities → URL Mappings in the Developer Portal. WinterBot uses
  discord.js's native launchActivity() method (an unauthenticated type-12
  interaction response), and shows an ephemeral error when Discord rejects it.
- **Cannot launch:** Enable Activities and the URL Mapping, and ensure the
  guild has fewer than 25 members and the account is an authorized tester.
- **Blank page or ngrok warning:** The free-tier ngrok anti-abuse interstitial
  may be shown to Discord's proxy. If it is, switch the Activity to a clean
  HTTPS tunnel/domain; do not assume browser-warning headers can be sent
  through Discord's proxy.
- **OAuth error:** Ensure the Activity and bot use the same WinterBot app ID,
  that Activity OAuth redirect is configured, and restart the Activity.
- **403 error:** Your Discord account isn't a member of the test guild or
  cannot View Channel there.
- **External browser opens:** That's the old planner link; use the new
  WinterBot Activity test message button instead.

## Development

Source: src/scheduling/activity-client/main.js
Bundled static asset: src/scheduling/activity-public/activity.js
Server/test bot integration: src/scheduling/activityTest.js

Run npm run build:activity after changing the frontend, then
npm run test:activity:browser and npm test.

## Safety

Discord's proxy cookie requirements are respected using HttpOnly, Secure,
SameSite=None and Partitioned cookies. Server-side OAuth and test-channel
membership checks are required before saving. No private user data from
another participant is sent in the Activity response.

This is a **test-only Activity proof of concept**, not yet a verified
public-community Activity. The main browser planner and channel-specific
production scheduling remain unchanged. Do not manually change WinterBot's
version numbers.
