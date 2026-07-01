import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataPath = resolve(root, "data", "places.json");
const imagesPath = resolve(root, "data", "place-images.json");
const data = JSON.parse(await readFile(dataPath, "utf8"));
const imageData = JSON.parse(await readFile(imagesPath, "utf8"));
const places = Array.isArray(data.places) ? data.places : [];
const servicePoints = Array.isArray(data.servicePoints) ? data.servicePoints : [];
const curatedImagePlaces = Array.isArray(imageData.places) ? imageData.places : [];
const errors = [];
const warnings = [];

const VALID_PLACE_STATUSES = new Set(["active", "candidate", "day_parking", "closed", "prohibited"]);
const SKANE_BOUNDS = { minLat: 55.25, maxLat: 56.55, minLng: 12.35, maxLng: 14.75 };

function norm(value) {
  return String(value || "")
    .toLocaleLowerCase("sv-SE")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9åäö]+/g, " ")
    .trim();
}

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function pointInBounds(point) {
  return point
    && Number.isFinite(point.lat)
    && Number.isFinite(point.lng)
    && point.lat >= SKANE_BOUNDS.minLat
    && point.lat <= SKANE_BOUNDS.maxLat
    && point.lng >= SKANE_BOUNDS.minLng
    && point.lng <= SKANE_BOUNDS.maxLng;
}

function priceTextSignalsPaid(text) {
  const value = norm(text);
  return /\b(kr|sek|betald|betalning|avgift)\b/.test(value);
}

function priceTextSignalsFree(text) {
  const value = norm(text);
  return /\b(gratis|avgiftsfri|kostnadsfri|fee no|utan avgift)\b/.test(value);
}

function isFreePlace(place) {
  return place.price?.is_free === true || priceTextSignalsFree(place.price?.text || "");
}

function placeTags(place) {
  return Array.isArray(place.tags) ? place.tags.map(String) : [];
}

function isNaturePlace(place) {
  const tags = placeTags(place).map(norm);
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

const seenIds = new Set();
const placeIds = new Set();
for (const place of places) {
  if (!place.id) fail(`Plats saknar id: ${place.name || "namnlös"}`);
  if (seenIds.has(place.id)) fail(`Duplicerat plats-id: ${place.id}`);
  seenIds.add(place.id);
  placeIds.add(place.id);

  const status = place.place_status?.value;
  if (!VALID_PLACE_STATUSES.has(status)) fail(`${place.id}: ogiltig status ${status || "(saknas)"}`);
  if (!place.name) fail(`${place.id}: saknar namn`);
  if (!place.municipality) fail(`${place.id}: saknar kommun`);
  if (!pointInBounds(place.coordinates)) fail(`${place.id}: koordinat saknas eller ligger utanför Skåne-rutan`);

  if (status === "active" && place.overnight_allowed?.value !== true) {
    fail(`${place.id}: aktiv plats utan bekräftad/tillåten övernattning`);
  }
  if ((status === "closed" || status === "prohibited") && place.overnight_allowed?.value !== false) {
    fail(`${place.id}: stängd/förbjuden plats bör ha overnight_allowed=false`);
  }

  const hasPrimarySource = (place.sources || []).some((source) => (
    ["official", "official-tourism", "operator"].includes(source.type)
  ));
  if (status === "active" && !hasPrimarySource) {
    fail(`${place.id}: aktiv plats saknar primär källa från kommun, turism eller operatör`);
  }

  const price = place.price || {};
  const amount = Number(price.amount);
  const text = price.text || "";
  if (price.is_free === true && (amount > 0 || priceTextSignalsPaid(text))) {
    fail(`${place.id}: pris är markerat gratis men text/belopp signalerar betalning`);
  }
  if (price.is_free === false && priceTextSignalsFree(text)) {
    fail(`${place.id}: pris är markerat betalt men texten signalerar gratis`);
  }
  if (amount > 0 && price.is_free !== false) {
    fail(`${place.id}: positivt prisbelopp saknar is_free=false`);
  }
  if (status === "active" && price.status === "missing") {
    warn(`${place.id}: aktiv plats saknar verifierat pris`);
  }
}

const seenImageIds = new Set();
for (const imagePlace of curatedImagePlaces) {
  if (!imagePlace.id) fail("Bildpost saknar plats-id");
  if (seenImageIds.has(imagePlace.id)) fail(`Duplicerad bildpost för plats-id: ${imagePlace.id}`);
  seenImageIds.add(imagePlace.id);
  if (!placeIds.has(imagePlace.id)) fail(`Bildpost pekar på okänd plats: ${imagePlace.id}`);
  const images = Array.isArray(imagePlace.images) ? imagePlace.images : [];
  if (!images.length) warn(`${imagePlace.id}: bildpost saknar bilder`);
  for (const image of images) {
    if (!image.url || !image.url.startsWith("https://upload.wikimedia.org/")) {
      fail(`${imagePlace.id}: bild saknar Wikimedia upload-url`);
    }
    if (!image.source_url || !image.source_url.startsWith("https://commons.wikimedia.org/wiki/File:")) {
      fail(`${imagePlace.id}: bild saknar Commons-källa`);
    }
    if (!image.author || !image.license || !image.license_url) {
      fail(`${imagePlace.id}: bild saknar upphov, licens eller licens-url`);
    }
    if (image.status !== "free-license") fail(`${imagePlace.id}: bildstatus är inte free-license`);
  }
}

if (data.counts?.places !== places.length) fail(`counts.places=${data.counts?.places}, men faktisk längd är ${places.length}`);
if (data.counts?.servicePoints !== servicePoints.length) {
  fail(`counts.servicePoints=${data.counts?.servicePoints}, men faktisk längd är ${servicePoints.length}`);
}
if (data.counts?.confirmedActive !== places.filter((place) => place.place_status?.value === "active").length) {
  fail("counts.confirmedActive matchar inte aktuell data");
}
if (data.counts?.finalCandidates !== places.filter((place) => place.place_status?.value === "candidate").length) {
  fail("counts.finalCandidates matchar inte aktuell data");
}
if (data.counts?.withImages !== places.filter((place) => Array.isArray(place.images) && place.images.length).length) {
  fail("counts.withImages matchar inte aktuell data");
}

const activePlaces = places.filter((place) => place.place_status?.value === "active");
const freeNaturePlaces = activePlaces.filter((place) => isFreePlace(place) && isNaturePlace(place));
if (freeNaturePlaces.length < 7) {
  fail(`för få aktiva gratisplatser i natur: ${freeNaturePlaces.length}`);
}

for (const id of [
  "trafikverket-rastplats-hallandsas",
  "hassleholm-kvarnbacken",
  "trafikverket-rastplats-hasslebro",
  "osby-spegeldammen",
  "trafikverket-rastplats-brosarps-backar",
  "trafikverket-rastplats-varhallarna"
]) {
  const place = places.find((item) => item.id === id);
  if (!place) fail(`${id}: gratis/naturplats saknas`);
  if (place && !isFreePlace(place)) fail(`${id}: ska vara gratis enligt data`);
  if (place && !isNaturePlace(place)) fail(`${id}: ska räknas som naturnära`);
  if (place && (!Array.isArray(place.images) || !place.images.length)) fail(`${id}: saknar verifierad fri bild`);
}

for (const point of servicePoints) {
  if (!point.id) fail(`Servicepunkt saknar id: ${point.name || "namnlös"}`);
  if (!pointInBounds(point.coordinates)) fail(`${point.id}: servicepunkt saknar koordinat eller ligger utanför Skåne-rutan`);
}

if (warnings.length) {
  console.warn(`Data-audit varningar (${warnings.length}):`);
  warnings.forEach((message) => console.warn(`- ${message}`));
}

if (errors.length) {
  console.error(`Data-audit fel (${errors.length}):`);
  errors.forEach((message) => console.error(`- ${message}`));
  process.exit(1);
}

console.log(`Data-audit OK: ${places.length} platser, ${servicePoints.length} servicepunkter.`);
