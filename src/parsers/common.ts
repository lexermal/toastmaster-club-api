import * as cheerio from 'cheerio';
import type { AttendanceStatus, ClubRef, Session } from '../types.js';

export type $ = cheerio.CheerioAPI;

export const load = (html: string) => cheerio.load(html);

export const clean = (s: string | undefined) => (s ?? '').replace(/[\s ]+/g, ' ').trim();

export function param(url: string | undefined, name: string) {
  const m = (url ?? '').replace(/&amp;/g, '&').match(new RegExp(`[?&]${name}=([^&'"]*)`));
  return m?.[1];
}

/** User id from a miniprofile/viewprofile link or onclick handler. */
export function userIdFrom(attr: string | undefined) {
  return (attr ?? '').match(/[?&]u=(\d+)/)?.[1];
}

/** Attendance icons are language-independent, so status is derived from them, not from the label. */
export function statusFromIcon(src: string | undefined): AttendanceStatus {
  const s = src ?? '';
  if (/icon_tickV/.test(s)) return 'online';
  if (/icon_tick/.test(s)) return 'attending';
  if (/icon_cross/.test(s)) return 'notAttending';
  if (/icon_question_grey/.test(s)) return 'unknown';
  if (/icon_question/.test(s)) return 'maybe';
  return 'unknown';
}

export function isLoggedIn(html: string) {
  return /login\.php\?logout=true/.test(html);
}

/** Reads who is logged in from the sidebar/header present on every member page. */
export function parseSession(html: string): Session {
  const $ = load(html);
  const welcome = $('a[href^="profile.php?mode=editprofile"]').first();
  const fullName = clean(welcome.text()).replace(/^(Welcome back|Willkommen zurück)\s*/i, '');
  const username = clean(welcome.parent().text()).match(/\[([^\]]+)\]/)?.[1] ?? '';
  const userId = html.match(/request_speech\.php\?mode=entertitle&(?:amp;)?u=(\d+)/)?.[1] ?? '';
  const clubs = new Map<string, ClubRef>();
  $('a[href*="view_meeting.php?c="]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    const clubId = param(href, 'c');
    if (clubId && /show=next/.test(href) && !clubs.has(clubId)) clubs.set(clubId, { clubId, name: clean($(a).text()) });
  });
  const currentClubId = html.match(/requestedclub=(\d+)/)?.[1] ?? '';
  return { userId, username, fullName, currentClubId, clubs: [...clubs.values()] };
}
