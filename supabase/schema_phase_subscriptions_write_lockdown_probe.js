// THE BROWSER-CONSOLE PROBE of supabase/schema_phase_subscriptions_write_lockdown.sql
// (runbook step 3 iii). Signed in to the product, open the browser console on
// any page of the app and paste this file whole.
//
// It uses the session the page already holds. It READS your own subscriptions
// row, then tries to WRITE `cancel_at_period_end` back to the value it just
// read — never a tier, and a no-op if the write were to land. It prints one of:
//   CLOSED                a signed-in user cannot write the row (the write
//                         was refused: 401 or 403). What the migration leaves.
//   OPEN                  the write was accepted (2xx). Do not ship; run the
//                         pre-flight report.
//   NOT CLOSED            the write was not refused but changed no row (2xx,
//                         zero rows): a write privilege is still held.
//   PROBE INCONCLUSIVE    it could not tell, and says why: not signed in, the
//                         anon key not found in the page's scripts, the read
//                         not answering exactly one row, or the server
//                         answering an error of its own (5xx). In the first
//                         three NOTHING WAS WRITTEN.
// Run it only AFTER the migration: before it, an accepted write moves
// `updated_at` on your own row, which then shows in the audit's ordering.
(async () => {
  const say = (line) => { console.log(line); return line; };
  let key = null;
  try { key = Object.keys(localStorage).find((k) => /^sb-.+-auth-token$/.test(k)) || null; } catch (_) { key = null; }
  if (!key) return say('PROBE INCONCLUSIVE — not signed in (no sb-…-auth-token in this page\'s storage); nothing was written.');
  let session = null;
  try { session = JSON.parse(localStorage.getItem(key)); } catch (_) { session = null; }
  if (!session || !session.access_token || !session.user || !session.user.id) {
    return say('PROBE INCONCLUSIVE — not signed in (the stored session holds no access token); nothing was written.');
  }
  const ref = key.replace(/^sb-/, '').replace(/-auth-token$/, '');

  // The public anon key, read from the page's own scripts. A script that
  // cannot be fetched (another origin, a blocked request) is skipped.
  let apikey = null;
  const scripts = performance.getEntriesByType('resource').filter((e) => /\.js(\?|$)/.test(e.name));
  for (const entry of scripts) {
    let text = '';
    try { text = await (await fetch(entry.name)).text(); } catch (_) { continue; }
    const publishable = text.match(/sb_publishable_[A-Za-z0-9_-]+/);
    if (publishable) { apikey = publishable[0]; break; }
    for (const token of text.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) || []) {
      try {
        const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (claims.role === 'anon') { apikey = token; break; }
      } catch (_) { /* not a JWT */ }
    }
    if (apikey) break;
  }
  if (!apikey) {
    return say('PROBE INCONCLUSIVE — the anon key was not found in the page\'s scripts; nothing was written. '
      + 'Set `apikey` by hand (Dashboard -> Settings -> API -> anon public) and run again.');
  }

  const url = `https://${ref}.supabase.co/rest/v1/subscriptions?user_id=eq.${session.user.id}`;
  const headers = {
    apikey, Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json', Prefer: 'return=representation',
  };
  let read, rows;
  try {
    read = await fetch(url + '&select=cancel_at_period_end', { headers });
    rows = await read.json();
  } catch (err) {
    return say('PROBE INCONCLUSIVE — the read failed (' + err + '); nothing was written.');
  }
  console.log('read own row:', read.status, rows);
  if (read.status !== 200 || !Array.isArray(rows) || rows.length !== 1) {
    return say('PROBE INCONCLUSIVE — the read did not answer exactly one row (HTTP ' + read.status + '); nothing was written.');
  }

  let write, body = null;
  try {
    write = await fetch(url, {
      method: 'PATCH', headers,
      body: JSON.stringify({ cancel_at_period_end: rows[0].cancel_at_period_end }),
    });
    try { body = await write.json(); } catch (_) { body = null; }
  } catch (err) {
    return say('PROBE INCONCLUSIVE — the write request failed before an answer (' + err + ').');
  }
  console.log('write own row:', write.status, body);
  if (write.status === 401 || write.status === 403) {
    return say('CLOSED — a signed-in user cannot write the subscriptions row.');
  }
  if (write.status >= 200 && write.status < 300) {
    if (Array.isArray(body) && body.length === 0) {
      return say('NOT CLOSED — the write was not refused, though it changed no row (HTTP ' + write.status
        + ', 0 rows): a write privilege is still held. Run the pre-flight report.');
    }
    return say('OPEN — the write was accepted (HTTP ' + write.status + '). Do not ship; run the pre-flight report.');
  }
  return say('PROBE INCONCLUSIVE — the write answered HTTP ' + write.status
    + ', neither a refusal (401 / 403) nor an acceptance (2xx). Run the pre-flight report.');
})();
