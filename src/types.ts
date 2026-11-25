/** A meeting's attendance answer as shown by easy-Speak. */
export type AttendanceStatus =
  | 'attending'
  | 'online'
  | 'notAttending'
  | 'maybe'
  /** The member never answered. */
  | 'unknown';

/** What you can answer when confirming attendance. */
export type AttendanceAnswer = 'yes' | 'no' | 'maybe';

export interface UserRef {
  userId: string;
  name: string;
}

export interface Session {
  userId: string;
  username: string;
  fullName: string;
  /** Club the server currently has selected for you. */
  currentClubId: string;
  clubs: ClubRef[];
}

export interface ClubRef {
  clubId: string;
  name: string;
}

export interface BoardMeeting {
  meetingId: string;
  /** Date as printed on the board, e.g. "09 Nov 26". */
  label: string;
  /** Tooltip of the column, usually "Future Meeting - <theme>". */
  title: string;
  /** Your own attendance for this meeting. */
  myAttendance: AttendanceStatus;
}

export interface BoardSlot {
  /** 0 for single-slot roles, 1..n for numbered slots (Speaker 1, Evaluator 2, ...). */
  slot: number;
  occupant?: UserRef;
  /** True when you can claim this slot yourself (a volunteer link is shown). */
  open: boolean;
}

export interface BoardRole {
  meetingId: string;
  role: string;
  /** Agenda-line id ("r" parameter). Per meeting — never reuse across meetings. Undefined when no slot exposes it. */
  roleItemId?: string;
  slots: BoardSlot[];
}

export interface SignupBoard {
  clubId?: string;
  userId?: string;
  meetings: BoardMeeting[];
  roles: BoardRole[];
}

export interface MeetingAttendee extends UserRef {
  /** Section on the page: "Member", "Inactive Member", "Member from other club", "Guest that visited the club". */
  group: string;
  status: AttendanceStatus;
  /** Tooltip with who changed it and when, if any. */
  statusNote?: string;
  /** Free-text comment (e.g. reason for declining). */
  comment?: string;
}

export interface MeetingRole {
  role: string;
  /**
   * Agenda-line id + slot, when the page exposes them: always for open slots, and for every
   * slot when you have officer rights (needed for assignRole / unassignRole / assignSpeech).
   */
  roleItemId?: string;
  slot?: number;
  /** Id of this person's assignment; shown for your own roles. Pass to declineRole. */
  assignmentId?: string;
  presenter?: UserRef;
  /** Whether the presenter has accepted the role (tick vs. question mark). */
  confirmed?: boolean;
  /** Extra text in the presenter cell (speech title, project, ...). */
  details?: string;
  /** Present when the slot is open for self sign-up. */
  volunteer?: { roleItemId: string; slot: number };
}

export interface MeetingDetails {
  meetingId: string;
  clubName: string;
  /** Start as ISO string (from the server's unix timestamp). */
  startsAt?: string;
  dateText: string;
  meetingNumber?: number;
  durationText?: string;
  venue?: string;
  wordOfTheDay?: string;
  theme?: string;
  previousMeetingId?: string;
  nextMeetingId?: string;
  attendees: MeetingAttendee[];
  roles: MeetingRole[];
  tableTopicsSpeakers: TableTopicsSpeaker[];
}

export interface TableTopicsSpeaker {
  /** Id of this assignment; pass to removeTableTopicsSpeaker. */
  assignmentId?: string;
  name: string;
  userId?: string;
  /** Speaking time as shown, e.g. "1:45". */
  duration?: string;
}

export interface TableTopicsCandidate extends UserRef {
  /** Whether the member confirmed attendance for this meeting. */
  attending: boolean;
}

export type SpeechStatus = 'requested' | 'scheduled' | 'completed';

/** One row of the club's speech list (`tm_all_speeches.php`). */
export interface ClubSpeech {
  /** Speech id; pass to assignSpeech. */
  speechId: string;
  speaker: UserRef;
  workbook: string;
  /** Pathways project, e.g. "3 - Introduction to Vocal Variety and Body Language". */
  project: string;
  /** Allowed time, e.g. "5-7 Mins". */
  timing?: string;
  title: string;
  status: SpeechStatus;
  /** Dates as printed ("11 Oct 26"); undefined when shown as "-". */
  requestedOn?: string;
  preferences: string[];
  scheduledFor?: string;
  /** Meeting the speech is scheduled for / was given at, when linked. */
  meetingId?: string;
}

export interface AgendaItem {
  /** Start time "HH:MM"; undefined when the line continues the previous block. */
  time?: string;
  role: string;
  presenter?: string;
  /** False when the presenter has not confirmed yet (shown with a trailing "?"). */
  presenterConfirmed?: boolean;
  event: string;
  timing?: { green: string; amber: string; red: string };
}

export interface Agenda {
  meetingId: string;
  clubName: string;
  heading: string;
  meetingNumber?: number;
  theme?: string;
  venue?: string;
  items: AgendaItem[];
}

export interface Member extends UserRef {
  /** Club offices (President, VPE, ...) or ["Member"]. */
  clubRoles: string[];
}

export interface SpeechTask {
  taskId: string;
  title: string;
  timing?: string;
  status?: string;
}

export interface SpeechDateOption {
  /** Unix timestamp of the meeting start; the value easy-Speak expects. */
  date: number;
  label: string;
  info: string;
}

export interface SpeechOptions {
  userWorkbookId?: string;
  workbookName?: string;
  /** Other workbooks you have started (id → name). */
  userWorkbooks: { userWorkbookId: string; name: string }[];
  tasks: SpeechTask[];
  dates: SpeechDateOption[];
}

export interface SpeechRequest {
  userWorkbookId: string;
  taskId: string;
  title: string;
  introduction?: string;
  /** Up to three meeting timestamps in order of preference (see SpeechOptions.dates). */
  preferredDates: number[];
  clubId?: string;
  /** Request on behalf of another member (admins). Defaults to you. */
  userId?: string;
}
