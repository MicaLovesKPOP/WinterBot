# WinterBot — Discord Scheduling Channels & Test Mode

This implementation adds the channel and role policy around v2.7 of WinterBot's availability planner. It stays disabled until explicitly configured.

## Four-channel model — Official Crashday server

- **Mod / Management:** https://discord.com/channels/199916140183420928/332572234885365766
  - /schedule create — private setup wizard link
  - /schedule manage — private organizer board link
  - /schedule status — private scheduling overview
  - Organizer controls stay private. Slash-command responses are ephemeral.
- **League (default):** https://discord.com/channels/199916140183420928/387323214105411599
  - One professional availability invitation, updated in place when the round advances
  - Separate confirmed Discord Scheduled Event announcement after each real event
- **Public (optional instead of League):** https://discord.com/channels/199916140183420928/343084103228456970
  - Exactly the same member-facing design, only when Management selects Public for that round
  - Never duplicate an invitation into both League and Public
- **#bot-logs:** existing LOG_CHANNEL_ID
  - Normal: operational logs, warnings, errors
  - Test mode: ALL scheduling invitations, voting updates, simulated event announcements, and the /schedule setup command

## Discord test mode

Configure these two flags:

    SCHEDULING_ENABLED=1
    SCHEDULING_TEST_MODE=1

The role IDs and OAuth/HTTPS settings described below must also be configured before the live Discord test.

Guaranteed behavior:

1. Management initiates /schedule create from **#bot-logs** rather than Mod during testing.
2. Even if Management chooses Public in the setup wizard, ALL invitations and announcements go to #bot-logs. Neither League nor Public receives any scheduling messages.
3. Test invitations display **[TEST]** and explain clearly that nothing is being scheduled for real.
4. Availability collection, phase deadlines, voting, the 90%-of-best algorithm, and both verification-role checks remain real.
5. Final approvals only simulate event creation. The bot never calls the Discord Scheduled Event creation API and instead posts a distinct **[TEST ONLY]** event preview in #bot-logs.
6. The test flag is stored PER ROUND, so disabling test mode later cannot accidentally convert an older test round into a real event creation request.
7. Test mode lists/manages only test rounds, and normal mode lists/manages only normal rounds. Changing URL or request payload cannot bypass this.
8. Test simulations do not reserve the calendar date for a real event, but one simulated event per day is still enforced within testing.
9. No outgoing member-facing payload allows automatic mentions or pings.
10. This is opt-in. With SCHEDULING_ENABLED absent or 0, none of the new command handling or channel posting is activated.

## Normal mode

    SCHEDULING_ENABLED=1
    SCHEDULING_TEST_MODE=0

- Only the **Management role** or the guild owner can start or administer scheduling.
- The /schedule slash command is restricted to the Mod channel; calls in other channels receive only a private error.
- Verified participants need BOTH checkmark roles and View Channel permission for the chosen League/Public destination. Backend authorization checks roles and channel access independently of links.
- The member channel receives only the updated invitation and confirmed-event announcements, not organizer updates or logs.
- Management can select individual dates, optionally limit valid event hours separately for each date, and specify an event duration range with configured increments.
- Participant availability entry uses the **same per-date event-hours limits**. For a date restricted to 17:30–24:00, the From/Until dropdowns, All allowed hours/Evening presets, additional windows, and copy-to-other-dates feature never propose times outside the permitted range. The server independently rejects forged or outdated availability submissions that exceed the limit. Previously saved responses from older versions are shown as their in-range intersection, with a notice to save a corrected answer.
- The optimizer favors the largest full-duration attendance, with longer durations winning ties. Members can still limit their own stay within each availability window.
- Optional voting excludes only losing options actually included in the ballot. Unvoted candidates survive.
- One real WinterBot scheduled event per calendar day across all scheduling rounds.

## Permissions and secrets — later operator setup

The guild, Mod, League and Public IDs above are built in as defaults. The actual #bot-logs ID comes from WinterBot's existing LOG_CHANNEL_ID. For a free assigned HTTPS domain with no Startup Command changes, the recommended pilot instructions are in **SCHEDULING_NGROK_SETUP.md**.

The existing, NON-SECRET Discord role IDs are now provided as built-in defaults:

    Management: 332571825127292929
    Checkmark 1: 826810836302823484
    Checkmark 2: 826799764829372416

No additional role-ID environment variables are necessary for this server. SCHEDULING_MANAGEMENT_ROLE_ID and SCHEDULING_VERIFIED_ROLE_IDS may still override the defaults if the roles change. Both checkmark roles remain mandatory for every participant.

When the operator is ready, set HTTPS and Discord OAuth values privately in the bot-host environment:

    SCHEDULING_BASE_URL=https://your-hostname.example
    DISCORD_CLIENT_ID=WINTERBOT_APPLICATION_ID
    DISCORD_CLIENT_SECRET=PRIVATE_DISCORD_OAUTH_CLIENT_SECRET
    SCHEDULING_SESSION_SECRET=PRIVATE_RANDOM_STRING_AT_LEAST_32_CHARACTERS
    SCHEDULING_HOST=127.0.0.1
    SCHEDULING_PORT=8791

Register https://your-hostname.example/oauth/callback in the existing WinterBot application's OAuth2 Redirect URLs. Do not paste client secrets, bot tokens, webhook URLs or signing keys into ChatGPT, GitHub or Discord channels.

For the production bot, allow View Channel, Send Messages, Read Message History and Embed Links in the intended posting channels; normal publishing also requires permission to Create Events. Test mode sends only to #bot-logs.

Missing or incorrect optional scheduling configuration must never crash the ordinary WinterBot subscriber tracker. Until all prerequisites are ready, leave SCHEDULING_ENABLED=0.

**Automatic deployment is already configured separately:** DiscordBotHosting's existing AUTO_UPDATE=1 / GIT_ADDRESS / BRANCH flow can pull successful, sufficiently old main-branch commits during WinterBot's daily 04:45 Europe/Amsterdam check, followed by Pterodactyl restart. This deploys code only. It does not set new environment variables, provision an HTTPS planner host, or register Discord OAuth redirect URLs. Those still require explicit one-time hosting/application setup.

## Embedded Discord Activity work

This branch implements the responsive browser planner, authenticated backend, slash-command setup links, channel presentation, permissions and test mode. It does **not** yet merge the separately developed Discord Embedded App SDK Activity launcher. The Activity should reuse these server-side restrictions rather than trust client-supplied roles or destinations.

## Verification and rollback

    npm ci
    npm test
    npm run test:ui

Tests cover role checks, Mod vs #bot-logs command gating, date and hour limits, event-duration ranges, full test-mode routing, verified users, no real Discord event creation in test mode, test/normal round isolation, and default League vs optional Public announcements.

To stop testing, set SCHEDULING_TEST_MODE=0 and restart the bot. The old test rounds remain archived in the data but inactive. To disable scheduling entirely, set SCHEDULING_ENABLED=0 and restart. These changes never delete existing Discord Scheduled Events.

The old uncommitted Discord Activity prototype was discarded at the user's request. The live #bot-logs scheduling test uses Discord slash commands and a responsive browser planner; an embedded Discord Activity is a separate future feature.
