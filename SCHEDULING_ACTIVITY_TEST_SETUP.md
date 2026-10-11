# WinterBot Discord Activity — isolated test-server setup

This is a **test-only embedded Discord Activity**, not a production rollout.
It is deliberately restricted to:

- Discord test guild: 818423564901416991
- Discord test channel: 1558470955930755162
- The main Crashday Discord guild is not targeted and remains unchanged.

The experiment uses the existing DiscordBotHosting WinterBot process and test-only
ngrok tunnel, but uses a separate scheduling-activity-test.json data file.
It cannot create real Discord Scheduled Events and cannot post to League/Public.

## Requirements

- WinterBot must be invited to the test server.
- You need Manage Server permission there (or be its owner).
- Unverified Activities can launch only in servers with **fewer than 25 members**,
  by the application developer, team members, or authorized Activity testers.
- The current test HTTPS address remains:
  https://pension-aground-bullpen.ngrok-free.dev
- The existing Discord OAuth2 client ID, client secret and 32+ character
  scheduling session secret must already be configured in DiscordBotHosting.

## Discord Developer Portal setup

Open https://discord.com/developers/applications and choose the **existing
WinterBot application**. Do not create or rotate bot tokens.

1. Under **OAuth2 → Redirects**, add https://127.0.0.1 if absent, for the
   Embedded App SDK's OAuth flow. Retain the existing ngrok /oauth/callback.
   Discord handles the Activity OAuth redirect without navigating there.
2. Under **Activities → URL Mappings**, add this mapping:
   - **Prefix:** /
   - **Target:** pension-aground-bullpen.ngrok-free.dev/activity/
   - There is NO https:// in the target. It is a directory. This should
     route the Activity's root, CSS, JavaScript and API calls through the
     existing HTTPS tunnel to WinterBot's isolated Activity endpoints.
3. Under **Activities → Settings**, turn on **Enable Activities** and
   enable desktop/web (and mobile for testing). Save changes.
4. Leave the app private and unverified while we test.

If the portal rejects a directory target, **do not substitute the plain
ngrok hostname**, as that would open the old browser planner instead.
Share the mapping-screen error so we can switch to a dedicated HTTPS origin.

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

Run these as the test-server owner or a member with Manage Server permission:

1. Run **/activitytest invite**. This posts a fresh invitation only to the test channel.
2. Click **Open availability planner in Discord**. This launches the embedded Activity,
   NOT a browser link. The new prototype opens a familiar seven-day calendar.
3. Click a day card. Try **Available hours**, **All day**, **Unavailable**, and the
   confirmed/tentative choice on each time range. Try extra ranges and duration limits.
   Editing responds locally; the saved-draft indicator reflects remote persistence.
4. Turn on **Select multiple days**, pick several days, configure common hours, and
   apply. Existing answers get an overwrite preview before replacement.
5. Use **Copy this day** to copy all its windows to chosen dates.
6. Choose **Review week**. The final submission is disabled until all seven dates
   are answered and the latest changes have saved. Submit explicitly.
7. Save your submitted answers as your usual week. Run **/activitytest next-week** to
   start another seven-day round while preserving templates, relaunch and choose
   **Reuse usual week**. Review and correct exceptions before submitting again.
8. Close/reopen the Activity to verify persistence.
9. **/activitytest reset** removes ONLY the isolated Activity test round AND usual-week
   templates. It does not modify real community events, roles, or invitations.

The older test-server **/activitytest vote** backend exists for legacy algorithm
verification, but voting is NOT connected to this focused weekly-calendar UX pilot.
Do not use it as an end-to-end test of the new Activity's voting interface.

### UX prototype implementation

- Seven-day, locally responsive Activity UI with desktop/mobile layouts.
- Private test-only data file: scheduling-activity-weekly-ux.json; production
  scheduling.json and the legacy Activity test state remain untouched.
- Confirmed and tentative ranges, five-minute precision, optional duration limits,
  copy-day, multi-day editing, usual-week template, required review, explicit submit.
- Controls remain usable while changes save in the background. Save failures show a
  retry option. A saved draft does not count as a confirmed submission.
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
