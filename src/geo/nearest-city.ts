// Turns a viewer's coarse Cloudflare geo (state/province name + lat/lon) into a friendly,
// deliberately-approximate location string like "~10 mi from NYC, NY".
//
// Privacy by design: we show the distance to the LARGEST city of the viewer's own
// state/province (NYC for New York — not the capital, Albany), rounded to the nearest
// 5 miles, so the exact position is never revealed. When we can't place them precisely
// we degrade to just the state, then the country's largest city, then bare country.

interface City {
  name: string; // display name of the largest city
  label: string; // compact region tag shown after the city (state code / country code)
  lat: number;
  lon: number;
}

// Largest city per US state (+ DC), keyed by the lowercased full state name exactly as
// Cloudflare reports it in cf.region. label = the 2-letter state code.
const US_STATES: Record<string, City> = {
  "alabama": { name: "Birmingham", label: "AL", lat: 33.52, lon: -86.81 },
  "alaska": { name: "Anchorage", label: "AK", lat: 61.22, lon: -149.90 },
  "arizona": { name: "Phoenix", label: "AZ", lat: 33.45, lon: -112.07 },
  "arkansas": { name: "Little Rock", label: "AR", lat: 34.75, lon: -92.29 },
  "california": { name: "Los Angeles", label: "CA", lat: 34.05, lon: -118.24 },
  "colorado": { name: "Denver", label: "CO", lat: 39.74, lon: -104.99 },
  "connecticut": { name: "Bridgeport", label: "CT", lat: 41.19, lon: -73.20 },
  "delaware": { name: "Wilmington", label: "DE", lat: 39.75, lon: -75.55 },
  "district of columbia": { name: "Washington", label: "DC", lat: 38.90, lon: -77.04 },
  "florida": { name: "Jacksonville", label: "FL", lat: 30.33, lon: -81.66 },
  "georgia": { name: "Atlanta", label: "GA", lat: 33.75, lon: -84.39 },
  "hawaii": { name: "Honolulu", label: "HI", lat: 21.31, lon: -157.86 },
  "idaho": { name: "Boise", label: "ID", lat: 43.62, lon: -116.21 },
  "illinois": { name: "Chicago", label: "IL", lat: 41.88, lon: -87.63 },
  "indiana": { name: "Indianapolis", label: "IN", lat: 39.77, lon: -86.16 },
  "iowa": { name: "Des Moines", label: "IA", lat: 41.59, lon: -93.62 },
  "kansas": { name: "Wichita", label: "KS", lat: 37.69, lon: -97.34 },
  "kentucky": { name: "Louisville", label: "KY", lat: 38.25, lon: -85.76 },
  "louisiana": { name: "New Orleans", label: "LA", lat: 29.95, lon: -90.07 },
  "maine": { name: "Portland", label: "ME", lat: 43.66, lon: -70.26 },
  "maryland": { name: "Baltimore", label: "MD", lat: 39.29, lon: -76.61 },
  "massachusetts": { name: "Boston", label: "MA", lat: 42.36, lon: -71.06 },
  "michigan": { name: "Detroit", label: "MI", lat: 42.33, lon: -83.05 },
  "minnesota": { name: "Minneapolis", label: "MN", lat: 44.98, lon: -93.27 },
  "mississippi": { name: "Jackson", label: "MS", lat: 32.30, lon: -90.18 },
  "missouri": { name: "Kansas City", label: "MO", lat: 39.10, lon: -94.58 },
  "montana": { name: "Billings", label: "MT", lat: 45.78, lon: -108.50 },
  "nebraska": { name: "Omaha", label: "NE", lat: 41.26, lon: -95.93 },
  "nevada": { name: "Las Vegas", label: "NV", lat: 36.17, lon: -115.14 },
  "new hampshire": { name: "Manchester", label: "NH", lat: 42.99, lon: -71.45 },
  "new jersey": { name: "Newark", label: "NJ", lat: 40.74, lon: -74.17 },
  "new mexico": { name: "Albuquerque", label: "NM", lat: 35.08, lon: -106.65 },
  "new york": { name: "NYC", label: "NY", lat: 40.71, lon: -74.01 },
  "north carolina": { name: "Charlotte", label: "NC", lat: 35.23, lon: -80.84 },
  "north dakota": { name: "Fargo", label: "ND", lat: 46.88, lon: -96.79 },
  "ohio": { name: "Columbus", label: "OH", lat: 39.96, lon: -83.00 },
  "oklahoma": { name: "Oklahoma City", label: "OK", lat: 35.47, lon: -97.52 },
  "oregon": { name: "Portland", label: "OR", lat: 45.52, lon: -122.68 },
  "pennsylvania": { name: "Philadelphia", label: "PA", lat: 39.95, lon: -75.17 },
  "rhode island": { name: "Providence", label: "RI", lat: 41.82, lon: -71.41 },
  "south carolina": { name: "Charleston", label: "SC", lat: 32.78, lon: -79.93 },
  "south dakota": { name: "Sioux Falls", label: "SD", lat: 43.55, lon: -96.70 },
  "tennessee": { name: "Nashville", label: "TN", lat: 36.16, lon: -86.78 },
  "texas": { name: "Houston", label: "TX", lat: 29.76, lon: -95.37 },
  "utah": { name: "Salt Lake City", label: "UT", lat: 40.76, lon: -111.89 },
  "vermont": { name: "Burlington", label: "VT", lat: 44.48, lon: -73.21 },
  "virginia": { name: "Virginia Beach", label: "VA", lat: 36.85, lon: -75.98 },
  "washington": { name: "Seattle", label: "WA", lat: 47.61, lon: -122.33 },
  "west virginia": { name: "Charleston", label: "WV", lat: 38.35, lon: -81.63 },
  "wisconsin": { name: "Milwaukee", label: "WI", lat: 43.04, lon: -87.91 },
  "wyoming": { name: "Cheyenne", label: "WY", lat: 41.14, lon: -104.82 },
};

// Largest city per Canadian province, keyed by the lowercased province name (cf.region).
const CA_PROVINCES: Record<string, City> = {
  "ontario": { name: "Toronto", label: "ON", lat: 43.65, lon: -79.38 },
  "quebec": { name: "Montreal", label: "QC", lat: 45.50, lon: -73.57 },
  "british columbia": { name: "Vancouver", label: "BC", lat: 49.28, lon: -123.12 },
  "alberta": { name: "Calgary", label: "AB", lat: 51.05, lon: -114.07 },
  "manitoba": { name: "Winnipeg", label: "MB", lat: 49.90, lon: -97.14 },
  "saskatchewan": { name: "Saskatoon", label: "SK", lat: 52.13, lon: -106.67 },
  "nova scotia": { name: "Halifax", label: "NS", lat: 44.65, lon: -63.58 },
  "new brunswick": { name: "Moncton", label: "NB", lat: 46.09, lon: -64.78 },
  "newfoundland and labrador": { name: "St. John's", label: "NL", lat: 47.56, lon: -52.71 },
  "prince edward island": { name: "Charlottetown", label: "PE", lat: 46.24, lon: -63.13 },
};

// Largest city per country — the fallback when a viewer's region isn't in the tables
// above (most non-US/CA traffic). Keyed by the ISO-3166 alpha-2 code (cf.country).
const COUNTRY_CITIES: Record<string, City> = {
  "US": { name: "NYC", label: "US", lat: 40.71, lon: -74.01 },
  "CA": { name: "Toronto", label: "CA", lat: 43.65, lon: -79.38 },
  "GB": { name: "London", label: "UK", lat: 51.51, lon: -0.13 },
  "FR": { name: "Paris", label: "FR", lat: 48.85, lon: 2.35 },
  "DE": { name: "Berlin", label: "DE", lat: 52.52, lon: 13.40 },
  "ES": { name: "Madrid", label: "ES", lat: 40.42, lon: -3.70 },
  "IT": { name: "Rome", label: "IT", lat: 41.90, lon: 12.50 },
  "NL": { name: "Amsterdam", label: "NL", lat: 52.37, lon: 4.90 },
  "IE": { name: "Dublin", label: "IE", lat: 53.35, lon: -6.26 },
  "PT": { name: "Lisbon", label: "PT", lat: 38.72, lon: -9.14 },
  "BE": { name: "Brussels", label: "BE", lat: 50.85, lon: 4.35 },
  "CH": { name: "Zurich", label: "CH", lat: 47.38, lon: 8.54 },
  "AT": { name: "Vienna", label: "AT", lat: 48.21, lon: 16.37 },
  "SE": { name: "Stockholm", label: "SE", lat: 59.33, lon: 18.07 },
  "NO": { name: "Oslo", label: "NO", lat: 59.91, lon: 10.75 },
  "DK": { name: "Copenhagen", label: "DK", lat: 55.68, lon: 12.57 },
  "FI": { name: "Helsinki", label: "FI", lat: 60.17, lon: 24.94 },
  "PL": { name: "Warsaw", label: "PL", lat: 52.23, lon: 21.01 },
  "RU": { name: "Moscow", label: "RU", lat: 55.76, lon: 37.62 },
  "UA": { name: "Kyiv", label: "UA", lat: 50.45, lon: 30.52 },
  "TR": { name: "Istanbul", label: "TR", lat: 41.01, lon: 28.98 },
  "JP": { name: "Tokyo", label: "JP", lat: 35.68, lon: 139.69 },
  "CN": { name: "Shanghai", label: "CN", lat: 31.23, lon: 121.47 },
  "KR": { name: "Seoul", label: "KR", lat: 37.57, lon: 126.98 },
  "IN": { name: "Mumbai", label: "IN", lat: 19.08, lon: 72.88 },
  "SG": { name: "Singapore", label: "SG", lat: 1.35, lon: 103.82 },
  "HK": { name: "Hong Kong", label: "HK", lat: 22.32, lon: 114.17 },
  "AU": { name: "Sydney", label: "AU", lat: -33.87, lon: 151.21 },
  "NZ": { name: "Auckland", label: "NZ", lat: -36.85, lon: 174.76 },
  "BR": { name: "São Paulo", label: "BR", lat: -23.55, lon: -46.63 },
  "MX": { name: "Mexico City", label: "MX", lat: 19.43, lon: -99.13 },
  "AR": { name: "Buenos Aires", label: "AR", lat: -34.60, lon: -58.38 },
  "ZA": { name: "Johannesburg", label: "ZA", lat: -26.20, lon: 28.05 },
  "AE": { name: "Dubai", label: "AE", lat: 25.20, lon: 55.27 },
  "IL": { name: "Tel Aviv", label: "IL", lat: 32.08, lon: 34.78 },
  "EG": { name: "Cairo", label: "EG", lat: 30.04, lon: 31.24 },
  "NG": { name: "Lagos", label: "NG", lat: 6.52, lon: 3.38 },
  "ID": { name: "Jakarta", label: "ID", lat: -6.21, lon: 106.85 },
  "TH": { name: "Bangkok", label: "TH", lat: 13.76, lon: 100.50 },
  "PH": { name: "Manila", label: "PH", lat: 14.60, lon: 120.98 },
  "MY": { name: "Kuala Lumpur", label: "MY", lat: 3.14, lon: 101.69 },
  "VN": { name: "Ho Chi Minh City", label: "VN", lat: 10.82, lon: 106.63 },
};

// Reverse map: full US state name → 2-letter code, for the no-coordinates fallback where
// we can only show the state (e.g. "New York" → "NY").
const US_STATE_ABBR: Record<string, string> = Object.fromEntries(
  Object.entries(US_STATES).map(([name, c]) => [name, c.label])
);
const CA_PROVINCE_ABBR: Record<string, string> = Object.fromEntries(
  Object.entries(CA_PROVINCES).map(([name, c]) => [name, c.label])
);

// Great-circle distance in miles between two lat/lon points.
function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8; // Earth radius, miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Look up the reference city for a viewer: their state/province's largest city if we
// know it, else their country's largest city.
function referenceCity(country: string | null, region: string | null): City | null {
  const c = (country ?? "").toUpperCase();
  const r = (region ?? "").trim().toLowerCase();
  if (c === "US" && US_STATES[r]) return US_STATES[r];
  if (c === "CA" && CA_PROVINCES[r]) return CA_PROVINCES[r];
  if (COUNTRY_CITIES[c]) return COUNTRY_CITIES[c];
  return null;
}

/**
 * Compose the approximate location label (no flag) for a viewer, e.g.:
 *   "~10 mi from NYC, NY"   (US, coords known)
 *   "Close to Paris, FR"    (very close)
 *   "New York, US"          (state known, no coords)
 *   "United States" / ""    (last-resort fallbacks)
 * Returns "" when nothing at all is known.
 */
export function describeLocation(
  country: string | null,
  region: string | null,
  latStr: string | null,
  lonStr: string | null
): string {
  const lat = latStr != null ? parseFloat(latStr) : NaN;
  const lon = lonStr != null ? parseFloat(lonStr) : NaN;
  const city = referenceCity(country, region);

  if (city && Number.isFinite(lat) && Number.isFinite(lon)) {
    const miles = haversineMiles(lat, lon, city.lat, city.lon);
    const rounded = Math.max(5, Math.round(miles / 5) * 5);
    const dist = miles < 5 ? `Close to ${city.name}` : `~${rounded} mi from ${city.name}`;
    return `${dist}, ${city.label}`;
  }

  // No coordinates (or unmapped country): show the best textual region we have.
  const c = (country ?? "").toUpperCase();
  const r = (region ?? "").trim();
  const regionLabel =
    (c === "US" && US_STATE_ABBR[r.toLowerCase()]) ||
    (c === "CA" && CA_PROVINCE_ABBR[r.toLowerCase()]) ||
    r;
  return [regionLabel, c].filter(Boolean).join(", ");
}
