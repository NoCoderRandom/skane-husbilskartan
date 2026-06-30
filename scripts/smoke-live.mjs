const DEFAULT_PAGE_URL = "https://nocoderrandom.github.io/skane-husbilskartan/";
const DEFAULT_MAX_AGE_HOURS = 30;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 8000;

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const [key, inlineValue] = arg.slice(2).split("=", 2);
  const value = inlineValue ?? process.argv[index + 1];
  if (inlineValue === undefined) index += 1;
  args.set(key, value);
}

const pageUrl = new URL(args.get("url") || process.env.PAGE_URL || DEFAULT_PAGE_URL);
const maxAgeHours = Number(args.get("max-age-hours") || process.env.MAX_DATA_AGE_HOURS || DEFAULT_MAX_AGE_HOURS);
const retries = Number(args.get("retries") || process.env.SMOKE_RETRIES || DEFAULT_RETRIES);
const retryDelayMs = Number(args.get("retry-delay-ms") || process.env.SMOKE_RETRY_DELAY_MS || DEFAULT_RETRY_DELAY_MS);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "skane-husbilskartan-smoke/1.0"
    }
  });
  if (!response.ok) {
    throw new Error(`${url} svarade ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function requirePlace(places, id, errors) {
  const place = places.find((item) => item.id === id);
  if (!place) errors.push(`saknar plats ${id}`);
  return place;
}

async function runSmoke() {
  const errors = [];
  const dataUrl = new URL("data/places.json", pageUrl);
  dataUrl.searchParams.set("cb", String(Date.now()));

  const [html, dataText] = await Promise.all([
    fetchText(pageUrl),
    fetchText(dataUrl)
  ]);

  if (!html.includes("Skånes husbilskarta")) errors.push("HTML saknar sidtitel");
  if (!html.includes("data/places.json")) errors.push("HTML verkar inte läsa data/places.json");
  if (!html.includes("leaflet")) errors.push("HTML saknar Leaflet/kartkod");

  const data = JSON.parse(dataText);
  const places = Array.isArray(data.places) ? data.places : [];
  const servicePoints = Array.isArray(data.servicePoints) ? data.servicePoints : [];
  const activePlaces = places.filter((place) => place.place_status?.value === "active");
  const imagePlaces = places.filter((place) => Array.isArray(place.images) && place.images.length);

  if (data.counts?.places !== places.length) errors.push("counts.places matchar inte faktisk platslista");
  if (data.counts?.confirmedActive !== activePlaces.length) {
    errors.push("counts.confirmedActive matchar inte faktisk platslista");
  }
  if (data.counts?.withImages !== imagePlaces.length) errors.push("counts.withImages matchar inte faktisk platslista");
  if (data.counts?.servicePoints !== servicePoints.length) {
    errors.push("counts.servicePoints matchar inte faktisk servicepunktlista");
  }

  if (places.length < 125) errors.push(`för få platser i live-data: ${places.length}`);
  if (activePlaces.length < 105) errors.push(`för få aktiva platser i live-data: ${activePlaces.length}`);
  if (imagePlaces.length < 30) errors.push(`för få platser med bild i live-data: ${imagePlaces.length}`);
  if (servicePoints.length < 18) errors.push(`för få servicepunkter i live-data: ${servicePoints.length}`);

  const generatedAt = Date.parse(data.generatedAt || "");
  if (!Number.isFinite(generatedAt)) {
    errors.push("generatedAt saknas eller kan inte tolkas som datum");
  } else if (Number.isFinite(maxAgeHours) && maxAgeHours > 0) {
    const ageHours = (Date.now() - generatedAt) / 36e5;
    if (ageHours > maxAgeHours) {
      errors.push(`live-data är ${ageHours.toFixed(1)} timmar gammal, max är ${maxAgeHours}`);
    }
  }

  const requiredIds = [
    "hassleholm-asmoarp-natur",
    "hassleholm-skyrup-golf-hotell",
    "hassleholm-tostarps-camping",
    "hassleholm-vinslovs-camping",
    "hassleholm-vittsjo-camping",
    "hassleholm-fladergarden",
    "hassleholm-luhrsjobadens-camping",
    "hassleholm-tykarpsgrottan-camping",
    "klagshamn-hamn-closed",
    "trelleborg-skare-skansar"
  ];

  for (const id of requiredIds) requirePlace(places, id, errors);

  const hassleholmCount = places.filter((place) => place.municipality === "Hässleholm").length;
  if (hassleholmCount < 9) errors.push(`för få Hässleholm-platser: ${hassleholmCount}`);

  const asmoarp = requirePlace(places, "hassleholm-asmoarp-natur", errors);
  if (asmoarp && !/275.*320/.test(asmoarp.price?.text || "")) {
    errors.push("Asmoarp saknar verifierad pristext med 275/320 kr");
  }

  const tykarp = requirePlace(places, "hassleholm-tykarpsgrottan-camping", errors);
  if (tykarp && tykarp.facilities?.black_water_disposal?.value !== true) {
    errors.push("Tykarpsgrottan saknar latrintömning i live-data");
  }

  const klagshamn = requirePlace(places, "klagshamn-hamn-closed", errors);
  if (klagshamn && klagshamn.place_status?.value !== "closed") {
    errors.push("Klagshamns hamn ska vara markerad stängd");
  }

  if (errors.length) {
    throw new Error(errors.join("\n"));
  }

  return {
    dataUrl,
    places: places.length,
    active: activePlaces.length,
    images: imagePlaces.length
  };
}

let lastError;
let passed = false;
for (let attempt = 1; attempt <= retries; attempt += 1) {
  try {
    const result = await runSmoke();
    console.log(`Live-smoke OK: ${result.places} platser, ${result.active} aktiva, ${result.images} med bild.`);
    console.log(`Kontrollerad sida: ${pageUrl.href}`);
    console.log(`Kontrollerad data: ${result.dataUrl.href}`);
    passed = true;
    break;
  } catch (error) {
    lastError = error;
    if (attempt < retries) {
      console.warn(`Live-smoke försök ${attempt}/${retries} misslyckades, försöker igen...`);
      await sleep(retryDelayMs);
    }
  }
}

if (!passed) {
  console.error("Live-smoke fel:");
  console.error(lastError?.message || String(lastError));
  process.exitCode = 1;
}
