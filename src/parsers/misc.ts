import type { ClubSpeech, Member, SpeechDateOption, SpeechTask, TableTopicsCandidate, TableTopicsSpeaker } from '../types.js';
import { clean, load, param, userIdFrom } from './common.js';

/** Parses `/memberlist.php`. Contact details are deliberately not extracted. */
export function parseMembers(html: string): Member[] {
  const $ = load(html);
  const members: Member[] = [];
  $('a[href*="profile.php?mode=viewprofile&u="]').each((_, a) => {
    const userId = $(a).attr('href')!.match(/u=(\d+)/)![1];
    if (members.some((m) => m.userId === userId)) return;
    const offices = $(a).closest('tr').next('tr').find('span[id^="email_status"]').first().find('a');
    const clubRoles = offices.map((__, o) => clean($(o).text())).get().filter(Boolean);
    members.push({ userId, name: clean($(a).text()), clubRoles: clubRoles.length ? clubRoles : ['Member'] });
  });
  return members;
}

/** Workbook step of the speech-request wizard (`request_speech.php?mode=selectworkbook`). */
export function parseSpeechWorkbook(html: string) {
  const $ = load(html);
  const userWorkbookId = $('input[name="cached_user_workbook"]').attr('value') || undefined;
  const tasks: SpeechTask[] = [];
  $('input[type="radio"][name="ntk"]').each((_, input) => {
    const cells = $(input).closest('tr').children('td');
    const texts = cells.map((__, td) => clean($(td).text())).get().filter(Boolean);
    tasks.push({
      taskId: $(input).attr('value')!,
      title: texts[0] ?? '',
      timing: texts.find((t) => /\bmin\b/.test(t)),
      status: texts.find((t) => /^(Comp|Req|Sch|Done|Booked)/i.test(t)),
    });
  });
  const userWorkbooks: { userWorkbookId: string; name: string }[] = [];
  $('a[href*="selectWorkbook("]').each((_, a) => {
    const id = $(a).attr('href')!.match(/selectWorkbook\('?(\d+)/)?.[1];
    if (id) userWorkbooks.push({ userWorkbookId: id, name: clean($(a).text()) });
  });
  const workbookName = clean($('td.row2[colspan="2"] b').first().text()) || undefined;
  return { userWorkbookId, workbookName, userWorkbooks, tasks };
}

/** Date step of the speech-request wizard (`request_speech.php?mode=choosedate`). */
export function parseSpeechDates(html: string): SpeechDateOption[] {
  const $ = load(html);
  return $('input[name="first_preference"]')
    .map((_, input) => {
      const cells = $(input).closest('tr').children('td');
      cells.find('br').replaceWith(' ');
      return {
        date: Number($(input).attr('value')),
        label: clean(cells.eq(0).text()),
        info: clean(cells.eq(1).text()),
      };
    })
    .get();
}

/** Serialises an HTML form the way a browser would submit it. */
export function serializeForm(html: string, formSelector: string): URLSearchParams | undefined {
  const $ = load(html);
  const form = $(formSelector).first();
  if (!form.length) return undefined;
  const body = new URLSearchParams();
  form.find('input, select, textarea').each((_, el) => {
    const $el = $(el);
    const name = $el.attr('name');
    if (!name || $el.attr('disabled') !== undefined) return;
    const type = ($el.attr('type') ?? '').toLowerCase();
    if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) return;
    if ((type === 'radio' || type === 'checkbox') && $el.attr('checked') === undefined) return;
    if (el.tagName === 'select') {
      const opt = $el.find('option[selected]').first();
      body.append(name, (opt.length ? opt : $el.find('option').first()).attr('value') ?? '');
    } else if (el.tagName === 'textarea') body.append(name, $el.text());
    else body.append(name, $el.attr('value') ?? (type === 'checkbox' ? 'on' : ''));
  });
  return body;
}

/** Names of all controls in a form, for locating fields like the meeting theme. */
export function formFieldNames(html: string, formSelector: string) {
  const $ = load(html);
  return $(formSelector)
    .first()
    .find('input, select, textarea')
    .map((_, el) => $(el).attr('name'))
    .get()
    .filter(Boolean) as string[];
}

/**
 * Parses `/tm_all_speeches.php`. Rows before the "Recent speeches" header are the
 * request queue; recent rows collapse the date columns into one "Completed <date>" link.
 */
export function parseSpeechList(html: string): ClubSpeech[] {
  const $ = load(html);
  const speeches: ClubSpeech[] = [];
  $('a[href*="tm_objective.php?s="]').each((_, a) => {
    const tr = $(a).closest('tr');
    const cells = tr.children('td');
    const person = cells.eq(0).find('a[href*="u="]').first();
    const meetingLink = tr.find('a[href*="view_meeting.php?t="]').first();
    const dash = (i: number) => {
      const t = clean(cells.eq(i).find('span').first().text());
      return t && t !== '-' ? t : undefined;
    };
    const completed = cells.eq(4).attr('colspan') !== undefined;
    const scheduledFor = completed ? undefined : dash(8);
    speeches.push({
      speechId: param($(a).attr('href'), 's')!,
      speaker: { name: clean(person.text()), userId: userIdFrom(person.attr('href')) ?? '' },
      workbook: clean(cells.eq(1).text()).replace(/^»\s*/, ''),
      project: clean($(a).text()),
      timing: $(a).attr('title') || undefined,
      title: clean(cells.eq(3).text()),
      status: completed ? 'completed' : scheduledFor ? 'scheduled' : 'requested',
      requestedOn: completed ? undefined : dash(4),
      preferences: completed ? [] : [dash(5), dash(6), dash(7)].filter((d): d is string => Boolean(d)),
      scheduledFor: completed ? clean(meetingLink.text()).replace(/^\D+/, '') : scheduledFor,
      meetingId: param(meetingLink.attr('href'), 't'),
    });
  });
  return speeches;
}

/** Table Topics section of a meeting page plus the "Add Speaker" dropdown. */
export function parseTableTopics(html: string): { speakers: TableTopicsSpeaker[]; candidates: TableTopicsCandidate[] } {
  const $ = load(html);
  const section = $('input[onclick*="showAddSpeakerModal"], [onclick*="removeTableTopicsSpeaker("], [href*="removeTableTopicsSpeaker("]')
    .first()
    .closest('table');
  const speakers: TableTopicsSpeaker[] = [];
  section.children('tbody').children('tr').add(section.children('tr')).each((_, tr) => {
    const row = $(tr);
    if (row.find('td.catHead, input, em').length) return; // header, "Add Speaker" button, "No speakers added yet"
    const rowHtml = $.html(row);
    const text = clean(row.text());
    if (!text) return;
    const person = row.find('a[href*="u="], a[onclick*="u="]').first();
    const duration = text.match(/\b\d{1,2}:\d{2}\b/)?.[0];
    speakers.push({
      assignmentId: rowHtml.match(/removeTableTopicsSpeaker\(\s*'?(\d+)/)?.[1],
      name: person.length ? clean(person.text()) : clean(row.children('td').first().text()),
      userId: userIdFrom(person.attr('href') ?? person.attr('onclick')),
      duration,
    });
  });
  const candidates = $('select#speaker_id option')
    .filter((_, o) => Boolean($(o).attr('value')))
    .map((_, o) => ({ userId: $(o).attr('value')!, name: clean($(o).text()), attending: $(o).attr('data-attendee') === '1' }))
    .get();
  return { speakers, candidates };
}
