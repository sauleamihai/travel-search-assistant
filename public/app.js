const API_BASE = "/api";

let airportsDataPromise = null;
let citiesDataPromise = null;

function loadAirports() {
  if (!airportsDataPromise) {
    airportsDataPromise = fetch('/airports.json').then((r) => r.json());
  }
  return airportsDataPromise;
}

function loadCities() {
  if (!citiesDataPromise) {
    citiesDataPromise = fetch('/cities.json').then((r) => r.json());
  }
  return citiesDataPromise;
}

function setupAirportAutocomplete(inputId, listId) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  let matches = [];
  let highlightedIndex = -1;

  function render() {
    if (matches.length === 0) {
      list.innerHTML = '<div class="autocomplete-empty">No matching airports</div>';
    } else {
      list.innerHTML = matches.map((airport, index) => `
        <div class="autocomplete-item${index === highlightedIndex ? ' highlighted' : ''}" data-index="${index}">
          <span class="ac-code">${escapeHtml(airport.code)}</span>${escapeHtml(airport.name)}
          <div class="ac-sub">${escapeHtml(airport.city)}, ${escapeHtml(airport.country)}</div>
        </div>
      `).join('');
    }
    list.classList.add('active');
  }

  function hide() {
    list.classList.remove('active');
    highlightedIndex = -1;
  }

  function select(airport) {
    input.value = airport.code;
    hide();
  }

  input.addEventListener('input', async () => {
    const query = input.value.trim().toLowerCase();
    if (!query) return hide();

    const airports = await loadAirports();
    matches = airports.filter((airport) =>
      airport.code.toLowerCase().startsWith(query) ||
      airport.city.toLowerCase().startsWith(query) ||
      airport.name.toLowerCase().includes(query) ||
      airport.country.toLowerCase().startsWith(query)
    ).slice(0, 30);
    highlightedIndex = -1;
    render();
  });

  input.addEventListener('focus', () => {
    if (input.value.trim() && matches.length > 0) render();
  });

  input.addEventListener('keydown', (event) => {
    if (!list.classList.contains('active')) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlightedIndex = Math.min(highlightedIndex + 1, matches.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlightedIndex = Math.max(highlightedIndex - 1, 0);
      render();
    } else if (event.key === 'Enter') {
      if (highlightedIndex >= 0 && matches[highlightedIndex]) {
        event.preventDefault();
        select(matches[highlightedIndex]);
      } else {
        hide();
      }
    } else if (event.key === 'Escape') {
      hide();
    }
  });

  list.addEventListener('mousedown', (event) => {
    const item = event.target.closest('.autocomplete-item');
    if (!item) return;
    event.preventDefault();
    const index = Number(item.dataset.index);
    if (matches[index]) select(matches[index]);
  });

  document.addEventListener('click', (event) => {
    if (event.target !== input && !list.contains(event.target)) hide();
  });
}

function setupCityAutocomplete(inputId, listId) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  let matches = [];
  let highlightedIndex = -1;

  function render() {
    if (matches.length === 0) {
      list.innerHTML = '<div class="autocomplete-empty">No matching cities</div>';
    } else {
      list.innerHTML = matches.map((place, index) => `
        <div class="autocomplete-item${index === highlightedIndex ? ' highlighted' : ''}" data-index="${index}">
          ${escapeHtml(place.city)}
          <div class="ac-sub">${escapeHtml(place.country)}</div>
        </div>
      `).join('');
    }
    list.classList.add('active');
  }

  function hide() {
    list.classList.remove('active');
    highlightedIndex = -1;
  }

  function select(place) {
    input.value = place.city;
    hide();
  }

  input.addEventListener('input', async () => {
    const query = input.value.trim().toLowerCase();
    if (!query) return hide();

    const cities = await loadCities();
    matches = cities.filter((place) =>
      place.city.toLowerCase().startsWith(query) ||
      place.country.toLowerCase().startsWith(query)
    ).slice(0, 30);
    highlightedIndex = -1;
    render();
  });

  input.addEventListener('focus', () => {
    if (input.value.trim() && matches.length > 0) render();
  });

  input.addEventListener('keydown', (event) => {
    if (!list.classList.contains('active')) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      highlightedIndex = Math.min(highlightedIndex + 1, matches.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlightedIndex = Math.max(highlightedIndex - 1, 0);
      render();
    } else if (event.key === 'Enter') {
      if (highlightedIndex >= 0 && matches[highlightedIndex]) {
        event.preventDefault();
        select(matches[highlightedIndex]);
      } else {
        hide();
      }
    } else if (event.key === 'Escape') {
      hide();
    }
  });

  list.addEventListener('mousedown', (event) => {
    const item = event.target.closest('.autocomplete-item');
    if (!item) return;
    event.preventDefault();
    const index = Number(item.dataset.index);
    if (matches[index]) select(matches[index]);
  });

  document.addEventListener('click', (event) => {
    if (event.target !== input && !list.contains(event.target)) hide();
  });
}

setupCityAutocomplete('hotelLocation', 'hotelLocationList');
setupCityAutocomplete('airbnbLocation', 'airbnbLocationList');
setupAirportAutocomplete('flightFrom', 'flightFromList');
setupAirportAutocomplete('flightTo', 'flightToList');

document.querySelectorAll('.tab-button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab-button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    button.classList.add('active');
    document.getElementById(`panel-${button.dataset.tab}`).classList.add('active');
  });
});

document.getElementById('hotelSearchButton').addEventListener('click', searchHotels);
document.getElementById('airbnbSearchButton').addEventListener('click', searchAirbnb);
document.getElementById('flightSearchButton').addEventListener('click', searchFlights);
document.getElementById('chatSendButton').addEventListener('click', sendChatMessage);
document.getElementById('chatInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendChatMessage();
});

function setStatus(elementId, text, isError = false) {
  const el = document.getElementById(elementId);
  el.textContent = text;
  el.className = 'status-message' + (isError ? ' error' : '');
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

async function searchHotels() {
  const location = document.getElementById('hotelLocation').value.trim();
  const checkIn = document.getElementById('hotelCheckIn').value;
  const checkOut = document.getElementById('hotelCheckOut').value;
  const adults = document.getElementById('hotelAdults').value;
  const resultsEl = document.getElementById('hotelResults');
  resultsEl.innerHTML = '';

  if (!location || !checkIn || !checkOut) {
    return setStatus('hotelStatus', 'Please fill in destination, check-in, and check-out.', true);
  }

  setStatus('hotelStatus', 'Searching live hotel listings...');

  try {
    const url = `${API_BASE}/hotels?location=${encodeURIComponent(location)}&checkIn=${checkIn}&checkOut=${checkOut}&adults=${encodeURIComponent(adults)}`;
    const data = await fetchJson(url);

    if (!data.results || data.results.length === 0) {
      return setStatus('hotelStatus', 'No hotels found for those dates.');
    }

    setStatus('hotelStatus', `Found ${data.results.length} hotels.`);
    resultsEl.innerHTML = data.results.map((hotel) => `
      <div class="card">
        <img src="${hotel.image || ''}" alt="${escapeHtml(hotel.name || '')}">
        <div class="card-body">
          <div class="card-title">${escapeHtml(hotel.name || 'Unnamed property')}</div>
          <div class="card-meta">${hotel.rating ? `⭐ ${hotel.rating} (${hotel.reviews || 0} reviews)` : 'No rating available'}</div>
          <div class="card-meta">${(hotel.amenities || []).slice(0, 3).join(', ')}</div>
          <div class="card-price">${hotel.pricePerNight || 'Price unavailable'} / night</div>
          ${hotel.link ? `<a class="card-link" href="${hotel.link}" target="_blank" rel="noopener noreferrer">View & Book</a>` : ''}
        </div>
      </div>
    `).join('');
    attachImageFallback(resultsEl);
  } catch (error) {
    setStatus('hotelStatus', error.message, true);
  }
}

async function searchAirbnb() {
  const location = document.getElementById('airbnbLocation').value.trim();
  const checkIn = document.getElementById('airbnbCheckIn').value;
  const checkOut = document.getElementById('airbnbCheckOut').value;
  const adults = document.getElementById('airbnbAdults').value;
  const resultsEl = document.getElementById('airbnbResults');
  resultsEl.innerHTML = '';

  if (!location || !checkIn || !checkOut) {
    return setStatus('airbnbStatus', 'Please fill in destination, check-in, and check-out.', true);
  }

  setStatus('airbnbStatus', 'Searching live Airbnb listings...');

  try {
    const url = `${API_BASE}/airbnb?location=${encodeURIComponent(location)}&checkIn=${checkIn}&checkOut=${checkOut}&adults=${encodeURIComponent(adults)}`;
    const data = await fetchJson(url);

    if (!data.results || data.results.length === 0) {
      return setStatus('airbnbStatus', 'No Airbnb listings found for those dates.');
    }

    setStatus('airbnbStatus', `Found ${data.results.length} listings.`);
    resultsEl.innerHTML = data.results.map((listing) => `
      <div class="card">
        <img src="${listing.image || ''}" alt="${escapeHtml(listing.title || '')}">
        <div class="card-body">
          <div class="card-title">${escapeHtml(listing.title || 'Unnamed listing')}</div>
          <div class="card-meta">${listing.rating ? `⭐ ${listing.rating} (${listing.reviews || 0} reviews)` : 'No rating available'}</div>
          <div>${(listing.badges || []).map((badge) => `<span class="badge">${escapeHtml(badge)}</span>`).join('')}</div>
          <div class="card-price">${listing.price || 'Price unavailable'}</div>
          ${listing.link ? `<a class="card-link" href="${listing.link}" target="_blank" rel="noopener noreferrer">View & Book</a>` : ''}
        </div>
      </div>
    `).join('');
    attachImageFallback(resultsEl);
  } catch (error) {
    setStatus('airbnbStatus', error.message, true);
  }
}

async function searchFlights() {
  const departureId = document.getElementById('flightFrom').value.trim().toUpperCase();
  const arrivalId = document.getElementById('flightTo').value.trim().toUpperCase();
  const outboundDate = document.getElementById('flightDepart').value;
  const returnDate = document.getElementById('flightReturn').value;
  const adults = document.getElementById('flightAdults').value;
  const resultsEl = document.getElementById('flightResults');
  resultsEl.innerHTML = '';

  if (!departureId || !arrivalId || !outboundDate) {
    return setStatus('flightStatus', 'Please fill in departure airport, arrival airport, and departure date.', true);
  }

  setStatus('flightStatus', 'Searching live flights...');

  try {
    let url = `${API_BASE}/flights?departureId=${encodeURIComponent(departureId)}&arrivalId=${encodeURIComponent(arrivalId)}&outboundDate=${outboundDate}&adults=${encodeURIComponent(adults)}`;
    if (returnDate) url += `&returnDate=${returnDate}`;
    const data = await fetchJson(url);

    if (!data.results || data.results.length === 0) {
      return setStatus('flightStatus', 'No flights found for those dates.');
    }

    const lowestPriceNote = data.lowestPrice ? ` Lowest price seen: $${data.lowestPrice}.` : '';
    setStatus('flightStatus', `Found ${data.results.length} flight options.${lowestPriceNote}`);

    resultsEl.innerHTML = data.results.map((flight) => {
      const durationHours = flight.totalDuration ? Math.floor(flight.totalDuration / 60) : null;
      const durationMinutes = flight.totalDuration ? flight.totalDuration % 60 : null;
      const durationText = durationHours !== null ? `${durationHours}h ${durationMinutes}m` : 'N/A';

      const segmentsHtml = flight.segments.map((segment) => `
        <div class="flight-segment">
          ${segment.airlineLogo ? `<img src="${segment.airlineLogo}" alt="">` : ''}
          ${escapeHtml(segment.airline || 'Unknown airline')} ${escapeHtml(segment.flightNumber || '')}<br>
          ${escapeHtml(segment.departureAirport || '')} ${escapeHtml(segment.departureTime || '')} &rarr; ${escapeHtml(segment.arrivalAirport || '')} ${escapeHtml(segment.arrivalTime || '')}
        </div>
      `).join('');

      return `
        <div class="card flight-card">
          <div class="card-body">
            <div class="card-title">${flight.stops === 0 ? 'Nonstop' : `${flight.stops} stop${flight.stops > 1 ? 's' : ''}`} &middot; ${durationText}</div>
            ${segmentsHtml}
            <div class="card-price">$${flight.price ?? 'unavailable'}</div>
            ${data.googleFlightsUrl ? `<a class="card-link" href="${data.googleFlightsUrl}" target="_blank" rel="noopener noreferrer">View & Book on Google Flights</a>` : ''}
          </div>
        </div>
      `;
    }).join('');
    attachImageFallback(resultsEl);
  } catch (error) {
    setStatus('flightStatus', error.message, true);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function attachImageFallback(containerEl) {
  containerEl.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true });
  });
}

const chatSessionId = "session_" + Math.random().toString(36).substring(2, 9);

function appendChatMessage(text, sender) {
  const chatMessages = document.getElementById('chatMessages');
  const messageDiv = document.createElement('div');
  messageDiv.className = `chat-message ${sender}`;
  messageDiv.textContent = text;
  chatMessages.appendChild(messageDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return messageDiv;
}

async function sendChatMessage() {
  const inputField = document.getElementById('chatInput');
  const messageText = inputField.value.trim();
  if (!messageText) return;

  inputField.value = '';
  appendChatMessage(messageText, 'user');
  const botMessageDiv = appendChatMessage('', 'bot');

  try {
    const response = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: messageText, sessionId: chatSessionId }),
    });

    if (!response.ok) throw new Error('Network error or server exception.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.replace('data: ', '').trim();
        if (dataStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.text) {
            botMessageDiv.textContent += parsed.text;
            const chatMessages = document.getElementById('chatMessages');
            chatMessages.scrollTop = chatMessages.scrollHeight;
          } else if (parsed.error) {
            botMessageDiv.textContent = parsed.error;
          }
        } catch {
          // ignore malformed chunk
        }
      }
    }
  } catch (error) {
    botMessageDiv.textContent = 'Error: Could not connect to the assistant.';
  }
}
