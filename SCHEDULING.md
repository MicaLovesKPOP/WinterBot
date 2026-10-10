# WinterBot Availability Scheduling

## Delivery status

**Ready to try:** fully functional, locally hosted browser preview with a real API, persistent answers, mobile-friendly interface, scheduling algorithm, optional voting, and simulated event creation.

**Implemented, awaiting real Discord verification:** opt-in live browser sign-in via Discord OAuth2, guild membership/organizer permission checks, channel invitation announcements, and real Discord Scheduled Event creation (voice-channel or external) with duplicate reconciliation.

**Not yet provided:** the Discord Embedded App SDK Activity launcher, public HTTPS hosting, and live testing with real Discord credentials. The web planner works in a normal browser; it is *not yet* an embedded Activity.

The existing scheduled-event registration tracker is left untouched. Scheduling is **disabled by default** in WinterBot.js. The scheduler's Node module is lazy-loaded only when SCHEDULING_ENABLED=1. Bad scheduler configuration or an unavailable HTTP port is logged without stopping the original bot.

## Test now

From the WinterBot Scheduler Preview folder:

    npm ci
    npm run scheduler:demo

Open **http://127.0.0.1:8791** on the same PC. The demo binds to loopback, permits switching between pretend identities and **cannot contact Discord to create events**.

The preview seeds a Game Night round with eight people. Suggested walk-through:

1. Choose participant Mica in **Demo identity**.
2. Mark dates Available, Unavailable or Not decided. Add multiple windows and optional duration limits. Try All day, Evening and Copy to unanswered days.
3. Switch to Organizer and select **Close collection now** to bypass the 72-hour wait.
4. See attendance-ranked candidate groups. Expand Who can attend and select an exact start time.
5. Check at least two candidates and select **Put to vote**. No real Discord message is sent.
6. Switch to participants and vote on preferred times; multiple preferences are allowed.
7. Back as Organizer, select **Close voting now**. Only voted options that lost are hidden. All unvoted candidates survive.
8. Choose a remaining candidate and **Schedule selected**. A clearly labeled *Demo event created* entry appears.

Restarting the demo preserves its local state. To replay the full walkthrough, switch to Organizer and press **Restart demo** (with confirmation). This resets sample planning rounds, ballots and simulated events only. Alternatively, stop the demo, move aside the ignored scheduling-demo.json and scheduling-demo.json.bak files, and start again. Do not delete real scheduling.json.

## Discord channel routing and test mode

The latest branch implements /schedule create and /schedule manage as Management-only commands in the Mod channel, with member availability invitations and confirmed-event announcements in League by default or Public when selected. The test-mode flag reroutes every stage to #bot-logs and replaces real event creation with clearly marked simulations. See **[SCHEDULING_CHANNELS.md](SCHEDULING_CHANNELS.md)** for exact channel IDs, both verification-role requirements, operational modes, secrets to enter privately later, and test/rollback procedure.

## Behaviour and design

### Availability

- Every day has exactly one state: **unanswered**, **unavailable**, or **available**.
- Available days contain 1–10 non-overlapping windows. Time inputs use 15-minute increments.
- Each window can optionally cap the attendee's **maximum continuous stay**. A 2-hour event fits any 2-hour position inside an 18:00–23:00 availability window capped at 120 minutes.
- Day periods use one configurable IANA time zone (default Europe/Amsterdam). An ending time of 24:00 denotes midnight.
- Cross-midnight individual windows are not implemented. Enter the next day's hours on the next date.
- Events crossing a daylight-saving offset change and ambiguous start instants are skipped rather than silently producing the wrong time.
- Participants may edit until the collection deadline; the server rejects late submissions even from old browser tabs.
- A fixed roster can be entered when creating a round. Otherwise, participants join by first submitting their availability; their registration counts toward the round's roster.
- **Unanswered does not mean Unavailable.** Missing answers remain distinguishable, and neither counts as definite attendance.

### Optimizer

- The organizer specifies event duration, eligible dates, time zone and start-time granularity (15/30/60 minutes).
- An attendee counts only if their declared windows permit **the full event** and a duration cap does not exclude it.
- The optimizer maximizes the **number of people** available, not percentages.
- Consecutive equivalent start times with the same attendee set are grouped. The organizer can select an exact start within that group.
- It retains **all** globally best-attendance candidate groups, then fills toward the configured target (five by default) only with groups meeting at least **90% of the best attendance**.
- For example, with best attendance 10, nine attendees meets the threshold while eight does not. It is fine to return fewer than five candidates.
- The board shows the number available, share of the participant roster and attendee names.

### Voting and final scheduling

- A vote is optional; the organizer can immediately select candidates for scheduling.
- If using voting, the organizer picks 2–30 **specific candidate groups** and sets a specific start time for each.
- Approval ballot: participants may support **multiple** preferred times and edit their response during voting.
- Collection defaults to 72 hours; voting defaults to 24 hours. Both can be configured and are automatically closed by the server, including after restart.
- The maximum vote count survives; **all tied winners survive**. A vote with no responses excludes nothing.
- Only **losing options included in the ballot** disappear from the active organizer board. Unvoted candidates are never discarded; original history is retained.
- A winning voted option's **voted-on start time is locked**. Unvoted options may still use any of their valid start times.
- The organizer must explicitly approve each final event. Winning a vote never schedules anything automatically.
- Optional Discord voice channel ID creates a **voice-channel Scheduled Event** that points directly to that voice channel. Without it, WinterBot creates an **External** Scheduled Event using the configured location.
- **At most one published WinterBot event per local calendar day**, enforced server-side across scheduling rounds. Several different days may be scheduled in one round.

### Reliability and security

- Isolated, versioned scheduling JSON with sequential mutations, atomic temporary writes and last-known-good backup recovery.
- Every deadline, permission check, vote, selected option and day limit is validated on the server.
- Live publishing persists a unique **pending intent** first, then looks for the intent marker in an existing Discord Scheduled Event before creating anything. The marker is always retained even when the event description reaches Discord's length limit. Concurrent requests for one intent share the same in-flight operation; uncertain outcomes require Discord reconciliation and explicitly confirmed retry before another creation attempt.
- Uncertain Discord failures are stored with needs_attention and may be reconciled. Before forcing a retry, the organizer must confirm that no matching Discord event already exists. A marker in a different WinterBot event on the same date also blocks publication, including after a lost state-file recovery.
- Live OAuth2 requests Discord identity and verifies current guild membership, the configured Management role for organizers (guild owner also permitted), and both configured verification roles plus channel access for participants.
- Signed HttpOnly Secure SameSite cookies, OAuth state validation and same-origin mutation restrictions protect the live browser API.
- The local demo accepts identity switching but binds **only to localhost** and never creates real Discord events. Do not tunnel it onto the public internet.
- A live event becomes visible to WinterBot's **existing registration tracker**, which remains separate.

## Built-in ngrok HTTPS test option

For DiscordBotHosting's read-only Startup Command, WinterBot can now start ngrok's official Node SDK inside its existing process. This is **test-mode only** and requires both `SCHEDULING_ENABLED=1` and `SCHEDULING_TEST_MODE=1`, plus `SCHEDULING_NGROK_ENABLED=1`. It derives the correct `SCHEDULING_BASE_URL` from your assigned development domain and closes the public tunnel on bot shutdown. See **[SCHEDULING_NGROK_SETUP.md](SCHEDULING_NGROK_SETUP.md)** for the ngrok token, Discord OAuth redirect and exact private `.env` instructions. No additional Node process, custom domain or editable startup command is needed.

## Opt-in live Discord setup

After verifying in a test server, add the following settings to the existing .env:

    SCHEDULING_ENABLED=1
    SCHEDULING_HOST=127.0.0.1
    SCHEDULING_PORT=8791
    SCHEDULING_BASE_URL=https://calendar.example.org
    DISCORD_CLIENT_ID=YOUR_DISCORD_APPLICATION_CLIENT_ID
    DISCORD_CLIENT_SECRET=YOUR_DISCORD_OAUTH_SECRET
    SCHEDULING_SESSION_SECRET=LONG_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
    SCHEDULING_CHANNEL_ID=OPTIONAL_DISCORD_TEXT_CHANNEL_ID
    SCHEDULING_TEST_MODE=1

The Official Crashday Management and both verification-role IDs are already built into the scheduling policy. The corresponding environment variables are now optional overrides; you do not need to enter those IDs again. See SCHEDULING_CHANNELS.md.

Discord Developer Portal: register exactly this OAuth2 redirect URI:

    https://calendar.example.org/oauth/callback

Point your public HTTPS reverse proxy to **127.0.0.1:8791** on the bot's host. Keep TLS and Origin headers intact; the public URL origin must match SCHEDULING_BASE_URL.

Bot permissions: **Create Events** for real scheduled events, plus View Channel, Send Messages, Read Message History and Embed Links for the selected posting channels. Organizer permissions: server owner or the configured Management role. Participants require BOTH configured checkmark roles AND access to the chosen invitation channel.

The organizer starts the setup from the Mod channel using /schedule create (or in #bot-logs while test mode is enabled). Creating a round automatically posts its invitation to League by default, Public if explicitly selected, or only #bot-logs during testing. The invitation updates in place as availability/voting closes. Real confirmed events each produce a separate event announcement. These live Discord paths require testing with valid credentials before production rollout.

**The code does not yet implement a Discord Activity launch.** A fully embedded Activity needs the Discord Embedded App SDK, Activity URL mappings and authorization flow. Keep the normal mobile browser as a fallback when adding it.

### Safe rollout / rollback

1. Merge the tested code with SCHEDULING_ENABLED **absent/0**. In this condition the original bot performs the same scheduled-event monitoring as before. No scheduling web server, Discord OAuth or new scheduled-event creation runs.
2. On a staging bot/test guild, configure OAuth2, HTTPS and scheduling permissions. Verify a real end-to-end creation, RSVP and tracking before enabling production.
3. Enable SCHEDULING_ENABLED=1 **only after** the role IDs, HTTPS URL and permissions are configured. Start with SCHEDULING_TEST_MODE=1, keeping all posts and event simulations inside #bot-logs. Only after the live test has passed should you set SCHEDULING_TEST_MODE=0 for normal Mod → League/Public routing.
4. To deactivate scheduling, set SCHEDULING_ENABLED=0 and restart the bot. Existing scheduled Discord events are not deleted by disabling WinterBot's planner. If the entire release must be reverted, use Git to revert the merge and let the existing nightly update guard validate CI before a new restart.

**Auto-update note:** the bot has a separate guarded nightly main-branch updater. Merging this feature may still cause its normal code-update restart after the commit passes CI and the minimum-age check. The feature flag prevents the scheduling subsystem from starting until explicitly configured.

## Verification

    npm test
    npm run test:ui
    npm run test:viewports

The optional browser viewport audit exercises 15 widths from 320 to 1920 CSS pixels across all four major scheduling phases (60 combinations). It also checks page-wide horizontal overflow, browser errors, and 125% page scaling on representative narrow/mobile and tablet widths. The audit passed without detected overflow. This does not replace real-device accessibility testing or testing within a Discord Activity viewport.

The Node tests cover availability states, multi-ranges, caps, 90% ranking, candidate grouping, voting winners/losers/ties/no-vote, immutable vote times, deadlines, DST, persistence recovery, permissions and publication retries.

The UI smoke test requires Microsoft Edge on Windows (or a browser path in WINTERBOT_BROWSER). It runs a fresh isolated demo and checks actual browser actions, including a member editing availability, organizer review, voting, final simulated publication, JavaScript errors and mobile viewport width. Screenshots go to ignored **preview-screens/**.

## Next launch milestones

1. Verify a complete live OAuth2 login and real Discord event creation in a dedicated test server, including required permissions and the existing event-registration tracker.
2. Add deadline reminders/notification preferences (channel or DM), if desired.
3. Integrate the Embedded App SDK and native Discord Activity launch, keeping this browser planner as a fallback.
4. Add organizer archive and round management, saved weekly templates and explicit cross-midnight support as separate follow-ups.

## Architecture

- src/scheduling/core.js — pure scheduling/availability/optimization/voting rules.
- src/scheduling/store.js — durable state and recovery.
- src/scheduling/auth.js — demo and live OAuth identities.
- src/scheduling/publisher.js — channel announcements and idempotent Discord event publisher.
- src/scheduling/server.js — HTTP API, deadline watcher and fixtures.
- src/scheduling/public — responsive HTML/CSS/JS.
- src/scheduling/demo.js — safe standalone local preview.
- tests/schedulingCore.test.js — algorithm and API tests.
- scripts/uiSmoke.js — end-to-end browser test.
