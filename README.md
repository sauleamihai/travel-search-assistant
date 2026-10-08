# Travel Search Assistant

A travel search app with hotel, Airbnb, and flight search forms plus an AI chat assistant. One Express server serves both the browser interface and the API; there is no separate frontend server or build step.

## Features

- Hotels: search Google Hotels through SerpApi, with photos, ratings, amenities, prices, and booking links when available.
- Airbnb: search rentals through SearchApi, with listing details and booking links.
- Flights: search Google Flights through SerpApi for one-way or round trips, with prices, stops, durations, and airline segments.
- Optional flight fallback: try the Apify `makework36/flight-price-scraper` actor when the primary flight search fails or returns no flights.
- Autocomplete: bundled airport and city datasets support destination selection without an external autocomplete service.
- Chat: LangChain and Groq (`llama-3.3-70b-versatile`) call live search tools and deliver replies using server-sent events.
- Flight insights: show available price levels and typical ranges; the assistant can summarize historical trends and compare five nearby departure dates (two days before through two days after a chosen date).

The app links to external booking sites. It does not process reservations or payments. Results and price insights depend on the upstream providers.

## Requirements

- Node.js **24** and npm for a consistent local, test, and Docker environment. The application dependencies require at least Node.js 20, but the test commands use a newer test-runner option.
- Internet access for dependency installation and live searches.
- A Groq API key for the assistant, a SerpApi key for hotels/flights, and a SearchApi key for Airbnb.
- An Apify token only if you want the optional flight fallback.

## Run locally (Windows PowerShell)

1. Open a terminal in the project directory:

   ```powershell
   Set-Location D:\Git_hub_protection_agentic\gasire_hotel_folosind_ai\hotel_rec_backend
   node --version
   npm --version
   ```

   If you cloned the project elsewhere, use that directory instead.

2. Install the dependencies from the committed lockfile:

   ```powershell
   npm ci
   ```

3. Create your local configuration **only if `.env` does not already exist**:

   ```powershell
   if (!(Test-Path .env)) { Copy-Item .env.example .env }
   notepad .env
   ```

   Replace the example values with your real keys:

   ```dotenv
   PORT=3000
   GROQ_API_KEY=your_real_groq_key
   SERPAPI_API_KEY=your_real_serpapi_key
   SEARCHAPI_API_KEY=your_real_searchapi_key
   APIFY_TOKEN=
   ```

   Leave `APIFY_TOKEN` empty to disable the fallback.

4. Start the app:

   ```powershell
   npm start
   ```

5. Open **http://localhost:3000** in your browser. Keep the terminal running; press **Ctrl+C** to stop the app. Restart it after changing `.env` or server code. If you change `PORT`, open the corresponding localhost port.

For macOS/Linux, enter the project directory, run `npm ci`, copy `.env.example` to `.env` if needed with `cp .env.example .env`, edit the keys, and run `npm start`.

Always start from the project root: dotenv and static file serving use paths relative to the working directory. Open the app through the server URL rather than opening `public/index.html` directly.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port; defaults to `3000`. |
| `GROQ_API_KEY` | Groq authentication for the chat model. Configure this before starting: the model is constructed at startup. |
| `SERPAPI_API_KEY` | Google Hotels and Google Flights searches, including nearby-date comparisons. |
| `SEARCHAPI_API_KEY` | Airbnb searches. |
| `APIFY_TOKEN` | Optional fallback authentication. Fallback runs can consume Apify account credits. |
| `TRUST_PROXY_HOPS` | Defaults to no proxy trust. Set to `1` only behind the single trusted Nginx proxy in the deployment guide. |

Get keys from [Groq](https://console.groq.com/), [SerpApi](https://serpapi.com/), [SearchApi](https://www.searchapi.io/), and optionally [Apify](https://console.apify.com/).

Keep `.env` private; it is ignored by Git. Provider keys remain on the server. An Apify token alone does not enable the Flights endpoint: it also requires `SERPAPI_API_KEY`.

## Using the app

- **Hotels / Airbnb:** enter a destination, check-in/check-out dates, and adult guest count, then click Search. Use future dates and a check-out date after check-in.
- **Flights:** type a city or airport and select an airport from the suggestions, or enter its three-letter IATA code (for example `OTP` and `LHR`). Enter a departure date; leave return blank for one-way travel.
- **Chat Assistant:** give the route or destination and exact dates. For example: "Find hotels in Rome from 2026-11-10 to 2026-11-13" or "Compare the cheapest departure dates around 2026-11-10 from OTP to LHR." Adjust example dates if they are in the past.

Search forms return up to ten results; the assistant's individual search tools summarize up to five. Nearby-date comparisons make five SerpApi searches and preserve trip length for round trips. They compare only that five-day window, not an entire month.

## Architecture and files

```text
package.json               Dependencies and npm commands
package-lock.json          Locked dependency versions
.env.example               Configuration template
src/server.js              Express middleware, provider integrations,
                           normalized flight results, AI tools, chat endpoint
public/index.html          Tabbed interface and CSS
public/app.js              Forms, autocomplete, result rendering, chat client
public/airports.json        Bundled airport reference data
public/cities.json          Bundled city reference data
scripts/build-airports.js  Airport/city dataset generator
```

Browser forms call the REST endpoints. Chat sends messages to the backend, where the Groq model chooses a search tool; the tool calls the provider and the model summarizes its output. Chat history is stored in server memory, capped at 20 turns per session. A page reload creates a new browser session; restarting the server clears all histories. There is no database or account system.

## API reference

Dates use `YYYY-MM-DD`. Query parameters named below are required unless marked optional.

| Method | Path | Inputs |
| --- | --- | --- |
| GET | `/api/hotels` | `location`, `checkIn`, `checkOut`, optional `adults` |
| GET | `/api/airbnb` | `location`, `checkIn`, `checkOut`, optional `adults` |
| GET | `/api/flights` | `departureId`, `arrivalId`, `outboundDate`, optional `returnDate`, `adults` |
| POST | `/api/chat` | JSON body containing `message` and `sessionId` |

Search endpoints return JSON with a `results` array. Flights additionally include `source`, `lowestPrice`, `priceLevel`, `typicalPriceRange`, and `bookingUrl`; unavailable values may be null. Chat returns `text/event-stream` events containing `{ "text": "..." }` or `{ "error": "..." }`, and successful completion ends with `[DONE]`.

All `/api/` endpoints share a limit of 100 requests per IP per 15 minutes. CORS currently allows `http://localhost:5173` and `http://localhost:<PORT>`. Helmet provides security headers. The app currently has no authentication; hosting it publicly requires reviewing access and provider usage limits.

## Airport data maintenance

The datasets are already included; generating them is **not** part of normal setup. The generator reads an OpenFlights-format `airports.dat` file from a hard-coded Windows path (`C:\Users\saule\AppData\Local\Temp\airports.dat`). To regenerate, obtain that source file, update `inputPath` in the script for your machine, then run:

```powershell
node scripts/build-airports.js
```

The script rewrites both JSON datasets and adds Brasov's `GHV` airport manually. City suggestions are derived from airport records rather than a complete worldwide city directory.

## Troubleshooting and verification

- **Missing key / unavailable search:** check the relevant `.env` value and restart. Placeholder values are not valid keys. Hotel, Airbnb, and flight endpoints return HTTP 503 when their required search key is absent.
- **Assistant cannot connect / fails to generate a response:** check `GROQ_API_KEY`, server logs, and the model's availability on your Groq account.
- **No flights:** try another route/date and check server logs. Primary and fallback failures can appear as an empty result list. Apify results do not include Google price insights.
- **Port already in use (`EADDRINUSE`):** stop the other server or change `PORT` in `.env` and restart.
- **HTTP 429:** the local API request limit or a provider quota may have been reached; inspect the response and logs.
- **Autocomplete fails:** confirm `/airports.json` and `/cities.json` load from your localhost server.
- **PowerShell blocks `npm.ps1`:** use `npm.cmd ci` and `npm.cmd start`.

Basic syntax checks:

```powershell
node --check src/server.js
node --check public/app.js
node --check scripts/build-airports.js
```

Run `npm test` for the automated API tests, or `npm run test:ci` to also write `test-results.xml` for Jenkins. Tests use dummy credentials and mocked provider responses; they do not spend API credits. They cover static assets, validation, missing credentials, hotel/Airbnb mapping, upstream failures, flight normalization, and the optional fallback. Successful AI conversations and live provider compatibility still need manual integration checks with valid keys.

## Docker and Jenkins on AWS

Follow [the Ubuntu deployment walkthrough](docs/DEPLOYMENT.md) for AWS networking, Docker, Jenkins, HTTPS, deployment, and rollback.

With a running Docker Engine and a configured `.env`:

```sh
docker build --target test -t travel-search-test:local .
docker run --rm --network none travel-search-test:local
docker build --target runtime -t travel-search:local .
docker compose -p travel-search up -d --wait --wait-timeout 90
```

Open http://localhost:3000. Compose binds the app to localhost; remote access uses an SSH tunnel or the Nginx proxy described in the guide. `GET /healthz` checks that the server responds without calling paid providers. Docker runs the app as a non-root user and excludes `.env` files from the image. The Jenkins pipeline tests and builds by default; deployment is opt-in with `DEPLOY=true` and restricted to the checked-out `origin/main` commit.
