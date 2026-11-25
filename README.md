# tmclub-api

Unofficial Node.js client for **easy-Speak** — the meeting system behind
[tmclub.eu](https://tmclub.eu) (mainland Europe), toastmasterclub.org (UK/IE) and easy-speak.org.
Manage Toastmasters club meetings from code: attendance, roles, agendas, attendee lists and
speech requests.

easy-Speak has no API, so this library speaks to the website the way a browser does and parses
the HTML into typed objects.

## Install

```bash
npm i tmclub-api playwright
npx playwright install chromium
```

`playwright` is only used to pass Cloudflare's "Just a moment…" check (see below).

## Quick start

```ts
import { TmClubClient } from 'tmclub-api';

const tm = await TmClubClient.connect({
  username: process.env.TMCLUB_USER!,
  password: process.env.TMCLUB_PASSWORD!,
  clubId: '541', // optional: club to act on by default
  sessionFile: '.tmclub-session.json', // optional: reuse cookies between runs
});

const me = await tm.whoami(); // { userId, username, fullName, currentClubId, clubs }
const next = await tm.getMeeting('next'); // header, attendees with answers, roles
const agenda = await tm.getAgenda(next.meetingId); // timed agenda with presenters
const board = await tm.getBoard(); // upcoming meetings × role slots

await tm.setAttendance(next.meetingId, 'yes'); // 'yes' | 'no' | 'maybe'
await tm.setAttendance(next.meetingId, 'no', { comment: 'Travelling' });
await tm.signUpForRoleByName(next.meetingId, 'Timekeeper');
```

## API

| Method | What it does |
|---|---|
| `whoami()` | Logged-in user, their clubs, and the club the server has selected |
| `getBoard({ clubId?, start? })` | "Sign Up for Meetings" board: meetings, your attendance, every role slot with occupant / open flag and `roleItemId` |
| `getMeeting(id \| 'next', { clubId? })` | Date, number, venue, theme, word of the day, all attendees with their answer, roles with presenter and confirmation |
| `getAttendees(id \| 'next')` | Just the attendee list (`attending`, `online`, `notAttending`, `maybe`, `unknown`) |
| `getAgenda(id \| 'next')` | Structured agenda: time, role, presenter, event, green/amber/red timings |
| `getMembers({ clubId? })` | Roster with user ids and club offices (no contact details) |
| `setAttendance(id, answer, { comment?, userId? })` | Answer the attendance question; `no` accepts a reason |
| `signUpForRole(id, roleItemId, slot?)` | Claim an open role slot |
| `signUpForRoleByName(id, name, { slot? })` | Same, looked up by role name |
| `declineRole(id, assignmentId, { comment?, attending? })` | Give up a role you hold (`assignmentId` from `getMeeting().roles`); the comment is shown publicly under your name |
| `getSpeechOptions({ clubId?, userWorkbookId? })` | Your Pathways workbook, its projects and the meeting dates you can pick |
| `requestSpeech({ userWorkbookId, taskId, title, preferredDates, introduction? })` | Send a speech request to the VP Education; returns the new speech-list entry |
| `cancelSpeechRequest(speechId)` | Withdraw a speech request |
| `getSpeechList({ clubId? })` | Club speech list: requested, scheduled and recent speeches with speech ids, projects, preferred dates |
| `getSpeechQueue({ clubId? })` | Only the requests still waiting for a slot (the VPE's queue) |
| `getTableTopics(id)` | Table Topics speakers of a meeting, plus everyone who can be added |
| `addTableTopicsSpeaker(id, userId, { durationSeconds? })` | Add a Table Topics speaker |
| `removeTableTopicsSpeaker(id, assignmentId)` | Remove one |

Officer operations (need officer rights in the club; written against the site's own form
actions but **not yet verified with an officer account**):

| Method | What it does |
|---|---|
| `assignRole(id, roleItemId, slot, userId)` | Put a member on a role |
| `unassignRole(id, roleItemId, slot)` | Clear a role slot |
| `assignSpeech(id, speechId, slot, { roleItemId? })` | Put a queued speech into the n-th Speaker slot |
| `setTheme(id, theme)` / `setWordOfTheDay(id, word)` | Edit the meeting theme / word of the day |
| `setMeetingFields(id, { field: value })` | Any editable field on the meeting form |

Everything that writes takes effect immediately and is visible to the whole club. Claiming a
role also marks you as attending.

## Things to know

- **Cloudflare.** Every page sits behind a managed challenge that plain HTTP cannot pass. It is
  not a captcha: a real browser usually passes it on its own in a few seconds. On the first call (and
  whenever the cookie is rejected) the client opens Chromium, waits for the check, and copies the
  `cf_clearance` cookie (valid ~1 year) and the browser's User-Agent. All other requests are plain
  `fetch`. Headless Chromium is rejected, so the browser runs headed — on servers inside a virtual
  display (see [Deploying](#deploying-docker--kubernetes)). If Cloudflare escalates to a human
  check, see [When Cloudflare wants a human](#when-cloudflare-wants-a-human). To reuse a browser you already have
  running, start it with `--remote-debugging-port=9333` and pass
  `clearance: { cdpUrl: 'http://localhost:9333' }`.
- **Current club is server-side state.** easy-Speak remembers the last club you looked at — also
  across your browser. Pass `clubId` (option or per call) when you're in more than one club.
- **Language.** After login the client switches the interface to English (`lang_swap.php`) so the
  few text-based fields parse reliably. This may change your account's display language; pass
  `language: null` to keep yours.
- **Ids.** `meetingId` (`t`), `userId` (`u`), `clubId` (`c`) are easy-Speak's own ids.
  `roleItemId` (`r`) identifies an agenda line *in one meeting* — always re-read it, never reuse it
  across meetings.

## When Cloudflare wants a human

Usually the browser passes Cloudflare's check by itself. Sometimes Cloudflare escalates to the
"Verify you are human" checkbox. The library then gives you a link to a live view of its browser
where a person clicks the checkbox — it never tries to solve it itself and never retries on its own
(repeated attempts make Cloudflare more suspicious).

```ts
import { TmClubClient, HumanVerificationError } from 'tmclub-api';

const tm = await TmClubClient.connect({
  username, password, clubId: '541',
  sessionFile: '/data/tmclub-session.json',
  clearance: {
    onHumanVerification: async ({ url, expiresAt }) => {
      await sendTelegram(`easy-Speak needs a human check: ${url} (valid until ${expiresAt.toISOString()})`);
    },
    verificationServer: { port: 8732, publicUrl: 'https://tm-verify.example.com' },
  },
});
```

- The check runs at most once at a time; calls made meanwhile wait for the same attempt.
- The triggering call waits until the check is solved (default up to 15 min, `humanTimeoutMs`).
- If nobody solves it, the call throws `HumanVerificationError` (`reason: 'timeout'`) and **every
  later call fails immediately** until you call `tm.resetClearance()` — so a failed check never
  turns into a loop of new browsers.
- Without `onHumanVerification` the escalated check throws `HumanVerificationError`
  (`reason: 'required'`) right away.
- The page lives only while a check is pending, at an unguessable URL. Still, anyone holding the
  link controls that browser tab until it closes — only send it to private channels and serve it
  over HTTPS.

## Deploying (Docker / Kubernetes)

Run Node under a virtual X display so the headed Chromium works without a screen.

```dockerfile
FROM mcr.microsoft.com/playwright:v1.64.1-noble   # Chromium + Xvfb included
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["xvfb-run", "-a", "node", "dist/server.js"]
```

- **Keep `sessionFile` on a volume (PVC).** The Cloudflare cookie lasts about a year; with a saved
  session the browser almost never starts, which is also what keeps the human check away.
- **Expose the verification port** (default 8732) through a Service + Ingress and set
  `verificationServer.publicUrl` to that address.
- `cf_clearance` is tied to the User-Agent and the egress IP. The browser and the `fetch` calls
  run in the same pod, so they match. The human check must also be solved through this pod's
  browser (which the link does) — solving it on your own machine wouldn't help.
- Give the pod ~1 GiB memory and `/dev/shm` space (an `emptyDir` with `medium: Memory`) for
  Chromium; it only runs while getting clearance.
- Keep `username`/`password` in a Kubernetes Secret.

## License

MIT. Not affiliated with Toastmasters International or easy-Speak.
