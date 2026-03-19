/**
 * Manual script: exercise airportDirection + allowedAirlines filters.
 * Run: npm run build && node dist/scripts/test-airport-filter.js
 */
import { FilterEngine, type BotFilters, type IncludedResource, type OfferShape } from '../core/filter-engine';

function makeOffer(
  id: string,
  pickupId: string,
  dropoffId: string,
  price: string = '10',
  flightNumber?: string
): OfferShape {
  return {
    id,
    attributes: {
      price,
      ...(flightNumber ? { flight_number: flightNumber } : {}),
    },
    relationships: {
      pickup_location: { data: { id: pickupId } },
      dropoff_location: { data: { id: dropoffId } },
    },
  };
}

function makeLocation(
  id: string,
  {
    tags,
    formatted_address_en,
  }: { tags?: unknown; formatted_address_en?: unknown }
): IncludedResource {
  return {
    id,
    type: 'locations',
    attributes: {
      ...(tags !== undefined ? { tags } : {}),
      ...(formatted_address_en !== undefined ? { formatted_address_en } : {}),
    },
  };
}

function runCase(
  name: string,
  offer: OfferShape,
  included: IncludedResource[],
  filters: BotFilters
): void {
  const res = FilterEngine.isMatch(offer, filters, [], included);
  console.log(`${name}: ${res.match ? 'PASS' : 'FAIL'} — ${res.reason}`);
}

async function main(): Promise<void> {
  const baseFilters: BotFilters = {
    minPrice: 0,
    allowedVehicleTypes: [],
    allowedAirportDirections: ['pickup', 'dropoff'],
    // NOTE: This list is now a BLOCKLIST: any matching airline code will cause rejection.
    allowedAirlines: ['AF', 'DAL'],
  };

  // 1) City-to-city: no airport tags => PASS regardless of direction
  runCase(
    'city-to-city (no airport tags)',
    makeOffer('1', 'p1', 'd1'),
    [
      makeLocation('p1', { tags: ['city'], formatted_address_en: 'Downtown' }),
      makeLocation('d1', { tags: ['city'], formatted_address_en: 'Uptown' }),
    ],
    baseFilters
  );

  // 2) Pickup airport only, directions allow pickup => PASS
  runCase(
    'pickup airport allowed by direction',
    makeOffer('2', 'p2', 'd2'),
    [
      makeLocation('p2', { tags: ['airport'], formatted_address_en: 'Airport' }),
      makeLocation('d2', { tags: ['city'], formatted_address_en: 'Downtown' }),
    ],
    { ...baseFilters, allowedAirportDirections: ['pickup'] }
  );

  // 3) Pickup airport only, directions disallow pickup => FAIL
  runCase(
    'pickup airport blocked by direction',
    makeOffer('3', 'p3', 'd3'),
    [
      makeLocation('p3', { tags: ['airport'], formatted_address_en: 'Airport' }),
      makeLocation('d3', { tags: ['city'], formatted_address_en: 'Downtown' }),
    ],
    { ...baseFilters, allowedAirportDirections: ['dropoff'] }
  );

  // 4) flight_number empty => PASS (no airline restriction)
  runCase(
    'no flight_number => airline filter bypass',
    makeOffer('4', 'p4', 'd4'),
    [
      makeLocation('p4', { tags: ['city'], formatted_address_en: 'City A' }),
      makeLocation('d4', { tags: ['city'], formatted_address_en: 'City B' }),
    ],
    baseFilters
  );

  // 5) flight_number present, allowedAirlines empty (no airlines blocked) => PASS
  runCase(
    'flight_number present, blocklist empty => PASS',
    makeOffer('5', 'p5', 'd5', 'dal123'),
    [
      makeLocation('p5', { tags: ['city'], formatted_address_en: 'City A' }),
      makeLocation('d5', { tags: ['city'], formatted_address_en: 'City B' }),
    ],
    { ...baseFilters, allowedAirlines: [] }
  );

  // 6) flight_number matches allowedAirlines blocklist (startsWith) => FAIL
  runCase(
    'flight_number matches blockedAirlines (startsWith) => FAIL',
    makeOffer('6', 'p6', 'd6', 'AF1234'),
    [
      makeLocation('p6', { tags: ['city'], formatted_address_en: 'City A' }),
      makeLocation('d6', { tags: ['city'], formatted_address_en: 'City B' }),
    ],
    baseFilters
  );

  // 7) flight_number does NOT match allowedAirlines blocklist => PASS
  runCase(
    'flight_number not in blockedAirlines => PASS',
    makeOffer('7', 'p7', 'd7', 'LH999'),
    [
      makeLocation('p7', { tags: ['city'], formatted_address_en: 'City A' }),
      makeLocation('d7', { tags: ['city'], formatted_address_en: 'City B' }),
    ],
    baseFilters
  );

  // 8) flight_number matches blockedAirlines via includes (not only prefix) => FAIL
  runCase(
    'flight_number contains blockedAirline code => FAIL',
    makeOffer('8', 'p8', 'd8', 'XXAFYY'),
    [
      makeLocation('p8', { tags: ['city'], formatted_address_en: 'City A' }),
      makeLocation('d8', { tags: ['city'], formatted_address_en: 'City B' }),
    ],
    baseFilters
  );
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});

