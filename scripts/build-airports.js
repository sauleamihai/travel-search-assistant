import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const inputPath = 'C:\\Users\\saule\\AppData\\Local\\Temp\\airports.dat';
const outputPath = path.join(__dirname, '..', 'public', 'airports.json');

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

// Airports missing from (or too new for) the OpenFlights snapshot, added by hand.
const MANUAL_ADDITIONS = [
  { code: 'GHV', name: 'Brașov-Ghimbav International Airport', city: 'Brasov', country: 'Romania' },
];

const raw = fs.readFileSync(inputPath, 'utf8');
const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

const seen = new Set();
const airports = [];

for (const line of lines) {
  const fields = parseCsvLine(line);
  const [, name, city, country, iata] = fields;

  if (!iata || iata === '\\N' || iata.length !== 3) continue;
  if (!city || city === '\\N') continue;

  const code = iata.toUpperCase();
  if (seen.has(code)) continue;
  seen.add(code);

  airports.push({ code, name, city, country });
}

for (const manual of MANUAL_ADDITIONS) {
  if (seen.has(manual.code)) continue;
  seen.add(manual.code);
  airports.push(manual);
}

airports.sort((a, b) => a.city.localeCompare(b.city));

fs.writeFileSync(outputPath, JSON.stringify(airports));
console.log(`Wrote ${airports.length} airports to ${outputPath}`);

const citySeen = new Set();
const cities = [];
for (const { city, country } of airports) {
  const key = `${city}|${country}`;
  if (citySeen.has(key)) continue;
  citySeen.add(key);
  cities.push({ city, country });
}
cities.sort((a, b) => a.city.localeCompare(b.city));

const citiesOutputPath = path.join(__dirname, '..', 'public', 'cities.json');
fs.writeFileSync(citiesOutputPath, JSON.stringify(cities));
console.log(`Wrote ${cities.length} cities to ${citiesOutputPath}`);
