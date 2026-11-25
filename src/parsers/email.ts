import type { ClubEmailAudience } from '../types.js';
import { clean, load } from './common.js';

/**
 * Names from the "E-mail has been sent to the following recipients" page, or undefined when
 * that page didn't come back (the site re-shows the form or an error instead).
 */
export function parseSentTo(html: string): string[] | undefined {
  const $ = load(html);
  if ($('textarea[name="message"]').length) return undefined;
  const names = $('td.row1 span.gen b')
    .map((_, b) => {
      $(b).find('br').replaceWith('\n');
      return $(b).text().split(/[\n,]/).map(clean);
    })
    .get()
    .filter(Boolean);
  return names.length ? names : undefined;
}

/** Text of a result page, for error messages. */
export function pageMessage(html: string) {
  const $ = load(html);
  $('script, style').remove();
  return clean($('span.gen').first().text() || $('body').text()).slice(0, 300);
}

/**
 * Membership-status rows of `org_email.php` ("Member", "Guest that visited the club", ...).
 * Each row is a yes/no radio pair `mark[i]` whose yes value is the positive status id.
 */
export function parseClubEmailAudience(html: string): ClubEmailAudience[] {
  const $ = load(html);
  const rows: ClubEmailAudience[] = [];
  $('form[name="orgEmailFrm"] tr').each((_, tr) => {
    // closest('tr') check: the form's outer layout rows contain these rows too.
    const yes = $(tr)
      .find('input[type="radio"][name^="mark["]')
      .filter((__, r) => $(r).closest('tr').is(tr) && Number($(r).attr('value')) > 0);
    if (!yes.length) return;
    const cells = $(tr).children('td');
    const counts = clean(cells.last().text()).match(/(\d+)\D+(\d+)/);
    rows.push({
      status: clean(cells.first().text()),
      field: yes.attr('name')!,
      value: yes.attr('value')!,
      selectedByDefault: yes.attr('checked') !== undefined,
      members: Number(counts?.[1] ?? 0),
      recentlyActive: Number(counts?.[2] ?? 0),
    });
  });
  return rows;
}
