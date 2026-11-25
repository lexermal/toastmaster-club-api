import type { Agenda, AgendaItem, MeetingAttendee, MeetingDetails, MeetingRole } from '../types.js';
import { clean, load, param, statusFromIcon, userIdFrom } from './common.js';
import { parseTableTopics } from './misc.js';

const q = `'?(\\d+)'?`;
/**
 * Role-line id + slot from whatever control a row offers. Members only see the volunteer link;
 * officers get the page's own JS handlers (signatures from view_meeting.php's inline script).
 */
const ROLE_ID_PATTERNS: RegExp[] = [
  /action=volunteer[^"']*?[?&](?:amp;)?r=(\d+)&(?:amp;)?n=(\d+)/,
  new RegExp(`unassignRole\\(\\s*${q}\\s*,\\s*${q}\\s*,\\s*${q}`), // (topic, role, n)
  new RegExp(`swapRoles\\(\\s*${q}\\s*,\\s*${q}\\s*,\\s*${q}`), // (topic, role, n)
  new RegExp(`assignRole\\([^,]+,\\s*${q}\\s*,\\s*${q}\\s*,\\s*${q}`), // (user, topic, role, n)
  new RegExp(`assignSpeech\\([^,]+,[^,]+,\\s*${q}\\s*,\\s*${q}`), // (speech, agenda, role, n)
];

function roleIdFrom(rowHtml: string): { roleItemId: string; slot: number } | undefined {
  for (const re of ROLE_ID_PATTERNS) {
    const m = rowHtml.match(re);
    if (!m) continue;
    // Patterns with a leading topic id capture 3 groups; role and slot are always the last two.
    const [roleItemId, slot] = m.slice(-2);
    return { roleItemId, slot: Number(slot) };
  }
  return undefined;
}

/** Parses `/view_meeting.php?t=<id>`: header, attendance list and role sign-up table. */
export function parseMeeting(html: string): MeetingDetails {
  const $ = load(html);
  const form = $('form[name="AssignmentFrm"]');
  const eventDate = Number(form.find('input[name="event_date"]').attr('value'));
  const subtitle = clean(form.find('td span.gen b').first().parent().text());
  const venueLink = form.find('a[onclick*="tm_location.php"]').first();
  // After the venue: "Word of the Day <span>…</span><br><br>Meeting Theme <b>…</b>" — label first, value in its own element.
  const venueCell = venueLink.closest('td').children('span.gen').first();
  const wordOfTheDay = clean(venueCell.children('span.gen').last().text());
  const theme = clean(venueCell.children('b').last().text());

  const attendees: MeetingAttendee[] = [];
  let group = '';
  // Document order: group headers (th.thTop) interleave with each member's attendance icon.
  $('th.thTop, img[name^="attend_image"]').each((_, el) => {
    if (el.tagName === 'th') {
      // "Member (2 /15) [Hide]" → "Member"
      group = clean($(el).text()).replace(/\s*\(.*$/, '');
      return;
    }
    const tr = $(el).closest('tr');
    const link = tr.find('a[onclick*="miniprofile"]').first();
    if (!link.length) return; // header icon for yourself, not a list row
    const userId = $(el).attr('name')!.match(/\[(\d+)\]/)?.[1] ?? userIdFrom(link.attr('onclick')) ?? '';
    if (attendees.some((a) => a.userId === userId)) return;
    const checked = tr.find('input[type="radio"][checked]').attr('value');
    const status =
      checked === '1' ? 'attending' : checked === '2' ? 'notAttending' : checked === '5' ? 'maybe' : statusFromIcon($(el).attr('src'));
    const comment = clean(tr.next('tr').find('td[colspan="3"]').text());
    attendees.push({
      userId,
      name: clean(link.text()),
      group,
      status,
      statusNote: $(el).attr('title') || undefined,
      comment: comment || undefined,
    });
  });

  const roles: MeetingRole[] = [];
  const rolesTable = $('th.thLeft')
    .filter((_, th) => $(th).siblings('th.thRight').length > 0)
    .first()
    .closest('table');
  rolesTable.children('tbody').children('tr').add(rolesTable.children('tr')).each((_, tr) => {
    const cells = $(tr).children('td');
    const nameCell = cells.first().find('span.nav').first();
    if (!nameCell.length) return;
    const body = cells.slice(1);
    const person = body.find('a[onclick*="miniprofile"]').first();
    const volunteer = body.find('a[href*="action=volunteer"]').attr('href');
    const accept = body.find('img[name^="accept_image"]').attr('src');
    const details = clean(body.find('span.gensmall').text());
    const rowHtml = $.html(tr);
    const ids = roleIdFrom(rowHtml);
    roles.push({
      role: clean(nameCell.text()),
      roleItemId: ids?.roleItemId,
      slot: ids?.slot,
      assignmentId: rowHtml.match(/(?:action=confirmrole&(?:amp;)?a=|edit_pathway_link\.php\?a=)(\d+)/)?.[1],
      presenter: person.length ? { name: clean(person.text()), userId: userIdFrom(person.attr('onclick')) ?? '' } : undefined,
      confirmed: accept ? /icon_tick/.test(accept) : undefined,
      details: details || undefined,
      volunteer: volunteer ? { roleItemId: param(volunteer, 'r')!, slot: Number(param(volunteer, 'n') ?? 0) } : undefined,
    });
  });

  const prev = $('img[src*="icon_left_arrow"]').closest('a').attr('href');
  const next = $('img[src*="icon_right_arrow"]').closest('a').attr('href');
  return {
    meetingId: form.find('input[name="topic"]').attr('value') ?? '',
    clubName: clean($('.reversetitle').first().text()),
    startsAt: eventDate ? new Date(eventDate * 1000).toISOString() : undefined,
    dateText: clean(form.find('td.maintitle').first().text()),
    meetingNumber: Number(subtitle.match(/#(\d+)/)?.[1]) || undefined,
    durationText: subtitle.split(' - ')[1],
    venue: clean(venueLink.text()) || undefined,
    wordOfTheDay: wordOfTheDay || undefined,
    theme: theme || undefined,
    previousMeetingId: param(prev, 't'),
    nextMeetingId: param(next, 't'),
    attendees,
    roles,
    tableTopicsSpeakers: parseTableTopics(html).speakers,
  };
}

/** Parses the printable agenda `/viewagenda.php?t=<id>&pr=1`. */
export function parseAgenda(html: string, meetingId: string): Agenda {
  const $ = load(html);
  const text = clean($('body').text());
  const items: AgendaItem[] = [];
  $('tr').each((_, tr) => {
    const cells = $(tr).children('td');
    if (cells.length !== 5) return;
    const times = cells.eq(4).find('td');
    if (!cells.eq(1).find('span.gen').length || times.length < 3) return;
    const presenterRaw = clean(cells.eq(2).text());
    const t = (i: number) => clean(times.eq(i).text());
    items.push({
      time: clean(cells.eq(0).text()) || undefined,
      role: clean(cells.eq(1).text()),
      presenter: presenterRaw.replace(/\?$/, '') || undefined,
      presenterConfirmed: presenterRaw ? !presenterRaw.endsWith('?') : undefined,
      event: clean(cells.eq(3).text()),
      timing: t(0) || t(2) ? { green: t(0), amber: t(1), red: t(2) } : undefined,
    });
  });
  return {
    meetingId,
    clubName: clean($('span.maintitle, .maintitle').first().text()) || clean($('td').first().text()),
    heading: text.match(/Toastmaster Meeting [^|]*?Starting at \d{1,2}:\d{2}/)?.[0] ?? '',
    meetingNumber: Number(text.match(/Meeting Number\s*(\d+)/)?.[1]) || undefined,
    theme: text.match(/Meeting Theme\s*(.*?)\s*Venue/)?.[1] || undefined,
    venue: text.match(/Venue\s*(.*?)\s*Time\b/)?.[1] || undefined,
    items,
  };
}
