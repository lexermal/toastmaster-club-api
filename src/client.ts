import { obtainClearance, type ClearanceOptions } from './cloudflare.js';
import { CookieJar, isCloudflareChallenge, loadSession, saveSession } from './http.js';
import { parseBoard } from './parsers/board.js';
import { isLoggedIn, parseSession } from './parsers/common.js';
import { parseAgenda, parseMeeting } from './parsers/meeting.js';
import {
  formFieldNames,
  parseMembers,
  parseSpeechDates,
  parseSpeechList,
  parseSpeechWorkbook,
  parseTableTopics,
  serializeForm,
} from './parsers/misc.js';
import type {
  Agenda,
  AttendanceAnswer,
  ClubSpeech,
  MeetingAttendee,
  MeetingDetails,
  Member,
  Session,
  SignupBoard,
  SpeechOptions,
  SpeechRequest,
  TableTopicsCandidate,
  TableTopicsSpeaker,
} from './types.js';

export interface TmClubOptions {
  username: string;
  password: string;
  /** easy-Speak install: "tmclub.eu" (mainland Europe), "toastmasterclub.org" (UK/IE) or "easy-speak.org". */
  host?: string;
  /** Persist cookies + User-Agent here so the browser is only needed when Cloudflare clearance expires. */
  sessionFile?: string;
  clearance?: ClearanceOptions;
  /**
   * Interface language to switch to after login (`lang_swap.php`). Parsing relies mostly on
   * structure, but a few labels (agenda theme/venue) are read as English text. `null` keeps yours.
   */
  language?: string | null;
  /**
   * Club to act on by default. easy-Speak remembers the last club you viewed server-side,
   * so without this the "current" club is whatever was opened last (also in your browser).
   */
  clubId?: string;
}

interface Response {
  status: number;
  html: string;
  url: string;
}

type RequestInit = { method?: 'GET' | 'POST'; form?: URLSearchParams | Record<string, string> };

const ATTEND_CODE: Record<AttendanceAnswer, string> = { yes: '1', no: '2', maybe: '5' };

export class TmClubClient {
  readonly host: string;
  private jar = new CookieJar();
  private userAgent = '';
  private session?: Session;
  private clearancePending?: Promise<void>;
  private clearanceFailure?: Error;

  private constructor(private opts: TmClubOptions) {
    this.host = opts.host ?? 'tmclub.eu';
  }

  /** Creates a client, restoring a saved session when possible and logging in otherwise. */
  static async connect(opts: TmClubOptions) {
    const client = new TmClubClient(opts);
    const saved = opts.sessionFile ? await loadSession(opts.sessionFile) : undefined;
    if (saved) {
      client.userAgent = saved.userAgent;
      client.jar = new CookieJar(saved.cookies);
    }
    const home = await client.request('index.php');
    if (!isLoggedIn(home.html)) await client.login();
    return client;
  }

  async login() {
    await this.request('login.php', {
      method: 'POST',
      form: { username: this.opts.username, password: this.opts.password, autologin: 'on', redirect: '', login: 'Log in' },
    });
    const home = await this.request('index.php');
    if (!isLoggedIn(home.html)) throw new Error('Login failed: check username/password.');
    if (this.opts.language !== null) await this.request(`lang_swap.php?lang=${this.opts.language ?? 'english'}`);
    this.session = undefined;
    return this.whoami();
  }

  /** Who is logged in and which clubs they belong to. */
  async whoami(): Promise<Session> {
    // signup.php carries the club list, your user id and the current club in its sidebar.
    this.session ??= parseSession((await this.page(this.clubPath('signup.php'))).html);
    return this.session;
  }

  /** The "Sign Up for Meetings" board: upcoming meetings, your attendance and every role slot. */
  async getBoard(opts: { clubId?: string; start?: number } = {}): Promise<SignupBoard> {
    const path = this.clubPath('signup.php', opts.clubId);
    const res = opts.start
      ? await this.page(path, { method: 'POST', form: { start: String(opts.start) } })
      : await this.page(path);
    return parseBoard(res.html);
  }

  /** Meeting header, full attendance list (with answers) and roles. `'next'` = club's next meeting. */
  async getMeeting(meetingId: string | 'next', opts: { clubId?: string } = {}): Promise<MeetingDetails> {
    const path =
      meetingId === 'next'
        ? `view_meeting.php?c=${await this.clubIdOr(opts.clubId)}&show=next`
        : `view_meeting.php?t=${meetingId}`;
    return parseMeeting((await this.page(path)).html);
  }

  async getAttendees(meetingId: string | 'next', opts: { clubId?: string } = {}): Promise<MeetingAttendee[]> {
    return (await this.getMeeting(meetingId, opts)).attendees;
  }

  /** Structured, timed agenda (from the printable agenda). */
  async getAgenda(meetingId: string | 'next', opts: { clubId?: string } = {}): Promise<Agenda> {
    const id = meetingId === 'next' ? (await this.getMeeting('next', opts)).meetingId : meetingId;
    // The print view has no navigation bar, so it can't be used to detect a lost login.
    await this.whoami();
    return parseAgenda((await this.request(`viewagenda.php?t=${id}&pr=1`)).html, id);
  }

  async getMembers(opts: { clubId?: string } = {}): Promise<Member[]> {
    return parseMembers((await this.page(this.clubPath('memberlist.php', opts.clubId))).html);
  }

  /**
   * Answer the attendance question. `no` goes through easy-Speak's decline popup and accepts
   * an optional reason. `userId` lets officers answer for another member.
   */
  async setAttendance(meetingId: string, answer: AttendanceAnswer, opts: { comment?: string; userId?: string } = {}) {
    const userId = opts.userId ?? (await this.whoami()).userId;
    if (answer === 'no') {
      await this.page('tm_decline.php', {
        method: 'POST',
        form: {
          page: 'view_meeting',
          a: '0',
          z: '2',
          mode: 'popup',
          t: meetingId,
          action: 'confirmattendance',
          u: userId,
          att: '0',
          [`comment[${userId}]`]: opts.comment ?? '',
          confirm: 'OK',
        },
        checkLogin: false,
      });
    } else {
      await this.page(`signup.php?action=attend&z=${ATTEND_CODE[answer]}&t=${meetingId}&u=${userId}`, {
        method: 'POST',
        form: { start: '0' },
      });
    }
    return this.attendeeOf(meetingId, userId);
  }

  /**
   * Claim an open role slot for yourself. This commits immediately, is visible to the whole club,
   * and also marks you as attending. Get `roleItemId`/`slot` from `getBoard()` or `getMeeting()`.
   */
  async signUpForRole(meetingId: string, roleItemId: string, slot = 0) {
    await this.page(`signup.php?action=volunteer&t=${meetingId}&r=${roleItemId}&n=${slot}&att=1`);
    return this.getMeeting(meetingId);
  }

  /** Like `signUpForRole` but looks the role up by name (case-insensitive substring) on the board. */
  async signUpForRoleByName(meetingId: string, roleName: string, opts: { slot?: number; clubId?: string } = {}) {
    const board = await this.getBoard({ clubId: opts.clubId });
    const needle = roleName.toLowerCase();
    const role = board.roles.find(
      (r) => r.meetingId === meetingId && r.role.toLowerCase().includes(needle) && r.slots.some((s) => s.open),
    );
    const slot = role?.slots.find((s) => s.open && (opts.slot === undefined || s.slot === opts.slot));
    if (!role?.roleItemId || !slot) throw new Error(`No open "${roleName}" slot for meeting ${meetingId}.`);
    return this.signUpForRole(meetingId, role.roleItemId, slot.slot);
  }

  /**
   * Give up a role you hold (the "I DECLINE the role" button). `assignmentId` comes from
   * `getMeeting().roles[].assignmentId`. By default you stay marked as attending;
   * `attending: false` also declines the meeting.
   */
  async declineRole(meetingId: string, assignmentId: string, opts: { comment?: string; attending?: boolean; userId?: string } = {}) {
    const userId = opts.userId ?? (await this.whoami()).userId;
    await this.page('tm_decline.php', {
      method: 'POST',
      form: {
        page: 'view_meeting',
        a: assignmentId,
        z: '2',
        mode: 'popup',
        t: meetingId,
        action: 'confirmrole',
        u: userId,
        att: '1',
        [`comment[${userId}]`]: opts.comment ?? '',
        // The popup's two submit buttons: keep attending vs. also decline the meeting.
        ...(opts.attending === false ? { cancel: 'I am NOT attending' } : { confirm: 'I WILL be there' }),
      },
      checkLogin: false,
    });
    return this.getMeeting(meetingId);
  }

  /** Workbooks, projects and meeting dates available for a speech request. */
  async getSpeechOptions(opts: { clubId?: string; userWorkbookId?: string; userId?: string } = {}): Promise<SpeechOptions> {
    const base = await this.speechForm(opts);
    if (opts.userWorkbookId) base.cached_user_workbook = opts.userWorkbookId;
    const wb = parseSpeechWorkbook((await this.page('request_speech.php?mode=selectworkbook', { method: 'POST', form: base, checkLogin: false })).html);
    const dates = parseSpeechDates((await this.page('request_speech.php?mode=choosedate', { method: 'POST', form: base, checkLogin: false })).html);
    return { ...wb, dates };
  }

  /** Submit a speech request to the VP Education (same as the "Request a speech" popup). */
  async requestSpeech(req: SpeechRequest) {
    if (!req.preferredDates.length || req.preferredDates.length > 3) throw new Error('Give 1–3 preferred dates.');
    const form = await this.speechForm(req);
    const [d1, d2 = '', d3 = ''] = req.preferredDates.map(String);
    Object.assign(form, {
      cached_user_workbook: req.userWorkbookId,
      cached_task: req.taskId,
      cached_title: req.title,
      speech_title: req.title,
      cached_introduction: req.introduction ?? '',
      introduction: req.introduction ?? '',
      cached_ready_date1: d1,
      cached_ready_date2: d2,
      cached_ready_date3: d3,
    });
    // The save page gives no reliable success marker, so confirm by diffing the club's speech list.
    const before = new Set((await this.getSpeechList({ clubId: form.cached_club })).map((s) => s.speechId));
    await this.page('request_speech.php?action=savespeech', { method: 'POST', form, checkLogin: false });
    const created = (await this.getSpeechList({ clubId: form.cached_club })).find(
      (s) => !before.has(s.speechId) && s.speaker.userId === form.cached_user,
    );
    if (!created) throw new Error('Speech request did not show up in the speech list.');
    return created;
  }

  /** Withdraw a speech request (speech id from getSpeechList). */
  async cancelSpeechRequest(speechId: string, opts: { clubId?: string; userId?: string } = {}) {
    const form = await this.speechForm(opts);
    await this.page(`request_speech.php?action=delete&s=${speechId}&u=${form.cached_user}`, {
      method: 'POST',
      form,
      checkLogin: false,
    });
    return !(await this.getSpeechList(opts)).some((s) => s.speechId === speechId);
  }

  // ---- Table Topics ----------------------------------------------------------------------

  /** Table Topics speakers already added, plus everyone who can be added (with attendance flag). */
  async getTableTopics(meetingId: string): Promise<{ speakers: TableTopicsSpeaker[]; candidates: TableTopicsCandidate[] }> {
    return parseTableTopics((await this.page(`view_meeting.php?t=${meetingId}`)).html);
  }

  /** Add a Table Topics speaker, optionally with the time they spoke. */
  async addTableTopicsSpeaker(meetingId: string, userId: string, opts: { durationSeconds?: number } = {}) {
    const form: Record<string, string> = { action: 'add', meeting_id: meetingId, speaker_id: userId };
    if (opts.durationSeconds) form.duration = String(opts.durationSeconds);
    await this.tableTopicsCall(form);
    return (await this.getTableTopics(meetingId)).speakers;
  }

  async removeTableTopicsSpeaker(meetingId: string, assignmentId: string) {
    await this.tableTopicsCall({ action: 'remove', meeting_id: meetingId, assignment_id: assignmentId });
    return (await this.getTableTopics(meetingId)).speakers;
  }

  // ---- Speech requests (VP Education) -----------------------------------------------------

  /**
   * The club's speech list. `status: 'requested'` rows are the VPE's queue of speeches waiting
   * for a slot; `scheduled` ones have a date; `completed` are recent speeches.
   */
  async getSpeechList(opts: { clubId?: string } = {}): Promise<ClubSpeech[]> {
    return parseSpeechList((await this.page(this.clubPath('tm_all_speeches.php', opts.clubId))).html);
  }

  /** Requests still waiting for a meeting slot. */
  async getSpeechQueue(opts: { clubId?: string } = {}) {
    return (await this.getSpeechList(opts)).filter((s) => s.status === 'requested');
  }

  /**
   * Put a requested speech into a Speaker slot of a meeting (officer). `slot` is the speaker
   * number (1 = 1st Speaker). The Speaker line's `roleItemId` is read from the meeting page,
   * which only exposes it to officers; pass it explicitly to skip that lookup.
   */
  async assignSpeech(meetingId: string, speechId: string, slot: number, opts: { roleItemId?: string } = {}) {
    let roleItemId = opts.roleItemId;
    if (!roleItemId) {
      const meeting = await this.getMeeting(meetingId);
      roleItemId = meeting.roles.find((r) => /speaker/i.test(r.role) && r.roleItemId)?.roleItemId;
      if (!roleItemId) throw new Error('Speaker role id not visible — assigning speeches needs officer rights.');
    }
    return this.meetingAction(meetingId, `action=assignspeech&t=${meetingId}&s=${speechId}&n=${slot}&r=${roleItemId}`);
  }

  // ---- Officer / admin operations ----------------------------------------------------------
  // These replay the meeting page's own form actions and need officer rights on the club.

  /** Assign a member to a role slot (officer). */
  assignRole(meetingId: string, roleItemId: string, slot: number, userId: string) {
    return this.meetingAction(meetingId, `action=assignrole&t=${meetingId}&r=${roleItemId}&n=${slot}&u=${userId}`);
  }

  /** Remove whoever holds a role slot (officer). */
  unassignRole(meetingId: string, roleItemId: string, slot: number) {
    return this.meetingAction(meetingId, `action=unassignrole&t=${meetingId}&r=${roleItemId}&n=${slot}`);
  }

  /**
   * Save editable meeting fields (theme, word of the day, ...) through the meeting form.
   * Keys are matched case-insensitively as substrings of the form's field names, e.g. `{ theme: 'Courage' }`.
   */
  async setMeetingFields(meetingId: string, fields: Record<string, string>) {
    const page = await this.page(`view_meeting.php?t=${meetingId}`);
    const names = formFieldNames(page.html, 'form[name="AssignmentFrm"]');
    const body = serializeForm(page.html, 'form[name="AssignmentFrm"]')!;
    for (const [key, value] of Object.entries(fields)) {
      const name = names.find((n) => n.toLowerCase().includes(key.toLowerCase()));
      if (!name) throw new Error(`Meeting form has no "${key}" field — are you an officer of this club?`);
      body.set(name, value);
    }
    await this.page(`view_meeting.php?t=${meetingId}`, { method: 'POST', form: body });
    return this.getMeeting(meetingId);
  }

  setTheme(meetingId: string, theme: string) {
    return this.setMeetingFields(meetingId, { theme });
  }

  setWordOfTheDay(meetingId: string, word: string) {
    return this.setMeetingFields(meetingId, { word: word });
  }

  // ---- internals ---------------------------------------------------------------------------

  private async tableTopicsCall(form: Record<string, string>) {
    const res = await this.request('ajax/ajax_table_topics.php', { method: 'POST', form });
    let json: { success?: boolean; message?: string } = {};
    try {
      json = JSON.parse(res.html);
    } catch {
      // non-JSON body (e.g. HTTP 500) → reported below
    }
    if (!json.success) throw new Error(`Table Topics: ${json.message ?? `HTTP ${res.status}`}`);
  }

  private async meetingAction(meetingId: string, query: string) {
    const page = await this.page(`view_meeting.php?t=${meetingId}`);
    const body = serializeForm(page.html, 'form[name="AssignmentFrm"]');
    if (!body) throw new Error(`Meeting ${meetingId} not found.`);
    await this.page(`view_meeting.php?${query}`, { method: 'POST', form: body });
    return this.getMeeting(meetingId);
  }

  private async attendeeOf(meetingId: string, userId: string) {
    const meeting = await this.getMeeting(meetingId);
    return meeting.attendees.find((a) => a.userId === userId);
  }

  private clubPath(path: string, clubId = this.opts.clubId) {
    return clubId ? `${path}${path.includes('?') ? '&' : '?'}c=${clubId}` : path;
  }

  private async clubIdOr(clubId = this.opts.clubId) {
    return clubId ?? (await this.whoami()).currentClubId;
  }

  private async speechForm(opts: { clubId?: string; userId?: string }): Promise<Record<string, string>> {
    return {
      cached_user: opts.userId ?? (await this.whoami()).userId,
      cached_club: await this.clubIdOr(opts.clubId),
    };
  }

  /** A member page: re-logs in once if the session has expired. */
  private async page(path: string, init: RequestInit & { checkLogin?: boolean } = {}): Promise<Response> {
    const res = await this.request(path, init);
    if (init.checkLogin === false || isLoggedIn(res.html)) return res;
    await this.login();
    return this.request(path, init);
  }

  /** Raw request with cookie jar, manual redirects and automatic Cloudflare clearance. */
  async request(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    if (!this.jar.has('cf_clearance')) await this.refreshClearance();
    let url = new URL(path, `https://${this.host}/`).toString();
    let method = init.method ?? 'GET';
    let body: string | undefined = init.form ? new URLSearchParams(init.form).toString() : undefined;
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'manual',
        headers: {
          'user-agent': this.userAgent,
          cookie: this.jar.header(),
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
      });
      this.jar.applySetCookie(res.headers.getSetCookie(), new URL(url).hostname);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).toString();
        method = 'GET';
        body = undefined;
        continue;
      }
      const html = await res.text();
      if (isCloudflareChallenge(res.status, html)) {
        if (retried) throw new Error('Blocked by Cloudflare even after refreshing clearance.');
        await this.refreshClearance();
        return this.request(path, init, true);
      }
      await this.persist();
      return { status: res.status, html, url };
    }
    throw new Error(`Too many redirects for ${path}`);
  }

  /**
   * Allow a new Cloudflare attempt after one failed. Failures are sticky on purpose: retrying
   * with fresh browsers makes Cloudflare more suspicious, so only a deliberate call re-arms it.
   */
  resetClearance() {
    this.clearanceFailure = undefined;
  }

  private refreshClearance() {
    if (this.clearanceFailure) return Promise.reject(this.clearanceFailure);
    // Single flight: concurrent calls share one browser / one verification link.
    this.clearancePending ??= (async () => {
      try {
        const c = await obtainClearance(this.host, this.opts.clearance);
        this.userAgent = c.userAgent;
        for (const cookie of c.cookies) this.jar.set(cookie);
        await this.persist();
      } catch (e) {
        this.clearanceFailure = e as Error;
        throw e;
      } finally {
        this.clearancePending = undefined;
      }
    })();
    return this.clearancePending;
  }

  private async persist() {
    if (this.opts.sessionFile) await saveSession(this.opts.sessionFile, { userAgent: this.userAgent, cookies: this.jar.list() });
  }
}
