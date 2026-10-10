# WinterBot — ngrok HTTPS test setup (DiscordBotHosting)

This option is for trying the **real WinterBot bot and browser planner** with all
messages in **#bot-logs** and no real Discord Scheduled Events. It runs inside
the existing WinterBot Node process: **no extra Startup Command, allocated
port, standalone daemon, GitHub Pages site or custom domain is needed.**

The separate Discord Embedded Activity is not implemented in this version.
Organizers use /schedule create in #bot-logs and the visual planner opens as a
secure web page; the live Discord interaction, two-role verification, data
collection, voting, simulated approvals and #bot-logs announcements work normally.

## Before making any changes

**Your GitHub personal access token was pasted into a conversation earlier.
Rotate/revoke the old token at https://github.com/settings/personal-access-tokens
and replace it privately in DiscordBotHosting > Startup > Git Access Token.**
Never paste a replacement token, bot token, ngrok token or OAuth secret into chat.

WinterBot's existing Git auto-update downloads the latest **main** branch
on startup. Its nightly updater checks at 04:45 Europe/Amsterdam and only
restarts for sufficiently old main commits with successful CI. No manual
file upload is necessary.

## 1. Create a free ngrok account

Go to https://dashboard.ngrok.com and create an account.

- In the ngrok dashboard, open **Domains**. Copy the assigned, reserved
  development domain, normally ending in **.ngrok-free.dev**. Do not invent
  a domain or paste someone else's. It stays assigned to your account
  across restarts.
- Open **Your Authtoken** in the ngrok dashboard. Copy the token **privately**
  for use only in the bot's .env file.
- The free tier may display a first-visit browser warning to users. This is
  ngrok's own interstitial; users may need to proceed before Discord OAuth.
  Free service quotas apply. This is suitable for a pilot, not a guarantee
  of production quality.

## 2. Get the existing Discord application's OAuth settings

Open https://discord.com/developers/applications and select the SAME
WinterBot application already running on your server. Do not create a new
bot or rotate its BOT_TOKEN.

- Under **General Information**, copy **Application ID** (not secret).
- Under **OAuth2**, copy its private **Client Secret**. If Discord requires
  resetting an existing secret, be aware that other clients using that
  secret must also be updated.
- Under **OAuth2 > Redirects**, add this exact URI, replacing the domain:

      https://YOUR_ASSIGNED_NGROK_DOMAIN/oauth/callback

  Example format only:
  https://your-account-name.ngrok-free.dev/oauth/callback

  Save. The hostname must match the ngrok domain you actually own.

## 3. Edit only DiscordBotHosting's existing /home/container/.env

Open DiscordBotHosting > WinterBot > **Files** > **.env**.
Leave BOT_TOKEN, GUILD_ID, CHANNEL_ID, LOG_CHANNEL_ID, the Git updater and
all existing event-registration settings untouched.

Append these lines, replacing placeholders privately:

    SCHEDULING_ENABLED=1
    SCHEDULING_TEST_MODE=1
    SCHEDULING_NGROK_ENABLED=1
    SCHEDULING_NGROK_DOMAIN=YOUR_ASSIGNED_NGROK_DOMAIN
    NGROK_AUTHTOKEN=YOUR_PRIVATE_NGROK_AUTHTOKEN
    DISCORD_CLIENT_ID=YOUR_EXISTING_DISCORD_APPLICATION_ID
    DISCORD_CLIENT_SECRET=YOUR_PRIVATE_DISCORD_OAUTH_CLIENT_SECRET
    SCHEDULING_SESSION_SECRET=YOUR_PRIVATE_RANDOM_SECRET_32_CHARACTERS_OR_LONGER
    SCHEDULING_HOST=127.0.0.1
    SCHEDULING_PORT=8791

**Do not put https://, a path or a port in SCHEDULING_NGROK_DOMAIN**.
WinterBot computes SCHEDULING_BASE_URL automatically from the domain and
requires the forwarded URL to match exactly. If an old
SCHEDULING_BASE_URL entry exists, remove it or set it to precisely
https://YOUR_ASSIGNED_NGROK_DOMAIN with no trailing path.

To generate the private session secret, on a Windows PC open PowerShell:

    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 48
    $rng.GetBytes($bytes)
    $rng.Dispose()
    [Convert]::ToBase64String($bytes)

Copy the output only into SCHEDULING_SESSION_SECRET in your private .env.
Do not paste it in chat.

**The Management role and both checkmark-role IDs are BUILT IN.** Do not
add SCHEDULING_MANAGEMENT_ROLE_ID or SCHEDULING_VERIFIED_ROLE_IDS unless
you actually need to override them after changing your Discord roles.

You do not need NODE_PACKAGES, a second ngrok process, or any Startup
Command changes. The official @ngrok/ngrok SDK is a declared production
dependency installed by the normal npm install during startup.

## 4. Restart WinterBot once to activate the settings

The host startup script will pull the newest main code and install npm
dependencies. In the DiscordBotHosting **Console**, look for:

    Scheduling web server running at http://127.0.0.1:8791
    Scheduling TEST planner accessible at https://YOUR_ASSIGNED_NGROK_DOMAIN

The second line is proof that the ngrok SDK established the named HTTPS
endpoint. If it is missing, look for scheduling.optionalStartup errors.
Possible causes are invalid secrets, unavailable domain, exceeded ngrok
limits, blocked outbound ngrok traffic, or missing Discord channel
permissions. Scheduling errors must not stop the original WinterBot bot.

Go to:

    https://YOUR_ASSIGNED_NGROK_DOMAIN/health

It should return JSON like:

    {"ok":true,"mode":"live","rounds":0}

The round count can vary. Free ngrok accounts sometimes show a warning
page first; choose to visit the site and then recheck the health endpoint.

## 5. Test in #bot-logs

Use Discord #bot-logs in the Official Crashday guild:

https://discord.com/channels/199916140183420928/332575578383187970

Enter:

    /schedule create

You should receive a private setup wizard link. Create a small test
round, then check the following:

1. Only #bot-logs gets the polished **[TEST]** invitation. Neither
   League nor Public receives anything, even if Public was selected.
2. Discord OAuth authenticates Management and other existing server users.
3. Each participant needs BOTH checkmark roles and permission to read
   #bot-logs. Add available/unavailable dates, multiple time ranges and
   maximum staying time.
4. Management closes collection, checks ranked options, and may initiate
   voting. The invitation updates in the same #bot-logs message.
5. Management approves a final choice. #bot-logs receives a
   **[TEST ONLY]** event simulation: NO Discord Scheduled Event is created.

## 6. Turn it off when finished

In the bot's .env, change:

    SCHEDULING_ENABLED=0

Restart. The planner and tunnel stop, and the normal event tracker
continues unaffected. You can preserve the ngrok domain and configuration
for another test.

Never enable SCHEDULING_TEST_MODE=0 while
SCHEDULING_NGROK_ENABLED=1. WinterBot intentionally rejects this
combination. Production scheduling and a permanent hosting solution
require separate review.

## Troubleshooting and security

- **No /schedule command:** confirm the post-merge code was pulled, the
  scheduler started, and the bot was originally added with application
  commands permission.
- **No HTTPS URL in logs:** check that the ngrok authtoken is valid, the
  domain belongs to your account, and DiscordBotHosting allows outbound
  ngrok connections.
- **Discord OAuth error:** check the exact Redirect URI in the Developer
  Portal and that the Client ID and Client Secret are from the same
  existing WinterBot application.
- **403 on availability:** test members need both checkmark roles AND
  access to #bot-logs. Management/owner can open the organizer board
  even if their verified-user roles differ.
- **Stale page/first-visit warning:** visit the ngrok link once in a normal
  browser; free ngrok endpoints can display an anti-phishing interstitial.
- **Do not expose** tokens in screenshots, GitHub commits, Discord
  messages, public ngrok URL query strings, or this chat.

Important: The host-provided public IP:port allocation does not
automatically provide the HTTPS reverse proxy that Discord OAuth needs.
The SDK uses an outbound ngrok connection instead and keeps its backend
HTTP listener on 127.0.0.1.
