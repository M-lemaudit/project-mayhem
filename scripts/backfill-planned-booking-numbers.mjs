/**
 * Planned-rides booking-number backfill.
 *
 * For every bot, pages through the ENTIRE /hades/rides?filter[group]=planned list and stamps the
 * booking_number onto the matching `accepted_offers` rows.
 *
 * Matching: a planned ride exposes the SAME id as the offer the bot accepted
 * (accepted_offers.offer_id == ride.id — verified on live data), so this is a direct ID join.
 * A pickup-time(±2min)+price fallback catches the rare offer whose id differs.
 *
 * Only fills rows where booking_number IS NULL; idempotent and safe to re-run.
 *
 * Needs a proxy (run on the proxied server). Reads .env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * (or SUPABASE_KEY), PROXY_URL. Uses each bot's stored session token+cookies from the bots table.
 *
 * Run:   node scripts/backfill-planned-booking-numbers.mjs            (dry-run, writes nothing)
 *        node scripts/backfill-planned-booking-numbers.mjs --apply    (writes to Supabase)
 *        USE_PROXY=0 node scripts/backfill-planned-booking-numbers.mjs (bypass proxy, local test)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { gotScraping } from 'got-scraping';

const APPLY = process.argv.includes('--apply');
const USE_PROXY = process.env.USE_PROXY !== '0';

/** ±window for the time-based fallback only; ID matches ignore it. */
const MATCH_WINDOW_MS = 2 * 60_000;
/** Safety cap on pagination: 300 pages * 30 = 9000 planned rides. */
const MAX_PAGES = 300;
const PAGE_SIZE = 30;

const PLANNED_PARAMS = {
  'page[number]': 1,
  'page[size]': PAGE_SIZE,
  include:
    'pickup_location,dropoff_location,accepted_by,assigned_driver,assigned_vehicle,available_drivers,available_vehicles,status_updates',
  'filter[group]': 'planned',
};
const TARGETS = [
  'https://athena.blacklane.com/hades/rides',
  'https://partner-portal-api.blacklane.com/hades/rides',
];

const supabase = createClient(
  requireEnv('SUPABASE_URL'),
  process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv('SUPABASE_KEY')
);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

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

function toMs(v) {
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v.trim());
    return Number.isNaN(d.getTime()) ? NaN : d.getTime();
  }
  return NaN;
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

function mapPlanned(body) {
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
      startsAtMs: toMs(a.starts_at),
      startsAtIso: a.starts_at ?? null,
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
        searchParams: { ...PLANNED_PARAMS, 'page[number]': page },
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

async function fetchAllPlanned(accessToken, cookies, userAgent, proxyBase) {
  const all = [];
  let selected = null;

  for (const target of TARGETS) {
    const r = await getPage(target, accessToken, cookies, userAgent, proxyBase, 1);
    if (r.status >= 200 && r.status < 400 && r.body) {
      all.push(...mapPlanned(r.body));
      selected = target;
      break;
    }
    console.log(`    [planned] ${target} page1 -> status ${r.status}${r.error ? ' (' + r.error.message + ')' : ''}, trying next`);
  }
  if (!selected) throw new Error('No reachable /hades/rides endpoint');

  for (let page = 2; page <= MAX_PAGES; page++) {
    const r = await getPage(selected, accessToken, cookies, userAgent, proxyBase, page);
    if (r.status < 200 || r.status >= 400 || !r.body) {
      console.log(`    [planned] page ${page} -> status ${r.status}; stopping pagination`);
      break;
    }
    const rides = mapPlanned(r.body);
    if (rides.length === 0) break;
    all.push(...rides);
  }
  return all;
}

/** Time(±window)+price fallback: closest unclaimed offer to a planned ride. */
function bestByTime(ride, offers, claimed) {
  let best = null;
  let bestScore = Infinity;
  for (const o of offers) {
    if (claimed.has(o.id)) continue;
    if (!Number.isFinite(o.pickupAtMs)) continue;
    const dt = Math.abs(o.pickupAtMs - ride.startsAtMs);
    if (dt > MATCH_WINDOW_MS) continue;
    const dp = o.price != null && ride.price != null ? Math.abs(o.price - ride.price) : 0;
    const score = dt + dp * 1000;
    if (score < bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}

async function processBot(bot) {
  const email = bot.email;
  const s = bot.session || {};
  console.log(`\n── Bot ${email} (${bot.id}) ──`);
  if (!s.accessToken || !s.cookies) {
    console.log('  No stored session token/cookies; skipping.');
    return { matched: 0 };
  }

  // Offers still missing a booking number.
  const { data: offerRows, error: oErr } = await supabase
    .from('accepted_offers')
    .select('id, offer_id, pickup_at, price')
    .eq('bot_id', bot.id)
    .is('booking_number', null);
  if (oErr) {
    console.log(`  Load accepted_offers failed: ${oErr.message}`);
    return { matched: 0 };
  }
  const offers = (offerRows || []).map((r) => ({
    id: r.id,
    offerId: r.offer_id,
    pickupAtMs: toMs(r.pickup_at),
    price: num(r.price),
  }));
  console.log(`  accepted_offers without booking_number: ${offers.length}`);
  if (offers.length === 0) return { matched: 0 };

  let planned;
  try {
    planned = await fetchAllPlanned(s.accessToken, s.cookies, s.userAgent || 'Mozilla/5.0', process.env.PROXY_URL?.trim() || '');
  } catch (e) {
    console.log(`  Fetch planned rides failed: ${e.message}`);
    return { matched: 0 };
  }
  const withBn = planned.filter((p) => p.bookingNumber);
  console.log(`  planned rides fetched (all pages): ${planned.length} (with booking_number: ${withBn.length})`);

  const offerById = new Map(offers.map((o) => [o.offerId, o]));
  const claimed = new Set();
  const plans = []; // { offer, ride, by }

  // 1) primary: ID join (offer_id == planned ride id)
  for (const ride of planned) {
    if (!ride.bookingNumber) continue;
    const o = offerById.get(ride.rideId);
    if (o && !claimed.has(o.id)) {
      claimed.add(o.id);
      plans.push({ offer: o, ride, by: 'id' });
    }
  }
  // 2) fallback: time+price for still-unmatched offers, against still-unused rides
  const usedRideIds = new Set(plans.map((p) => p.ride.rideId));
  for (const ride of planned) {
    if (!ride.bookingNumber || usedRideIds.has(ride.rideId)) continue;
    if (Number.isNaN(ride.startsAtMs)) continue;
    const o = bestByTime(ride, offers, claimed);
    if (o) {
      claimed.add(o.id);
      usedRideIds.add(ride.rideId);
      plans.push({ offer: o, ride, by: 'time' });
    }
  }

  const byId = plans.filter((p) => p.by === 'id').length;
  const byTime = plans.filter((p) => p.by === 'time').length;
  console.log(`  matched ${plans.length}/${offers.length} offers  (by id: ${byId}, by time: ${byTime})`);
  for (const p of plans.slice(0, 10)) {
    console.log(
      `    [${p.by}] offer=${p.offer.offerId.slice(0, 8)}…  -> booking=${p.ride.bookingNumber}  ${p.ride.startsAtIso}  ${p.ride.status}`
    );
  }
  if (plans.length > 10) console.log(`    … and ${plans.length - 10} more`);

  const unmatched = offers.filter((o) => !claimed.has(o.id));
  if (unmatched.length) {
    console.log(`  unmatched offers (${unmatched.length}): no planned ride with that id / time`);
  }

  if (!APPLY) return { matched: plans.length };

  let written = 0;
  for (const p of plans) {
    const { error: uErr } = await supabase
      .from('accepted_offers')
      .update({ booking_number: p.ride.bookingNumber })
      .eq('id', p.offer.id)
      .is('booking_number', null);
    if (uErr) console.log(`    update offer ${p.offer.id} failed: ${uErr.message}`);
    else written++;
  }
  console.log(`  wrote ${written} booking numbers`);
  return { matched: written };
}

async function main() {
  console.log(`\n=== Planned booking-number backfill (${APPLY ? 'APPLY' : 'DRY-RUN'}${USE_PROXY ? '' : ', NO PROXY'}) ===`);
  const { data: bots, error } = await supabase.from('bots').select('id, email, session');
  if (error) throw new Error(error.message);

  let total = 0;
  for (const bot of bots || []) {
    const { matched } = await processBot(bot);
    total += matched;
  }
  console.log(`\n=== Done. ${APPLY ? `Wrote ${total} booking numbers.` : `Would write ${total} — re-run with --apply.`} ===\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
