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

function norm(value) {
  return String(value || "")
    .toLocaleLowerCase("sv-SE")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function priceKind(place) {
  const price = place.price || {};
  const text = norm(price.text);
  if (price.is_free === true || text.includes("gratis")) return "free";
  if (price.is_free === false || price.amount || text.includes("betald") || text.includes("kr/")) return "paid";
  return "unknown";
}

function isNaturePlace(place) {
  const tags = Array.isArray(place.tags) ? place.tags.map(norm) : [];
  if (tags.some((tag) => (
    tag.includes("natur")
    || tag.includes("sjo")
    || tag.includes("kust")
    || tag.includes("strand")
    || tag.includes("skog")
    || tag.includes("lantligt")
    || tag.includes("vatmark")
    || tag.includes("badplats")
    || tag.includes("vandringsled")
  ))) return true;
  const text = norm([place.name, place.category, place.notes].join(" "));
  return /\b(natur|naturnara|naturreservat|sjonara|kustnara|strandnara|skog|damm|vatmark|backlandskap|badplats|skaneleden|vandringsled|ronne a|hano bukten|hanobukten|vid sjon|vid havet|vid kusten|vid strand)\b/.test(text);
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
  if (!html.includes("Trafikverket")) errors.push("HTML saknar Trafikverket-attribution");

  const data = JSON.parse(dataText);
  const places = Array.isArray(data.places) ? data.places : [];
  const servicePoints = Array.isArray(data.servicePoints) ? data.servicePoints : [];
  const activePlaces = places.filter((place) => place.place_status?.value === "active");
  const imagePlaces = places.filter((place) => Array.isArray(place.images) && place.images.length);
  const restAreas = places.filter((place) => place.category === "rastplats");
  const freePlaces = activePlaces.filter((place) => priceKind(place) === "free");
  const freeNaturePlaces = freePlaces.filter(isNaturePlace);

  if (data.counts?.places !== places.length) errors.push("counts.places matchar inte faktisk platslista");
  if (data.counts?.confirmedActive !== activePlaces.length) {
    errors.push("counts.confirmedActive matchar inte faktisk platslista");
  }
  if (data.counts?.withImages !== imagePlaces.length) errors.push("counts.withImages matchar inte faktisk platslista");
  if (data.counts?.servicePoints !== servicePoints.length) {
    errors.push("counts.servicePoints matchar inte faktisk servicepunktlista");
  }
  if (data.counts?.trafikverketRestAreas !== restAreas.length) {
    errors.push("counts.trafikverketRestAreas matchar inte faktisk rastplatslista");
  }

  if (places.length < 150) errors.push(`för få platser i live-data: ${places.length}`);
  if (activePlaces.length < 130) errors.push(`för få aktiva platser i live-data: ${activePlaces.length}`);
  if (imagePlaces.length < 30) errors.push(`för få platser med bild i live-data: ${imagePlaces.length}`);
  if (servicePoints.length < 18) errors.push(`för få servicepunkter i live-data: ${servicePoints.length}`);
  if (restAreas.length < 23) errors.push(`för få Trafikverket-rastplatser i live-data: ${restAreas.length}`);
  if (freePlaces.length < 25) errors.push(`för få gratisplatser i live-data: ${freePlaces.length}`);
  if (freeNaturePlaces.length < 7) errors.push(`för få gratis naturnära platser i live-data: ${freeNaturePlaces.length}`);

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
    "trafikverket-rastplats-hallandsas",
    "trafikverket-rastplats-brosarps-backar",
    "trafikverket-rastplats-varhallarna",
    "trafikverket-rastplats-piraten",
    "trafikverket-rastplats-hasslebro",
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

  const hallandsas = requirePlace(places, "trafikverket-rastplats-hallandsas", errors);
  if (hallandsas) {
    if (hallandsas.category !== "rastplats") errors.push("Hallandsås ska vara kategori rastplats");
    if (priceKind(hallandsas) !== "free") errors.push("Hallandsås ska vara gratis enligt live-data");
    if (hallandsas.overnight_allowed?.value !== true) errors.push("Hallandsås ska tillåta max 24h/rast i live-data");
    if (hallandsas.facilities?.black_water_disposal?.value !== true) errors.push("Hallandsås ska ha latrintömning i live-data");
  }

  const brosarp = requirePlace(places, "trafikverket-rastplats-brosarps-backar", errors);
  if (brosarp) {
    if (!isNaturePlace(brosarp)) errors.push("Brösarps Backar ska räknas som naturnära");
    if (!Array.isArray(brosarp.tags) || !brosarp.tags.includes("Naturreservat")) {
      errors.push("Brösarps Backar saknar Naturreservat-taggen");
    }
  }

  for (const id of ["trafikverket-rastplats-varhallarna", "trafikverket-rastplats-piraten", "trafikverket-rastplats-hasslebro"]) {
    const place = requirePlace(places, id, errors);
    if (place && (place.category !== "rastplats" || priceKind(place) !== "free" || !isNaturePlace(place))) {
      errors.push(`${id} ska vara gratis naturnära rastplats`);
    }
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
