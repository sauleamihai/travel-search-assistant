import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { ChatGroq } from '@langchain/groq';
import { tool } from '@langchain/core/tools';
import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';

dotenv.config();

for (const requiredVar of ['GROQ_API_KEY', 'SERPAPI_API_KEY', 'SEARCHAPI_API_KEY']) {
  if (!process.env[requiredVar]) {
    console.warn(`[startup] Missing required env var: ${requiredVar}`);
  }
}
if (!process.env.APIFY_TOKEN) {
  console.warn('[startup] Missing optional env var: APIFY_TOKEN (flight fallback disabled — Google Flights failures/empty results will not retry via the Apify flight-price-scraper actor).');
}

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_HISTORY_TURNS = 20;
const messageHistories = {};

function getSessionHistory(sessionId) {
  if (!messageHistories[sessionId]) {
    messageHistories[sessionId] = [];
  }
  return messageHistories[sessionId];
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'img-src': ["'self'", 'https:', 'data:'],
    },
  },
}));
app.use(cors({ origin: ['http://localhost:5173', `http://localhost:${PORT}`], methods: ['GET', 'POST'] }));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use(express.static('public'));

// ---------------------------------------------------------------------------
// Raw data-fetching helpers — shared by the REST endpoints (used by the
// clickable search UI) and the LangChain tools (used by the chat assistant).
// ---------------------------------------------------------------------------

async function callHotelsApi({ location, checkIn, checkOut, adults }) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.append('engine', 'google_hotels');
  url.searchParams.append('q', location);
  url.searchParams.append('api_key', process.env.SERPAPI_API_KEY);
  url.searchParams.append('check_in_date', checkIn);
  url.searchParams.append('check_out_date', checkOut);
  if (adults) url.searchParams.append('adults', String(adults));

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`API returned status: ${response.status}`);
  return response.json();
}

async function callAirbnbApi({ location, checkIn, checkOut, adults }) {
  const url = new URL('https://www.searchapi.io/api/v1/search');
  url.searchParams.append('engine', 'airbnb');
  url.searchParams.append('q', location);
  url.searchParams.append('api_key', process.env.SEARCHAPI_API_KEY);
  url.searchParams.append('check_in_date', checkIn);
  url.searchParams.append('check_out_date', checkOut);
  if (adults) url.searchParams.append('adults', String(adults));

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`API returned status: ${response.status}`);
  return response.json();
}

async function callFlightsApi({ departureId, arrivalId, outboundDate, returnDate, adults }) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.append('engine', 'google_flights');
  url.searchParams.append('departure_id', departureId);
  url.searchParams.append('arrival_id', arrivalId);
  url.searchParams.append('outbound_date', outboundDate);
  url.searchParams.append('api_key', process.env.SERPAPI_API_KEY);
  if (adults) url.searchParams.append('adults', String(adults));

  if (returnDate) {
    url.searchParams.append('return_date', returnDate);
    url.searchParams.append('type', '1');
  } else {
    url.searchParams.append('type', '2');
  }

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`API returned status: ${response.status}`);
  return response.json();
}

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Flight result normalization — SerpApi (Google Flights) is the primary
// source. If it errors out or returns zero results, we retry once via the
// Apify "flight-price-scraper" actor as a fallback, and normalize both shapes
// into one common structure so the rest of the app doesn't need to care which
// source actually answered.
// ---------------------------------------------------------------------------

function normalizeSerpApiFlights(rawData) {
  const flightOptions = [...(rawData.best_flights || []), ...(rawData.other_flights || [])];

  const flights = flightOptions.map((option) => ({
    price: option.price ?? null,
    totalDuration: option.total_duration ?? null,
    stops: (option.flights?.length || 1) - 1,
    type: option.type || null,
    // SerpApi doesn't expose a per-option deep link — only the search-wide
    // google_flights_url below — so per-flight bookingUrl is always null here.
    bookingUrl: null,
    segments: (option.flights || []).map((segment) => ({
      airline: segment.airline || null,
      airlineLogo: segment.airline_logo || null,
      flightNumber: segment.flight_number || null,
      departureAirport: segment.departure_airport?.id || null,
      departureTime: segment.departure_airport?.time || null,
      arrivalAirport: segment.arrival_airport?.id || null,
      arrivalTime: segment.arrival_airport?.time || null,
      duration: segment.duration ?? null,
    })),
  }));

  return {
    source: 'google_flights',
    flights,
    priceInsights: rawData.price_insights || null,
    bookingUrl: rawData.search_metadata?.google_flights_url || null,
  };
}

// ---------------------------------------------------------------------------
// Flight fallback — Apify's "flight-price-scraper" actor
// (https://apify.com/makework36/flight-price-scraper). Replaces the old Sky
// Scrapper (RapidAPI) integration: it takes plain IATA codes directly (no
// separate airport-ID resolution step, so no more two-call rate-limit dance)
// and aggregates fares from Google Flights, Kiwi, Travelpayouts, Ryanair,
// EasyJet, Wizz Air, and Norwegian in a single call — including real
// per-flight booking links. Apify bills per actor-run plus per result item on
// the account tied to APIFY_TOKEN, so this is only invoked when Google
// Flights genuinely returns nothing.
// ---------------------------------------------------------------------------

const APIFY_FLIGHT_ACTOR_URL = 'https://api.apify.com/v2/acts/makework36~flight-price-scraper/run-sync-get-dataset-items';

async function callApifyFlightScraper({ departureId, arrivalId, outboundDate, returnDate, adults }) {
  const url = new URL(APIFY_FLIGHT_ACTOR_URL);
  url.searchParams.append('token', process.env.APIFY_TOKEN);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: departureId,
      destination: arrivalId,
      departDate: outboundDate,
      ...(returnDate ? { returnDate } : {}),
      adults: Number(adults) || 1,
      cabinClass: 'ECONOMY',
      currency: 'USD',
      maxFlights: 50,
    }),
  });

  if (!response.ok) {
    throw new Error(`Apify flight-price-scraper request returned status: ${response.status}`);
  }
  return response.json();
}

// The actor returns durations as strings like "5h 32m" rather than minutes.
function parseDurationToMinutes(duration) {
  if (typeof duration === 'number') return duration;
  if (typeof duration !== 'string') return null;
  const hoursMatch = duration.match(/(\d+)\s*h/);
  const minutesMatch = duration.match(/(\d+)\s*m/);
  if (!hoursMatch && !minutesMatch) return null;
  const hours = hoursMatch ? parseInt(hoursMatch[1], 10) : 0;
  const minutes = minutesMatch ? parseInt(minutesMatch[1], 10) : 0;
  return hours * 60 + minutes;
}

// Verified live against real calls: when the actor finds nothing for a
// route/date, it returns a single dataset item shaped like
// `{ error: "No flights found...", origin, destination, departDate, ... }`
// rather than an empty array — those must be filtered out, not treated as a
// flight result. Also confirmed live: successful items commonly have an
// empty `segments: []` with the only real flight detail (airline, times,
// duration) sitting at the top level of the item, so we synthesize a single
// segment from those fields when segments is empty instead of showing "no
// segment details available" for a flight that in fact has full data.
function normalizeApifyFlights(items, { departureId, arrivalId, outboundDate, returnDate } = {}) {
  const validItems = (items || []).filter((item) => !item.error);

  const flights = validItems.map((item) => {
    const priceValues = item.prices
      ? Object.values(item.prices).filter((price) => typeof price === 'number')
      : [];
    const price = typeof item.bestPrice === 'number'
      ? item.bestPrice
      : (priceValues.length > 0 ? Math.min(...priceValues) : null);

    const links = item.links || {};
    const bookingUrl = links[item.cheapestSource] || links.googleFlights || Object.values(links).find(Boolean) || null;

    const totalDuration = typeof item.durationMinutes === 'number'
      ? item.durationMinutes
      : parseDurationToMinutes(item.duration);

    const rawSegments = item.segments && item.segments.length > 0
      ? item.segments
      : [{
        airline: item.airline,
        from: item.from?.airport,
        to: item.to?.airport,
        departure: item.departTime,
        arrival: item.arriveTime,
        duration: item.duration,
        durationMinutes: item.durationMinutes,
      }];

    return {
      price,
      totalDuration,
      stops: typeof item.stops === 'number' ? item.stops : Math.max(rawSegments.length - 1, 0),
      type: returnDate ? 'round_trip' : 'one_way',
      bookingUrl,
      segments: rawSegments.map((segment) => ({
        airline: segment.airline || item.airline || null,
        airlineLogo: null,
        flightNumber: segment.flightCode || null,
        departureAirport: segment.from || item.from?.airport || null,
        departureTime: segment.departure || item.departTime || null,
        arrivalAirport: segment.to || item.to?.airport || null,
        arrivalTime: segment.arrival || item.arriveTime || null,
        duration: typeof segment.durationMinutes === 'number'
          ? segment.durationMinutes
          : parseDurationToMinutes(segment.duration),
      })),
    };
  });

  // Fall back to a general Google Flights search URL for the route/date if no
  // individual flight came with its own real booking link.
  const fallbackSearchUrl = `https://www.google.com/travel/flights?q=${encodeURIComponent(`${departureId} to ${arrivalId} on ${outboundDate}`)}`;

  return {
    source: 'apify',
    flights,
    priceInsights: null,
    bookingUrl: flights.find((f) => f.bookingUrl)?.bookingUrl || fallbackSearchUrl,
  };
}

// Tries Google Flights first; only falls back to the Apify actor if that
// errors out or comes back with zero results, and only if an Apify token
// is configured.
async function getFlightResults(params) {
  try {
    const rawData = await callFlightsApi(params);
    const normalized = normalizeSerpApiFlights(rawData);
    if (normalized.flights.length > 0) return normalized;
    console.log('[FALLBACK] Google Flights returned no results, trying Apify flight-price-scraper fallback...');
  } catch (error) {
    console.error('Google Flights search failed, trying Apify flight-price-scraper fallback:', error);
  }

  if (!process.env.APIFY_TOKEN) {
    return { source: 'google_flights', flights: [], priceInsights: null, bookingUrl: null };
  }

  try {
    console.log(`[LIVE API CALL] Hitting Apify flight-price-scraper fallback for flights from ${params.departureId} to ${params.arrivalId}`);
    const items = await callApifyFlightScraper(params);
    return normalizeApifyFlights(items, params);
  } catch (error) {
    console.error('Apify flight-price-scraper fallback also failed:', error);
    return { source: 'none', flights: [], priceInsights: null, bookingUrl: null };
  }
}

function cheapestPrice(normalized) {
  const prices = normalized.flights.map((flight) => flight.price).filter((price) => typeof price === 'number');
  if (prices.length > 0) return Math.min(...prices);
  return normalized.priceInsights?.lowest_price ?? null;
}

// ---------------------------------------------------------------------------
// REST endpoints — power the clickable search UI (public/app.js).
// ---------------------------------------------------------------------------

app.get('/api/hotels', async (req, res) => {
  const { location, checkIn, checkOut, adults } = req.query;

  if (!location || !checkIn || !checkOut) {
    return res.status(400).json({ error: 'location, checkIn, and checkOut are required.' });
  }
  if (!process.env.SERPAPI_API_KEY) {
    return res.status(503).json({ error: 'Hotel search is temporarily unavailable (missing API configuration).' });
  }

  console.log(`[LIVE API CALL] Hitting SerpApi for hotels in: ${location}`);

  try {
    const rawData = await callHotelsApi({ location, checkIn, checkOut, adults });

    const results = (rawData.properties || []).slice(0, 10).map((hotel) => ({
      name: hotel.name,
      link: hotel.link || null,
      image: hotel.images?.[0]?.original_image || hotel.images?.[0]?.thumbnail || null,
      rating: hotel.overall_rating || null,
      reviews: hotel.reviews || null,
      pricePerNight: hotel.rate_per_night?.lowest || null,
      totalPrice: hotel.total_rate?.lowest || null,
      amenities: hotel.amenities || [],
    }));

    res.json({ results });
  } catch (error) {
    console.error('Error fetching live hotel data:', error);
    res.status(502).json({ error: 'An error occurred while fetching live hotel data.' });
  }
});

app.get('/api/airbnb', async (req, res) => {
  const { location, checkIn, checkOut, adults } = req.query;

  if (!location || !checkIn || !checkOut) {
    return res.status(400).json({ error: 'location, checkIn, and checkOut are required.' });
  }
  if (!process.env.SEARCHAPI_API_KEY) {
    return res.status(503).json({ error: 'Airbnb search is temporarily unavailable (missing API configuration).' });
  }

  console.log(`[LIVE API CALL] Hitting SearchApi for Airbnb listings in: ${location}`);

  try {
    const rawData = await callAirbnbApi({ location, checkIn, checkOut, adults });

    const results = (rawData.properties || []).slice(0, 10).map((listing) => ({
      title: listing.title,
      link: listing.booking_link || listing.link || null,
      image: listing.images?.[0] || null,
      rating: listing.rating || null,
      reviews: listing.reviews || null,
      price: listing.price?.breakdown?.[0]?.price || listing.price?.price_per_qualifier || null,
      badges: listing.badges || [],
      accommodations: listing.accommodations || [],
    }));

    res.json({ results });
  } catch (error) {
    console.error('Error fetching live Airbnb data:', error);
    res.status(502).json({ error: 'An error occurred while fetching live Airbnb data.' });
  }
});

app.get('/api/flights', async (req, res) => {
  const { departureId, arrivalId, outboundDate, returnDate, adults } = req.query;

  if (!departureId || !arrivalId || !outboundDate) {
    return res.status(400).json({ error: 'departureId, arrivalId, and outboundDate are required.' });
  }
  if (!process.env.SERPAPI_API_KEY) {
    return res.status(503).json({ error: 'Flight search is temporarily unavailable (missing API configuration).' });
  }

  console.log(`[LIVE API CALL] Hitting SerpApi for flights from ${departureId} to ${arrivalId}`);

  try {
    const normalized = await getFlightResults({ departureId, arrivalId, outboundDate, returnDate, adults });

    const results = normalized.flights.slice(0, 10).map((flight) => ({
      price: flight.price,
      totalDuration: flight.totalDuration,
      stops: flight.stops,
      type: flight.type,
      bookingUrl: flight.bookingUrl || null,
      segments: flight.segments,
    }));

    res.json({
      results,
      source: normalized.source,
      lowestPrice: normalized.priceInsights?.lowest_price ?? null,
      priceLevel: normalized.priceInsights?.price_level ?? null,
      typicalPriceRange: normalized.priceInsights?.typical_price_range ?? null,
      bookingUrl: normalized.bookingUrl,
    });
  } catch (error) {
    console.error('Error fetching live flight data:', error);
    res.status(502).json({ error: 'An error occurred while fetching live flight data.' });
  }
});

// ---------------------------------------------------------------------------
// LangChain tools — power the chat assistant (/api/chat).
// ---------------------------------------------------------------------------

const fetchLiveHotelsTool = tool(
  async ({ location, checkIn, checkOut }) => {
    if (!process.env.SERPAPI_API_KEY) {
      return 'Hotel search is temporarily unavailable (missing API configuration). Please tell the user to try again later.';
    }
    if (!checkIn || !checkOut) {
      return 'Check-in and check-out dates are both required to search live availability. Ask the user for the exact dates before calling this tool again.';
    }

    console.log(`[LIVE API CALL] Hitting SerpApi for hotels in: ${location}`);

    try {
      const rawData = await callHotelsApi({ location, checkIn, checkOut });

      if (!rawData.properties || rawData.properties.length === 0) {
        return `No live listings found in ${location} for those dates.`;
      }

      return rawData.properties.slice(0, 5).map((hotel) => {
        return `Hotel: ${hotel.name}\nPrice: ${hotel.rate_per_night?.lowest || 'Price unavailable'}\nRating: ${hotel.overall_rating || 'N/A'} stars (${hotel.reviews} reviews)\nAmenities: ${hotel.amenities?.join(', ') || 'None listed'}\nBooking link: ${hotel.link || 'N/A'}`;
      }).join('\n\n');
    } catch (error) {
      console.error('Error fetching live hotel data:', error);
      return 'An error occurred while fetching live hotel data. Please tell the user to try again later.';
    }
  },
  {
    name: 'fetch_live_hotels',
    description: 'Call this tool to search for real-time hotel availability, pricing, and amenities in a specific city using Google Hotels. Both checkIn and checkOut are required by the underlying API — do not call this tool until you have both, ask the user first if they are missing.',
    schema: z.object({
      location: z.string().describe("The name of the city to search for hotels in (e.g., 'Rome', 'Paris')"),
      checkIn: z.string().describe('Check-in date in YYYY-MM-DD format. Required.'),
      checkOut: z.string().describe('Check-out date in YYYY-MM-DD format. Required.'),
    }),
  }
);

const fetchLiveAirbnbTool = tool(
  async ({ location, checkIn, checkOut, adults }) => {
    if (!process.env.SEARCHAPI_API_KEY) {
      return 'Airbnb search is temporarily unavailable (missing API configuration). Please tell the user to try again later.';
    }
    if (!checkIn || !checkOut) {
      return 'Check-in and check-out dates are both required to search live Airbnb availability. Ask the user for the exact dates before calling this tool again.';
    }

    console.log(`[LIVE API CALL] Hitting SearchApi for Airbnb listings in: ${location}`);

    try {
      const rawData = await callAirbnbApi({ location, checkIn, checkOut, adults });

      if (!rawData.properties || rawData.properties.length === 0) {
        return `No live Airbnb listings found in ${location} for those dates.`;
      }

      return rawData.properties.slice(0, 5).map((listing) => {
        const details = listing.accommodations?.join(', ') || 'No details listed';
        const badges = listing.badges?.length ? ` (${listing.badges.join(', ')})` : '';
        return `Listing: ${listing.title}${badges}\nPrice: ${listing.price?.breakdown?.[0]?.price || listing.price?.price_per_qualifier || 'Price unavailable'}\nRating: ${listing.rating || 'N/A'} stars (${listing.reviews || 0} reviews)\nDetails: ${details}\nBooking link: ${listing.booking_link || listing.link || 'N/A'}`;
      }).join('\n\n');
    } catch (error) {
      console.error('Error fetching live Airbnb data:', error);
      return 'An error occurred while fetching live Airbnb data. Please tell the user to try again later.';
    }
  },
  {
    name: 'fetch_live_airbnb',
    description: 'Call this tool to search for real-time Airbnb listings (short-term rentals, apartments, private rooms) in a specific city or area. Use this instead of fetch_live_hotels when the user specifically asks about Airbnb, vacation rentals, or short-term stays. Both checkIn and checkOut are required by the underlying API — do not call this tool until you have both, ask the user first if they are missing.',
    schema: z.object({
      location: z.string().describe("The name of the city or area to search for Airbnb listings in (e.g., 'Rome', 'Paris')"),
      checkIn: z.string().describe('Check-in date in YYYY-MM-DD format. Required.'),
      checkOut: z.string().describe('Check-out date in YYYY-MM-DD format. Required.'),
      adults: z.number().optional().describe('Number of adult guests, if specified by the user.'),
    }),
  }
);

function formatPriceInsights(priceInsights) {
  if (!priceInsights) return 'Price insight: not available for this route.';

  const { lowest_price: lowestPrice, price_level: priceLevel, typical_price_range: typicalRange, price_history: priceHistory } = priceInsights;

  const lines = [];
  if (lowestPrice) lines.push(`Current lowest price: $${lowestPrice}`);
  if (priceLevel) lines.push(`Price level vs. typical: ${priceLevel}`);
  if (typicalRange) lines.push(`Typical price range for this route: $${typicalRange[0]}–$${typicalRange[1]}`);

  if (priceHistory && priceHistory.length > 1) {
    const prices = priceHistory.map(([, price]) => price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const recentAvg = prices.slice(-6).reduce((sum, price) => sum + price, 0) / Math.min(6, prices.length);
    const earlierAvg = prices.slice(0, 6).reduce((sum, price) => sum + price, 0) / Math.min(6, prices.length);
    const trend = recentAvg < earlierAvg ? 'trending down' : recentAvg > earlierAvg ? 'trending up' : 'stable';
    lines.push(`Historical range over recent months: $${min}–$${max}. Recent trend: ${trend} (recent avg $${Math.round(recentAvg)} vs earlier avg $${Math.round(earlierAvg)}).`);
  }

  return lines.length > 0 ? lines.join('\n') : 'Price insight: not available for this route.';
}

const fetchLiveFlightsTool = tool(
  async ({ departureId, arrivalId, outboundDate, returnDate, adults }) => {
    if (!process.env.SERPAPI_API_KEY) {
      return 'Flight search is temporarily unavailable (missing API configuration). Please tell the user to try again later.';
    }
    if (!departureId || !arrivalId || !outboundDate) {
      return 'Departure airport, arrival airport, and outbound date are all required to search live flights. Ask the user for the missing details before calling this tool again.';
    }

    console.log(`[LIVE API CALL] Hitting SerpApi for flights from ${departureId} to ${arrivalId}`);

    try {
      const normalized = await getFlightResults({ departureId, arrivalId, outboundDate, returnDate, adults });

      if (normalized.flights.length === 0) {
        return `No live flights found from ${departureId} to ${arrivalId} for those dates, even after trying a backup data source.`;
      }

      const formattedFlights = normalized.flights.slice(0, 5).map((flight) => {
        const segments = flight.segments.map((segment) => {
          return `  ${segment.airline || 'Unknown airline'} ${segment.flightNumber || ''}: ${segment.departureAirport || ''} ${segment.departureTime || ''} -> ${segment.arrivalAirport || ''} ${segment.arrivalTime || ''}`;
        }).join('\n') || '  No segment details available';

        const durationHours = flight.totalDuration ? Math.floor(flight.totalDuration / 60) : null;
        const durationMinutes = flight.totalDuration ? flight.totalDuration % 60 : null;
        const durationText = durationHours !== null ? `${durationHours}h ${durationMinutes}m` : 'N/A';

        return `Price: $${flight.price ?? 'unavailable'}\nStops: ${flight.stops}\nTotal duration: ${durationText}\n${segments}`;
      }).join('\n\n');

      const priceInsightText = formatPriceInsights(normalized.priceInsights);
      const bookingLink = normalized.bookingUrl ? `\n\nBooking link: ${normalized.bookingUrl}` : '';
      const sourceNote = normalized.source === 'apify'
        ? '\n\n(Note: Google Flights had no listings for this search, so these results came from a backup flight data source instead — mention this to the user.)'
        : '';

      return `${formattedFlights}\n\n--- Price Insight ---\n${priceInsightText}${bookingLink}${sourceNote}`;
    } catch (error) {
      console.error('Error fetching live flight data:', error);
      return 'An error occurred while fetching live flight data. Please tell the user to try again later.';
    }
  },
  {
    name: 'fetch_live_flights',
    description: 'Call this tool to search for real-time flight availability and pricing between two airports using Google Flights. The result includes a Price Insight section (current price vs. typical range, and a historical trend) — use it to tell the user whether now is a good time to book. Requires IATA airport codes for departure and arrival — infer them from city names when possible, or ask the user to confirm if ambiguous. departureId, arrivalId, and outboundDate are required. Omit returnDate for a one-way search.',
    schema: z.object({
      departureId: z.string().describe("IATA airport code for the departure airport (e.g., 'JFK'). Required."),
      arrivalId: z.string().describe("IATA airport code for the arrival airport (e.g., 'LHR'). Required."),
      outboundDate: z.string().describe('Outbound flight date in YYYY-MM-DD format. Required.'),
      returnDate: z.string().optional().describe('Return flight date in YYYY-MM-DD format. Omit for a one-way trip.'),
      adults: z.number().optional().describe('Number of adult passengers, if specified by the user.'),
    }),
  }
);

const fetchFlightPriceCalendarTool = tool(
  async ({ departureId, arrivalId, outboundDate, returnDate, adults }) => {
    if (!process.env.SERPAPI_API_KEY) {
      return 'Flight search is temporarily unavailable (missing API configuration). Please tell the user to try again later.';
    }
    if (!departureId || !arrivalId || !outboundDate) {
      return 'Departure airport, arrival airport, and a center outbound date are required to compare nearby dates.';
    }

    const tripLengthDays = returnDate
      ? Math.round((new Date(`${returnDate}T00:00:00Z`) - new Date(`${outboundDate}T00:00:00Z`)) / 86400000)
      : null;

    console.log(`[LIVE API CALL] Hitting SerpApi for a ${departureId}->${arrivalId} price calendar around ${outboundDate}`);

    try {
      const offsets = [-2, -1, 0, 1, 2];
      const candidates = offsets.map((offset) => {
        const candidateOutbound = addDays(outboundDate, offset);
        const candidateReturn = tripLengthDays !== null ? addDays(candidateOutbound, tripLengthDays) : undefined;
        return { offset, candidateOutbound, candidateReturn };
      });

      const results = await Promise.all(
        candidates.map(async ({ candidateOutbound, candidateReturn }) => {
          try {
            const rawData = await callFlightsApi({ departureId, arrivalId, outboundDate: candidateOutbound, returnDate: candidateReturn, adults });
            return { outboundDate: candidateOutbound, returnDate: candidateReturn, price: cheapestPrice(normalizeSerpApiFlights(rawData)) };
          } catch {
            return { outboundDate: candidateOutbound, returnDate: candidateReturn, price: null };
          }
        })
      );

      const validResults = results.filter((r) => r.price !== null);
      if (validResults.length === 0) {
        return `Could not find comparable flight prices around ${outboundDate} for ${departureId} to ${arrivalId}.`;
      }

      const cheapest = validResults.reduce((best, current) => (current.price < best.price ? current : best));

      const lines = results.map((r) => {
        const tag = r.price !== null && r === cheapest ? ' <- cheapest' : '';
        const dateLabel = r.returnDate ? `${r.outboundDate} to ${r.returnDate}` : r.outboundDate;
        return `${dateLabel}: ${r.price !== null ? `$${r.price}` : 'unavailable'}${tag}`;
      });

      return `Price comparison for ${departureId} -> ${arrivalId} across nearby dates:\n${lines.join('\n')}\n\nCheapest option: ${cheapest.returnDate ? `${cheapest.outboundDate} to ${cheapest.returnDate}` : cheapest.outboundDate} at $${cheapest.price}.`;
    } catch (error) {
      console.error('Error building flight price calendar:', error);
      return 'An error occurred while comparing flight prices across dates. Please tell the user to try again later.';
    }
  },
  {
    name: 'fetch_flight_price_calendar',
    description: 'Call this tool when the user wants to know the best/cheapest dates to fly, or wants to compare prices across nearby dates, for a specific route. It searches live prices for the two days before and after the given outboundDate (5 dates total) and reports the cheapest. If returnDate is given, the trip length is preserved for each candidate date. This makes several live API calls, so only use it when the user explicitly wants a date comparison — for a single-date search use fetch_live_flights instead.',
    schema: z.object({
      departureId: z.string().describe("IATA airport code for the departure airport (e.g., 'JFK'). Required."),
      arrivalId: z.string().describe("IATA airport code for the arrival airport (e.g., 'LHR'). Required."),
      outboundDate: z.string().describe('The center date (YYYY-MM-DD) to compare nearby dates around. Required.'),
      returnDate: z.string().optional().describe('Return date in YYYY-MM-DD format, if this is a round trip. Used to preserve trip length across candidate dates.'),
      adults: z.number().optional().describe('Number of adult passengers, if specified by the user.'),
    }),
  }
);

const toolsByName = {
  [fetchLiveHotelsTool.name]: fetchLiveHotelsTool,
  [fetchLiveAirbnbTool.name]: fetchLiveAirbnbTool,
  [fetchLiveFlightsTool.name]: fetchLiveFlightsTool,
  [fetchFlightPriceCalendarTool.name]: fetchFlightPriceCalendarTool,
};

const allTools = [fetchLiveHotelsTool, fetchLiveAirbnbTool, fetchLiveFlightsTool, fetchFlightPriceCalendarTool];

const model = new ChatGroq({
  model: 'llama-3.3-70b-versatile',
  temperature: 0.1,
});

const modelWithTools = model.bindTools(allTools);

function buildMessages(sessionId, message) {
  const history = getSessionHistory(sessionId);
  const today = new Date().toISOString().slice(0, 10);
  const messages = [
    new SystemMessage(
      `You are a helpful hotel, short-term rental, and flight search assistant. Today's date is ${today}. Use the chat history to stay context-aware. If the user asks for traditional hotels, use the fetch_live_hotels tool. If the user asks about Airbnb, vacation rentals, or short-term/private stays, use the fetch_live_airbnb tool instead. If the user wants to search flights for a specific date, use fetch_live_flights, and always mention the Price Insight (current price vs. typical range, and trend) it returns so the user knows whether it's a good time to book. If the user wants to know the best/cheapest dates to fly or wants to compare nearby dates, use fetch_flight_price_calendar instead. Infer IATA airport codes from city names when possible, or ask the user to confirm if ambiguous. Only pass dates to a tool if the user specified them or gave enough detail to compute them (e.g. "next week") relative to today's date — never guess arbitrary dates, and never use a date before today.`
    ),
  ];

  for (const turn of history) {
    messages.push(new HumanMessage(turn.user));
    messages.push(new AIMessage(turn.assistant));
  }

  messages.push(new HumanMessage(message));
  return messages;
}

function streamAlreadyGeneratedText(res, text) {
  if (!text) return;
  const pieces = text.split(/(\s+)/).filter((piece) => piece.length > 0);
  for (const piece of pieces) {
    res.write(`data: ${JSON.stringify({ text: piece })}\n\n`);
  }
}

app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || !sessionId) {
    return res.status(400).json({ error: 'Message and SessionID are required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const messages = buildMessages(sessionId, message);
    const firstResponse = await modelWithTools.invoke(messages);

    let assistantText = '';

    if (firstResponse.tool_calls && firstResponse.tool_calls.length > 0) {
      messages.push(firstResponse);

      for (const toolCall of firstResponse.tool_calls) {
        console.log(`Model decided to call tool [${toolCall.name}] with args:`, toolCall.args);
        const selectedTool = toolsByName[toolCall.name];
        const toolMessage = selectedTool
          ? await selectedTool.invoke(toolCall)
          : new ToolMessage({ content: `Unknown tool: ${toolCall.name}`, tool_call_id: toolCall.id });
        messages.push(toolMessage);
      }

      const finalStream = await model.stream(messages);

      for await (const chunk of finalStream) {
        const content = chunk.content;
        if (typeof content === 'string' && content.length > 0) {
          assistantText += content;
          res.write(`data: ${JSON.stringify({ text: content })}\n\n`);
        }
      }
    } else {
      assistantText = typeof firstResponse.content === 'string' ? firstResponse.content : '';
      streamAlreadyGeneratedText(res, assistantText);
    }

    const history = getSessionHistory(sessionId);
    history.push({ user: message, assistant: assistantText });
    if (history.length > MAX_HISTORY_TURNS) history.shift();

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Agent execution error:', error);
    res.write(`data: ${JSON.stringify({ error: 'Failed to generate response.' })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Live Agent Server listening securely on http://localhost:${PORT}`);
});
