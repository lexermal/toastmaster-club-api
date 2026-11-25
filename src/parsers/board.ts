import type { BoardMeeting, BoardRole, BoardSlot, SignupBoard } from '../types.js';
import { clean, load, param, statusFromIcon, userIdFrom } from './common.js';

/**
 * Parses `/signup.php`: one table of role rows × upcoming-meeting columns.
 * Columns are matched to meetings by position *within this response only* — the
 * `available[i]` inputs carry no meeting id, so ids come from the header links.
 */
export function parseBoard(html: string): SignupBoard {
  const $ = load(html);
  const form = $('form[name="AvailableFormId"]');
  const table = form.find('table.forumline').first();
  const clubId = param(form.find('a[onclick*="request_speech.php"]').attr('onclick'), 'requestedclub');

  const meetings: BoardMeeting[] = [];
  table.find('th.catHead a[href*="view_meeting.php?t="]').each((_, a) => {
    meetings.push({
      meetingId: param($(a).attr('href'), 't')!,
      label: clean($(a).text()),
      title: clean($(a).closest('th').attr('title')),
      myAttendance: 'unknown',
    });
  });

  let userId: string | undefined;
  table.find('img[name^="attend_image["]').each((i, img) => {
    const cell = $(img).closest('td');
    const checked = cell.find('input[type="radio"][checked]').attr('value');
    const onclick = cell.find('input[type="radio"]').first().attr('onclick') ?? '';
    userId ??= onclick.match(/attendMeeting\('(\d+)'/)?.[1];
    if (!meetings[i]) return;
    meetings[i].myAttendance =
      checked === '1' ? 'attending' : checked === '2' ? 'notAttending' : checked === '5' ? 'maybe' : statusFromIcon($(img).attr('src'));
  });

  const roles: BoardRole[] = [];
  table.find('tr').each((_, tr) => {
    const cells = $(tr).children('td');
    const head = cells.first();
    if (!head.hasClass('row2')) return;
    const role = clean(head.text());
    cells.slice(1).each((col, td) => {
      const meeting = meetings[col];
      if (!meeting) return;
      let roleItemId: string | undefined;
      const slots: BoardSlot[] = [];
      // Multi-slot roles list "1 …<br>2 …"; single-slot roles have no number (slot 0).
      const parts = ($(td).html() ?? '').split(/<br\s*\/?>/i);
      for (const part of parts) {
        const $p = load(`<div>${part}</div>`);
        const text = clean($p('div').text());
        const volunteer = $p('a[href*="action=volunteer"]').attr('href');
        const person = $p('a[onclick*="miniprofile"], a[href*="miniprofile"]').first();
        const numbered = text.match(/^(\d+)\b/);
        if (!volunteer && !person.length && !numbered) continue;
        if (volunteer) roleItemId ??= param(volunteer, 'r');
        const slot = volunteer ? Number(param(volunteer, 'n') ?? 0) : numbered ? Number(numbered[1]) : 0;
        slots.push({
          slot,
          open: Boolean(volunteer),
          occupant: person.length
            ? { name: clean(person.text()), userId: userIdFrom(person.attr('onclick') ?? person.attr('href')) ?? '' }
            : undefined,
        });
      }
      roles.push({ meetingId: meeting.meetingId, role, roleItemId, slots });
    });
  });

  return { clubId, userId, meetings, roles };
}
