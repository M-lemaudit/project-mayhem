/**
 * Manual script: exercise airport filter edge-cases (bypass + validation).
 * Run: npm run build && node dist/scripts/test-airport-filter.js
 */
import { FilterEngine, type BotFilters, type IncludedResource, type OfferShape } from '../core/filter-engine';

function makeOffer(
  id: string,
  pickupId: string,
  dropoffId: string,
  price: string = '10'
): OfferShape {
  return {
    id,
    attributes: { price },
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
    airport_iata,
    formatted_address_en,
  }: { tags?: unknown; airport_iata?: unknown; formatted_address_en?: unknown }
): IncludedResource {
  return {
    id,
    type: 'locations',
    attributes: {
      ...(tags !== undefined ? { tags } : {}),
      ...(airport_iata !== undefined ? { airport_iata } : {}),
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
    includedAirlines: ['MCO', 'LAX'],
  };

  // 1) City-to-city: no airport tags => bypass => PASS
  runCase(
    'city-to-city bypass',
    makeOffer('1', 'p1', 'd1'),
    [
      makeLocation('p1', { tags: ['city'], formatted_address_en: 'Downtown' }),
      makeLocation('d1', { tags: ['city'], formatted_address_en: 'Uptown' }),
    ],
    baseFilters
  );

  // 2) Pickup is airport (MCO) and allowed => PASS
  runCase(
    'pickup airport allowed',
    makeOffer('2', 'p2', 'd2'),
    [
      makeLocation('p2', { tags: ['airport'], airport_iata: 'MCO' }),
      makeLocation('d2', { tags: ['city'], formatted_address_en: 'Downtown' }),
    ],
    baseFilters
  );

  // 3) Pickup is airport (MCO) but NOT allowed => FAIL
  runCase(
    'pickup airport not allowed',
    makeOffer('3', 'p3', 'd3'),
    [
      makeLocation('p3', { tags: ['airport'], airport_iata: 'MCO' }),
      makeLocation('d3', { tags: ['city'], formatted_address_en: 'Downtown' }),
    ],
    { ...baseFilters, includedAirlines: ['LAX'] }
  );

  // 4) Both airport: require BOTH IATAs allowed => FAIL if only one allowed
  runCase(
    'both airports only one allowed',
    makeOffer('4', 'p4', 'd4'),
    [
      makeLocation('p4', { tags: ['airport'], airport_iata: 'MCO' }),
      makeLocation('d4', { tags: ['airport'], airport_iata: 'LAX' }),
    ],
    { ...baseFilters, includedAirlines: ['MCO'] }
  );

  // 5) Both airport: both allowed => PASS
  runCase(
    'both airports both allowed',
    makeOffer('5', 'p5', 'd5'),
    [
      makeLocation('p5', { tags: ['airport'], airport_iata: 'MCO' }),
      makeLocation('d5', { tags: ['airport'], airport_iata: 'LAX' }),
    ],
    baseFilters
  );
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});

