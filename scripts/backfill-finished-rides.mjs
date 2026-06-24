/**
 * Finished-rides billing backfill / full audit.
 *
 * One-off, exhaustive counterpart to the incremental BillingReconciler. For every bot it pages
 * through the ENTIRE /hades/finished_rides list (filter[status]=finished,no_show) — all the way
 * back, not just the rolling window — and matches each completed ride to the offer the bot booked.
 *
 * Matching is a direct ID join: accepted_offers.offer_id == finished_rides.id (verified on live
 * data — 41/41 of the previously reconciled rows agreed). No time/price fallback: a fuzzy match
 * here means billing the wrong ride.
 *
 * For every matched offer it stamps the ride's ACTUAL final price + status (the billing base for
 * the 3% fee). Idempotent: writes a row only when it isn't already reconciled to that same ride
 * with that same price. Reports a full comparison so you can see exactly what did and didn't match.
 *
 * Needs a proxy (run on the proxied server). Reads .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * (or SUPABASE_KEY), PROXY_URL. Uses each bot's stored session token+cookies from the bots table.
 *
 * Run:   node scripts/backfill-finished-rides.mjs            (dry-run, writes nothing)
 *        node scripts/backfill-finished-rides.mjs --apply    (writes to Supabase)
 *        USE_PROXY=0 node scripts/backfill-finished-rides.mjs (bypass proxy, local test)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { gotScraping } from 'got-scraping';

const APPLY = process.argv.includes('--apply');
const USE_PROXY = process.env.USE_PROXY !== '0';

/** Safety cap on pagination: 400 pages * 30 = 12000 finished rides. */
const MAX_PAGES = 400;
const PAGE_SIZE = 30;

const FINISHED_PARAMS = {
  'page[number]': 1,
  'page[size]': PAGE_SIZE,
  include:
    'pickup_location,dropoff_location,assigned_driver,assigned_vehicle,review,accepted_by,status_updates',
  // no_show still pays the driver, so it counts as a completed (billable) ride.
  'filter[status]': 'finished,no_show',
};
const TARGETS = [
  'https://athena.blacklane.com/hades/finished_rides',
  'https://partner-portal-api.blacklane.com/hades/finished_rides',
];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const supabase = createClient(
  requireEnv('SUPABASE_URL'),
  process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv('SUPABASE_KEY')
);

function cookieHeader(cookies) {
  return (cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Rotate the iproyal "session-XXXX" token so a 503'd exit IP gets swapped for the next try. */
function rotateProxy(base) {
  if (!base) return undefined;
  const rnd = Array.from({ length: 8 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]
  ).join('');
  return base.replace(/(session-)[A-Za-z0-9]+/, `$1${rnd}`);
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toIso(v) {
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function makeClient(accessToken, cookies, userAgent, proxyBase) {
  return gotScraping.extend({
    timeout: { request: 30000 },
    responseType: 'json',
    throwHttpErrors: true,
    retry: { limit: 0 },
    proxyUrl: USE_PROXY ? rotateProxy(proxyBase) : undefined,
    headerGeneratorOptions: {
      browsers: [{ name: 'chrome', minVersion: 120 }],
      os: ['windows'],
      devices: ['desktop'],
    },
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/json',
      Origin: 'https://partner.blacklane.com',
      Referer: 'https://partner.blacklane.com/',
      'x-requested-with': 'XMLHttpRequest',
      'User-Agent': userAgent,
      Authorization: `Bearer ${accessToken}`,
      Cookie: cookieHeader(cookies),
    },
  });
}

function mapFinished(body) {
  const list = Array.isArray(body?.data) ? body.data : [];
  const out = [];
  for (const it of list) {
    if (!it || typeof it.id !== 'string') continue;
    const a = it.attributes || {};
    const bn = a.booking_number;
    out.push({
      rideId: it.id,
      bookingNumber: typeof bn === 'string' ? bn : bn != null ? String(bn) : '',
      status: typeof a.status === 'string' ? a.status : 'unknown',
      price: num(a.price),
      currency: typeof a.currency === 'string' ? a.currency : '',
      startsAtIso: toIso(a.starts_at),
    });
  }
  return out;
}

/** Fetch one page with proxy rotation on gateway/proxy 5xx (a few tries), then give up. */
async function getPage(target, accessToken, cookies, userAgent, proxyBase, page) {
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const client = makeClient(accessToken, cookies, userAgent, proxyBase);
    try {
      const resp = await client.get(target, {
        searchParams: { ...FINISHED_PARAMS, 'page[number]': page },
      });
      return { status: resp.statusCode, body: resp.body };
    } catch (e) {
      lastErr = e;
      const st = e?.response?.statusCode;
      const msg = String(e.message || '');
      const transient =
        st === 502 || st === 503 || st === 504 || /503|TUNNEL|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
      if (st === 404) return { status: 404, body: null };
      if (!transient) return { status: st ?? 0, body: null, error: e };
      // transient: rotate proxy and retry
    }
  }
  return { status: 0, body: null, error: lastErr };
}

async function fetchAllFinished(accessToken, cookies, userAgent, proxyBase) {
  const all = [];
  let selected = null;

  for (const target of TARGETS) {
    const r = await getPage(target, accessToken, cookies, userAgent, proxyBase, 1);
    if (r.status >= 200 && r.status < 400 && r.body) {
      all.push(...mapFinished(r.body));
      selected = target;
      break;
    }
    console.log(`    [finished] ${target} page1 -> status ${r.status}${r.error ? ' (' + r.error.message + ')' : ''}, trying next`);
  }
  if (!selected) throw new Error('No reachable /hades/finished_rides endpoint');

  for (let page = 2; page <= MAX_PAGES; page++) {
    const r = await getPage(selected, accessToken, cookies, userAgent, proxyBase, page);
    if (r.status < 200 || r.status >= 400 || !r.body) {
      console.log(`    [finished] page ${page} -> status ${r.status}; stopping pagination`);
      break;
    }
    const rides = mapFinished(r.body);
    if (rides.length === 0) break;
    all.push(...rides);
  }
  return all;
}

async function processBot(bot, totals) {
  const email = bot.email;
  const s = bot.session || {};
  console.log(`\n── Bot ${email} (${bot.id}) ──`);
  if (!s.accessToken || !s.cookies) {
    console.log('  No stored session token/cookies; skipping.');
    return;
  }

  // ALL offers this bot ever booked (not just unreconciled) — this is a full audit.
  const { data: offerRows, error: oErr } = await supabase
    .from('accepted_offers')
    .select('id, offer_id, pickup_at, price, reconciled_at, finished_ride_uuid, finished_price')
    .eq('bot_id', bot.id);
  if (oErr) {
    console.log(`  Load accepted_offers failed: ${oErr.message}`);
    return;
  }
  const offers = offerRows || [];
  const nowMs = Date.now();
  const pastOffers = offers.filter((o) => o.pickup_at && new Date(o.pickup_at).getTime() < nowMs);
  console.log(`  accepted_offers: ${offers.length} total (${pastOffers.length} past, already reconciled: ${offers.filter((o) => o.reconciled_at).length})`);
  if (offers.length === 0) return;

  let finished;
  try {
    finished = await fetchAllFinished(s.accessToken, s.cookies, s.userAgent || 'Mozilla/5.0', process.env.PROXY_URL?.trim() || '');
  } catch (e) {
    console.log(`  Fetch finished rides failed: ${e.message}`);
    return;
  }
  const oldest = finished.reduce((min, r) => (r.startsAtIso && (!min || r.startsAtIso < min) ? r.startsAtIso : min), null);
  console.log(`  finished rides fetched (all pages): ${finished.length}  (oldest: ${oldest ?? 'n/a'})`);

  const finishedById = new Map(finished.map((r) => [r.rideId, r]));

  // Direct ID join: offer the bot booked == the finished ride.
  const matches = [];
  for (const o of offers) {
    const ride = finishedById.get(o.offer_id);
    if (ride) matches.push({ offer: o, ride });
  }
  console.log(`  matched (offer_id == finished ride id): ${matches.length}/${offers.length} offers`);

  // Of the matched rows, which still need a (re)write?
  const needWrite = matches.filter(
    (m) =>
      !m.offer.reconciled_at ||
      m.offer.finished_ride_uuid !== m.ride.rideId ||
      num(m.offer.finished_price) !== m.ride.price
  );
  console.log(`    already correct: ${matches.length - needWrite.length}, to write: ${needWrite.length}`);
  for (const m of needWrite.slice(0, 10)) {
    console.log(
      `    [write] offer=${m.offer.offer_id.slice(0, 8)}…  price ${m.offer.price} -> finished ${m.ride.price} ${m.ride.currency}  ${m.ride.startsAtIso}  ${m.ride.status}`
    );
  }
  if (needWrite.length > 10) console.log(`    … and ${needWrite.length - 10} more`);

  // Past offers with no completed ride = simulation accepts, cancellations, or reassignments.
  const matchedIds = new Set(matches.map((m) => m.offer.id));
  const unmatchedPast = pastOffers.filter((o) => !matchedIds.has(o.id));
  console.log(`  past offers with NO finished ride: ${unmatchedPast.length} (never completed: simulation/cancelled/reassigned)`);

  totals.offers += offers.length;
  totals.past += pastOffers.length;
  totals.finished += finished.length;
  totals.matched += matches.length;
  totals.toWrite += needWrite.length;

  if (!APPLY) return;

  let written = 0;
  for (const m of needWrite) {
    const { error: uErr } = await supabase
      .from('accepted_offers')
      .update({
        completed_status: m.ride.status,
        finished_ride_uuid: m.ride.rideId,
        booking_number: m.ride.bookingNumber || null,
        finished_price: m.ride.price,
        finished_currency: m.ride.currency || null,
        completed_at: m.ride.startsAtIso,
        reconciled_at: new Date().toISOString(),
      })
      .eq('id', m.offer.id);
    if (uErr) console.log(`    update offer ${m.offer.id} failed: ${uErr.message}`);
    else written++;
  }
  totals.written += written;
  console.log(`  wrote ${written} reconciliations`);
}

async function main() {
  console.log(`\n=== Finished-rides billing backfill (${APPLY ? 'APPLY' : 'DRY-RUN'}${USE_PROXY ? '' : ', NO PROXY'}) ===`);
  const { data: bots, error } = await supabase.from('bots').select('id, email, session');
  if (error) throw new Error(error.message);

  const totals = { offers: 0, past: 0, finished: 0, matched: 0, toWrite: 0, written: 0 };
  for (const bot of bots || []) {
    await processBot(bot, totals);
  }

  console.log(`\n=== Summary ===`);
  console.log(`  accepted_offers (all bots): ${totals.offers}  (past: ${totals.past})`);
  console.log(`  finished rides pulled:      ${totals.finished}`);
  console.log(`  matched by id:              ${totals.matched}`);
  console.log(
    APPLY
      ? `  reconciliations written:    ${totals.written}`
      : `  would write:                ${totals.toWrite}  — re-run with --apply`
  );
  console.log('');
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
