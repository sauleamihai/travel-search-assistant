# Travel Search Assistant

A full-stack travel search app that combines a clickable, form-based UI for hotels, Airbnb stays, and flights with an AI chat assistant that can reason about live pricing.

Search hotels, Airbnb listings, and flights side by side, or ask the built-in assistant things like *"What's the cheapest week to fly JFK to LHR in August?"* and get an answer grounded in real, live price data — not a guess.

## Features

- **Hotels & Airbnb search** — live listings with photos, ratings, amenities, and direct booking links, powered by SerpApi and SearchApi.
- **Flight search** — nonstop/connection details, per-segment airline info, and a link straight to Google Flights. If Google Flights has no listings for a route, it automatically retries via an Apify "flight-price-scraper" fallback (Google Flights, Kiwi, Travelpayouts, Ryanair, EasyJet, Wizz Air, Norwegian) — optional, see `APIFY_TOKEN` below.
- **Flight price insight** — current price vs. typical range, trend direction (up/down), and a nearby-date price comparison to help you spot the cheapest time to book.
- **Worldwide airport & city autocomplete** — a custom-built, fully clickable dropdown backed by a static dataset of 6,000+ airports and 5,700+ cities (OpenFlights), searchable by IATA code, city, airport name, or country.
- **AI chat assistant** — a LangChain + Groq-powered agent that can call the same live search tools conversationally, with streaming responses.

## Tech stack

- **Backend:** Node.js, Express 5
- **AI:** LangChain, Groq (`ChatGroq`), tool-calling with Zod schemas
- **Frontend:** Plain HTML/CSS/vanilla JavaScript (no build step)
- **Data sources:** SerpApi (Google Hotels, Google Flights), SearchApi (Airbnb), OpenFlights (airport/city reference data)
- **Security:** Helmet (CSP), CORS, rate limiting

## Getting started

### Prerequisites

- Node.js 18+
- API keys for [SerpApi](https://serpapi.com/) and [SearchApi](https://www.searchapi.io/), and a [Groq](https://console.groq.com/) API key for the chat assistant

### Setup

```bash
npm install
cp .env.example .env   # then fill in your API keys
npm start
```

The app will be available at `http://localhost:3000`.

### Environment variables

| Variable | Description |
|---|---|
| `PORT` | Port the server listens on (default `3000`) |
| `GROQ_API_KEY` | Groq API key, used by the chat assistant |
| `SERPAPI_API_KEY` | SerpApi key, used for hotel and flight search |
| `SEARCHAPI_API_KEY` | SearchApi key, used for Airbnb search |
| `APIFY_TOKEN` | *(Optional)* Apify API token, enables the flight-price-scraper fallback when Google Flights returns no results. Billed per-run/per-result on your Apify account — leave blank to disable. |

## Project structure

```
src/server.js       Express server, REST endpoints, LangChain tools & chat endpoint
public/index.html   Tabbed UI (Hotels / Airbnb / Flights / Chat Assistant)
public/app.js        Search forms, result rendering, autocomplete, chat streaming
public/airports.json Static worldwide airport dataset (generated)
public/cities.json   Static worldwide city dataset (generated)
scripts/build-airports.js  Regenerates airports.json/cities.json from OpenFlights source data
```
