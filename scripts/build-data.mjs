import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const officialPath = resolve(root, "data", "official-places.json");
const operatorPath = resolve(root, "data", "operator-places.json");
const imagesPath = resolve(root, "data", "place-images.json");
const osmCachePath = resolve(root, "data", "osm-cache.json");
const outputPath = resolve(root, "data", "places.json");
const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter"
];
const USER_AGENT = "skane-husbilsplatser/0.1 (local GitHub Pages data builder)";
const SKANE_BBOX = "55.30,12.35,56.60,14.75";
const FORCE_REFRESH_OSM = process.env.FORCE_REFRESH_OSM === "1";
const CHECKED_AT = new Date().toISOString().slice(0, 10);

const SKANE_POLYGON = [
  [55.28, 12.72],
  [55.37, 12.70],
  [55.49, 12.82],
  [55.61, 12.92],
  [55.75, 12.83],
  [55.94, 12.70],
  [56.12, 12.56],
  [56.31, 12.44],
  [56.47, 12.72],
  [56.50, 13.12],
  [56.42, 13.62],
  [56.30, 14.24],
  [56.08, 14.56],
  [55.80, 14.46],
  [55.37, 14.26],
  [55.28, 13.40]
];

const MUNICIPALITY_CENTROIDS = [
  ["Bjuv", 56.08, 12.91],
  ["Bromölla", 56.08, 14.47],
  ["Burlöv", 55.64, 13.07],
  ["Båstad", 56.43, 12.85],
  ["Eslöv", 55.84, 13.30],
  ["Helsingborg", 56.05, 12.70],
  ["Hässleholm", 56.16, 13.77],
  ["Höganäs", 56.20, 12.56],
  ["Hörby", 55.85, 13.66],
  ["Höör", 55.93, 13.54],
  ["Klippan", 56.14, 13.13],
  ["Kristianstad", 56.03, 14.16],
  ["Kävlinge", 55.79, 13.11],
  ["Landskrona", 55.87, 12.83],
  ["Lomma", 55.67, 13.07],
  ["Lund", 55.70, 13.19],
  ["Malmö", 55.60, 13.00],
  ["Osby", 56.38, 13.99],
  ["Perstorp", 56.14, 13.39],
  ["Simrishamn", 55.56, 14.35],
  ["Sjöbo", 55.63, 13.70],
  ["Skurup", 55.48, 13.50],
  ["Staffanstorp", 55.64, 13.21],
  ["Svalöv", 55.91, 13.11],
  ["Svedala", 55.51, 13.24],
  ["Tomelilla", 55.54, 13.95],
  ["Trelleborg", 55.38, 13.16],
  ["Vellinge", 55.47, 13.02],
  ["Ystad", 55.43, 13.82],
  ["Åstorp", 56.14, 12.95],
  ["Ängelholm", 56.24, 12.86],
  ["Örkelljunga", 56.28, 13.28],
  ["Östra Göinge", 56.25, 14.07]
];

const SKANE_MUNICIPALITIES = new Set(MUNICIPALITY_CENTROIDS.map(([name]) => name));
const OUTSIDE_SKANE_HINTS = /\b(laholm|skummeslov[a-z]*|skummesloev[a-z]*|vallasen|våxtorp|vaxtorp|sölvesborg|solvesborg|olofström|olofstrom|markaryd|älmhult|almhult|alvesta|blekinge|halland|småland|smaland)\b/;
const MANUAL_SERVICE_POINTS = [
  {
    id: "kristianstad-ahus-servicebyggnad",
    name: "Servicebyggnad i Åhus",
    type: "sanitary_dump_station",
    coordinates: { lat: 55.931379, lng: 14.302794, status: "confirmed" },
    fee: "",
    access: "",
    status: { value: "confirmed", text: "Kommunal servicepunkt med toalett, färskvatten samt manuell tömning av latrin och gråvatten." },
    source: "https://www.kristianstad.se/trafikochresor/trafikochgator/parkering/husbil.4469.html"
  }
];

const OSM_REVIEW_OVERRIDES = new Map([
  ["node/12943570675", {
    name: "Råå/Västindiegatan - ej verifierad nattplats",
    place_status: { value: "day_parking", status: "unverified" },
    overnight_allowed: {
      value: null,
      status: "unclear",
      text: "OSM-punkt nära Råå men inte samma som Råå Hamns verifierade husbilsplats. Kontrollera skyltning."
    },
    notes: "Manuellt nedklassad OSM-kandidat efter jämförelse med Råå Hamns egen husbilsinformation."
  }],
  ["way/1290116551", {
    name: "Renhållningsverket Ystad - parkering",
    place_status: { value: "day_parking", status: "unverified" },
    overnight_allowed: {
      value: null,
      status: "unclear",
      text: "Kommunens parkeringskarta visar parkering, men inte bekräftad camping/ställplats."
    },
    notes: "Manuellt nedklassad OSM-kandidat eftersom kommunal källa verifierar parkering snarare än nattplats."
  }],
  ["node/11978439905", {
    municipality: "Klippan",
    place_status: { value: "candidate", status: "unverified" },
    overnight_allowed: {
      value: true,
      status: "unverified",
      text: "OSM och tredjepartskataloger anger ställplats, men ingen primär operator-/kommunkälla är verifierad."
    },
    notes: "Rödhakens Ställplats behålls som kandidat och visas inte i standardvyn. Kommun rättad från närmaste centroid till Klippan/Färingtofta."
  }],
  ["way/1199726148", {
    name: "Benestad/Tomelilla - ej verifierad nattplats",
    place_status: { value: "day_parking", status: "unverified" },
    overnight_allowed: {
      value: null,
      status: "unclear",
      text: "OSM anger övernattning, men kommunens öppna data pekar på annan husbilsparkering och säger att den inte är en ställplats."
    },
    price: {
      text: "OSM anger fee=no, men uppgiften är inte verifierad mot kommun eller operatör.",
      amount: null,
      currency: "SEK",
      period: "day",
      status: "unverified",
      is_free: null
    },
    notes: "Manuellt nedklassad OSM-kandidat efter jämförelse med Tomelilla kommuns öppna data."
  }]
]);

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function norm(value) {
  return String(value || "")
    .toLocaleLowerCase("sv-SE")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " och ")
    .replace(/[^a-z0-9åäö]+/g, " ")
    .trim();
}

function slug(value) {
  return norm(value)
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .replace(/\s+/g, "-")
    .replace(/^-|-$/g, "")
    || "plats";
}

function compactNorm(value) {
  return norm(value).replace(/\s+/g, "");
}

function parseNumber(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lngI] = polygon[i];
    const [latJ, lngJ] = polygon[j];
    const intersects = (lngI > point.lng) !== (lngJ > point.lng)
      && point.lat < ((latJ - latI) * (point.lng - lngI)) / (lngJ - lngI) + latI;
    if (intersects) inside = !inside;
  }
  return inside;
}

function roughlyInSkane(point) {
  if (!point) return false;
  if (point.lat < 55.25 || point.lat > 56.52 || point.lng < 12.40 || point.lng > 14.62) return false;
  return pointInPolygon(point, SKANE_POLYGON);
}

function nearestMunicipality(point) {
  if (!point) return "";
  return MUNICIPALITY_CENTROIDS
    .map(([name, lat, lng]) => ({ name, distance: distanceKm(point, { lat, lng }) }))
    .sort((a, b) => a.distance - b.distance)[0]?.name || "";
}

function cleanMunicipality(value, point) {
  const text = String(value || "")
    .replace(/\s+kommun$/i, "")
    .replace(/\s+stad$/i, "")
    .trim();
  if (SKANE_MUNICIPALITIES.has(text)) return text;
  return nearestMunicipality(point);
}

function boolField(value, status = "unverified") {
  if (value === undefined || value === null || value === "") return { value: null, status: "missing" };
  const text = norm(value);
  if (["yes", "ja", "true", "designated", "permissive"].includes(text)) return { value: true, status };
  if (["no", "nej", "false"].includes(text)) return { value: false, status };
  return { value: null, status: "unclear", text: String(value) };
}

function mergeField(base, override) {
  if (!override) return base;
  if (!base) return override;
  const merged = { ...base, ...override };
  if (!("text" in override) && "value" in override && override.value !== base.value) {
    delete merged.text;
  }
  if (!("text" in override) && override.status === "confirmed") {
    delete merged.text;
  }
  return merged;
}

function fieldValue(field) {
  return field && typeof field === "object" && "value" in field ? field.value : null;
}

function source(id, type, title, url, checkedAt) {
  return { id, type, title, url, checked_at: checkedAt };
}

function qualityFromStatus(place) {
  const placeStatus = place.place_status?.value;
  if (placeStatus === "closed" || placeStatus === "prohibited") return "blocked";
  if (placeStatus === "day_parking") return "high";
  const critical = [place.overnight_allowed, place.price, place.coordinates];
  if (critical.some((item) => item?.status === "unclear")) return "high";
  if (critical.some((item) => item?.status === "unverified" || item?.status === "missing")) return "medium";
  return "low";
}

function overpassQuery() {
  return `[out:json][timeout:120];
(
  nwr["tourism"="caravan_site"](${SKANE_BBOX});
  nwr["tourism"="camp_site"]["caravans"~"^(yes|designated|permissive)$"](${SKANE_BBOX});
  nwr["tourism"="camp_site"]["motorhome"~"^(yes|designated|permissive)$"](${SKANE_BBOX});
  nwr["amenity"="parking"]["caravan"~"^(yes|designated|permissive)$"](${SKANE_BBOX});
  nwr["amenity"="parking"]["motorhome"~"^(yes|designated|permissive)$"](${SKANE_BBOX});
  nwr["amenity"="sanitary_dump_station"](${SKANE_BBOX});
);
out center tags;`;
}

async function fetchOverpass() {
  if (!FORCE_REFRESH_OSM && existsSync(osmCachePath)) {
    console.log("Using cached OSM data. Set FORCE_REFRESH_OSM=1 to refresh from Overpass.");
    return JSON.parse(await readFile(osmCachePath, "utf8"));
  }

  const query = overpassQuery();
  const errors = [];
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 70000);
    try {
      const url = `${endpoint}?data=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 120)}`);
      return JSON.parse(text);
    } catch (error) {
      errors.push(`${endpoint}: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (existsSync(osmCachePath)) {
    console.warn(`Overpass misslyckades, använder cache. ${errors.join(" | ")}`);
    return JSON.parse(await readFile(osmCachePath, "utf8"));
  }
  throw new Error(`Kunde inte hämta OSM-data. ${errors.join(" | ")}`);
}

function elementPoint(element) {
  const lat = parseNumber(element.lat ?? element.center?.lat);
  const lng = parseNumber(element.lon ?? element.center?.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, status: "unverified" } : null;
}

function isVehicleRelevant(element) {
  const tags = element.tags || {};
  const point = elementPoint(element);
  const text = norm([
    tags.name,
    tags.operator,
    tags.website,
    tags.url,
    tags["addr:country"],
    tags["addr:city"]
  ].filter(Boolean).join(" "));
  if (!roughlyInSkane(point)) return false;
  if (norm(tags["addr:country"]) === "dk") return false;
  if (OUTSIDE_SKANE_HINTS.test(text)) return false;
  if (/copenhagen|kobenhavn|koebenhavn|dragor|dragør|dcu camping|greve marina|vallensbaek|vallensbæk|naerum|nærum|ishoj|ishøj|kastrup/.test(text)) return false;
  if (/\bno\b/i.test(String(tags.caravans || "")) || /\bno\b/i.test(String(tags.motorhome || ""))) return false;
  if (["no", "private"].includes(norm(tags.access))) return false;
  if (tags.amenity === "sanitary_dump_station") return false;
  if (tags.amenity === "parking" && /^(yes|designated|permissive)$/i.test(tags.caravan || tags.motorhome || "")) return true;
  if (tags.tourism === "caravan_site") return true;
  if (tags.tourism === "camp_site" && /^(yes|designated|permissive)$/i.test(tags.caravans || tags.motorhome || "")) {
    const name = norm(tags.name);
    if (/skaneleden|shelter|taltplats|lagerplats|vindskydd/.test(name) && norm(tags.caravans) !== "yes") return false;
    return true;
  }
  return false;
}

function categoryFromTags(tags) {
  if (tags.tourism === "caravan_site") return "ställplats";
  if (tags.tourism === "camp_site") return "camping";
  if (tags.amenity === "parking") return "parkering";
  return "kandidat";
}

function labelFromCategory(category) {
  if (category === "camping") return "Camping";
  if (category === "parkering") return "Husbilsparkering";
  if (category === "gästhamn") return "Gästhamn";
  return "Ställplats";
}

function placeNameFromTags(element, point) {
  const tags = element.tags || {};
  if (tags.name || tags.operator) {
    return { name: tags.name || tags.operator, name_status: "confirmed" };
  }

  const category = categoryFromTags(tags);
  const municipality = cleanMunicipality(tags["addr:municipality"] || tags["is_in:municipality"] || tags["addr:city"], point);
  const street = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ");
  if (street) {
    return { name: `${labelFromCategory(category)} ${street}`, name_status: "derived" };
  }
  if (tags["caravan_site:type"] === "farm_shop") {
    return { name: `Gårdsställplats i ${municipality || "Skåne"}`, name_status: "derived" };
  }
  return { name: `${labelFromCategory(category)} i ${municipality || "Skåne"}`, name_status: "derived" };
}

function overnightFromTags(tags) {
  const explicit = norm(tags["motorhome:overnight"] || tags["caravan:overnight"] || tags.overnight || "");
  if (["yes", "ja", "true", "designated", "permissive"].includes(explicit)) {
    return { value: true, status: "unverified", text: "OSM anger övernattning för husbil." };
  }
  if (["no", "nej", "false"].includes(explicit)) {
    return { value: false, status: "unverified", text: "OSM anger att övernattning inte gäller." };
  }
  if (tags.amenity === "parking") {
    const hours = String(tags.opening_hours || "");
    if (hours && !/24\/7/i.test(hours)) {
      return { value: false, status: "unverified", text: `OSM anger öppettid ${hours}, alltså inte tydlig nattplats.` };
    }
    return { value: null, status: "unclear", text: "Parkering för husbil i OSM, men nattparkering är inte bekräftad." };
  }
  if (tags.tourism === "caravan_site" || tags.tourism === "camp_site") {
    return { value: true, status: "unverified", text: "OSM klassar platsen som camping/ställplats." };
  }
  return { value: null, status: "missing" };
}

function placeFromOsm(element) {
  const tags = element.tags || {};
  const point = elementPoint(element);
  const { name, name_status } = placeNameFromTags(element, point);
  const id = `osm-${element.type}-${element.id}`;
  const feeText = tags.fee || tags.charge || "";
  const isFree = norm(feeText) === "no" ? true : norm(feeText) === "yes" || !!tags.charge ? false : null;
  const website = tags.website || tags.url || "";
  const overnight = overnightFromTags(tags);
  const placeStatus = overnight.value === false
    ? { value: "day_parking", status: "unverified" }
    : { value: "candidate", status: "unverified" };
  const facilities = {
    toilet: boolField(tags.toilets),
    shower: boolField(tags.shower),
    electricity: boolField(tags.power_supply || tags.electricity),
    fresh_water: boolField(tags.drinking_water || tags.water_point),
    black_water_disposal: boolField(tags.sanitary_dump_station || tags.chemical_toilet_disposal),
    grey_water_disposal: boolField(tags.grey_water_disposal || tags.wastewater_disposal),
    waste: boolField(tags.waste_disposal || tags.waste_basket)
  };
  const place = {
    id,
    name,
    name_status,
    municipality: cleanMunicipality(tags["addr:municipality"] || tags["is_in:municipality"] || tags["addr:city"], point),
    category: categoryFromTags(tags),
    coordinates: point,
    place_status: placeStatus,
    overnight_allowed: overnight,
    price: {
      text: feeText ? `OSM anger fee=${feeText}. Verifiera pris hos platsen.` : "Pris saknas i OSM.",
      amount: null,
      currency: "SEK",
      period: "night",
      status: feeText ? "unverified" : "missing",
      is_free: isFree
    },
    facilities,
    notes: overnight.value === false
      ? "OSM-kandidat som inte ska räknas som säker nattplats utan ny kontroll av skyltning och lokal källa."
      : "Kandidat från OpenStreetMap. Pris, regler och övernattning måste verifieras mot officiell källa eller skyltning.",
    sources: [
      source(`osm-${element.type}-${element.id}`, "open-data", `OpenStreetMap ${element.type}/${element.id}`, `https://www.openstreetmap.org/${element.type}/${element.id}`, CHECKED_AT),
      ...(website ? [source(`osm-website-${element.type}-${element.id}`, "osm-website", "Webbplats från OSM", website, CHECKED_AT)] : [])
    ],
    osm: { type: element.type, id: element.id, tags },
    images: []
  };
  const reviewOverride = OSM_REVIEW_OVERRIDES.get(`${element.type}/${element.id}`);
  return reviewOverride ? { ...place, ...reviewOverride } : place;
}

function servicePointFromOsm(element) {
  const tags = element.tags || {};
  const point = elementPoint(element);
  if (!point || !roughlyInSkane(point)) return null;
  const access = tags.access || "";
  const fee = tags.fee || tags.charge || "";
  const restricted = ["customers", "permit", "private", "no"].includes(norm(access));
  return {
    id: `osm-service-${element.type}-${element.id}`,
    name: tags.name || "Tömningsstation",
    type: "sanitary_dump_station",
    coordinates: point,
    fee,
    access,
    status: {
      value: restricted ? "restricted" : "unverified",
      text: restricted
        ? "OSM anger begränsad åtkomst. Kontrollera med platsen innan du planerar tömning här."
        : "Servicepunkt från OSM. Ej manuellt verifierad."
    },
    source: `https://www.openstreetmap.org/${element.type}/${element.id}`
  };
}

function dedupeServicePoints(points) {
  const out = [];
  for (const point of points) {
    if (!point?.coordinates) continue;
    const duplicate = out.some((existing) => distanceKm(existing.coordinates, point.coordinates) < 0.05);
    if (!duplicate) out.push(point);
  }
  return out;
}

function scoreMatch(seed, place) {
  const names = [seed.name, ...toArray(seed.match)].map(norm).filter(Boolean);
  const target = norm(place.name);
  if (!target || !names.length) return 0;
  if (names.some((name) => target === name)) return 100;
  if (seed.coordinates && place.coordinates) {
    const km = distanceKm(seed.coordinates, place.coordinates);
    if (km <= 0.12) return 95;
  }
  if (names.some((name) => target.includes(name) || name.includes(target))) return 80;
  return 0;
}

function mergePlaces(osmPlace, seed) {
  const base = osmPlace || {};
  const sourcesById = new Map([...toArray(base.sources), ...toArray(seed.sources)].map((item) => [item.id || item.url, item]));
  const seedHasVerifiedSource = toArray(seed.sources).some((item) => (
    item.type === "official" || item.type === "official-tourism" || item.type === "operator"
  ));
  const facilities = { ...(base.facilities || {}) };
  Object.entries(seed.facilities || {}).forEach(([key, value]) => {
    facilities[key] = mergeField(facilities[key], value);
  });
  const merged = {
    ...base,
    ...seed,
    id: seed.id || base.id,
    name: seed.name || base.name,
    name_status: seed.name_status || (seed.name ? "confirmed" : base.name_status),
    municipality: seed.municipality || base.municipality || "",
    category: seed.category || base.category || "ställplats",
    coordinates: seed.coordinates?.lat && seed.coordinates?.lng ? seed.coordinates : base.coordinates || seed.coordinates,
    place_status: mergeField(base.place_status, seed.place_status),
    overnight_allowed: mergeField(base.overnight_allowed, seed.overnight_allowed),
    price: mergeField(base.price, seed.price),
    facilities,
    sources: [...sourcesById.values()],
    notes: seed.notes ?? (seedHasVerifiedSource ? null : base.notes),
    images: toArray(seed.images).length ? seed.images : toArray(base.images),
    osm: base.osm || null
  };
  merged.last_checked = toArray(merged.sources).map((item) => item.checked_at).filter(Boolean).sort().at(-1) || new Date().toISOString().slice(0, 10);
  merged.quality = {
    risk_level: qualityFromStatus(merged),
    review_needed: qualityFromStatus(merged) !== "low"
  };
  return merged;
}

function sourceStrength(place) {
  const statusWeight = {
    active: 40,
    closed: 40,
    prohibited: 40,
    day_parking: 30,
    candidate: 10
  }[place.place_status?.value] ?? 0;
  const sourceWeight = toArray(place.sources).reduce((score, item) => {
    if (item.type === "official") return Math.max(score, 40);
    if (item.type === "official-tourism") return Math.max(score, 35);
    if (item.type === "operator") return Math.max(score, 30);
    return score;
  }, 0);
  return statusWeight + sourceWeight;
}

function mergeDuplicatePlaces(existing, incoming) {
  return sourceStrength(existing) >= sourceStrength(incoming)
    ? mergePlaces(incoming, existing)
    : mergePlaces(existing, incoming);
}

function dedupePlaces(places) {
  const merged = [];
  for (const place of places) {
    const placeName = norm(place.name);
    const placeNameCompact = compactNorm(place.name);
    const existingIndex = merged.findIndex((candidate) => {
      if (!candidate.coordinates || !place.coordinates) return false;
      const candidateName = norm(candidate.name);
      const candidateNameCompact = compactNorm(candidate.name);
      const close = distanceKm(candidate.coordinates, place.coordinates) < 0.45;
      const sameName = candidateName && placeName && (
        candidateName === placeName
        || candidateName.includes(placeName)
        || placeName.includes(candidateName)
        || candidateNameCompact === placeNameCompact
      );
      return close && sameName;
    });
    if (existingIndex >= 0) {
      merged[existingIndex] = mergeDuplicatePlaces(merged[existingIndex], place);
    } else {
      merged.push(place);
    }
  }
  return merged;
}

async function main() {
  const official = JSON.parse(await readFile(officialPath, "utf8"));
  const operator = existsSync(operatorPath)
    ? JSON.parse(await readFile(operatorPath, "utf8"))
    : { places: [] };
  const manualPlaces = [...toArray(official.places), ...toArray(operator.places)];
  const imageData = existsSync(imagesPath)
    ? JSON.parse(await readFile(imagesPath, "utf8"))
    : { places: [] };
  const imagesByPlaceId = new Map(toArray(imageData.places).map((item) => [item.id, toArray(item.images)]));
  const osmData = await fetchOverpass();
  await mkdir(dirname(osmCachePath), { recursive: true });
  await writeFile(osmCachePath, `${JSON.stringify(osmData)}\n`, "utf8");

  const elements = toArray(osmData.elements);
  const osmPlaces = elements.filter(isVehicleRelevant).map(placeFromOsm).filter((place) => place.coordinates);
  const servicePoints = elements
    .filter((element) => element.tags?.amenity === "sanitary_dump_station")
    .map(servicePointFromOsm)
    .filter(Boolean);

  const usedOsmIds = new Set();
  const mergedOfficial = manualPlaces.map((seed) => {
    const match = osmPlaces
      .filter((place) => !usedOsmIds.has(place.id))
      .map((place) => ({ place, score: scoreMatch(seed, place) }))
      .filter((item) => item.score >= 80)
      .sort((a, b) => b.score - a.score)[0]?.place || null;
    if (match) usedOsmIds.add(match.id);
    return mergePlaces(match, seed);
  });
  const remainingOsm = osmPlaces.filter((place) => !usedOsmIds.has(place.id)).map((place) => {
    place.last_checked = CHECKED_AT;
    place.quality = { risk_level: "medium", review_needed: true };
    return place;
  });
  const places = dedupePlaces([...mergedOfficial, ...remainingOsm])
    .filter((place) => place.coordinates && Number.isFinite(place.coordinates.lat) && Number.isFinite(place.coordinates.lng))
    .map((place) => imagesByPlaceId.has(place.id) ? { ...place, images: imagesByPlaceId.get(place.id) } : place)
    .sort((a, b) => {
      const statusOrder = { active: 0, candidate: 1, closed: 2, prohibited: 3 };
      return (statusOrder[a.place_status?.value] ?? 9) - (statusOrder[b.place_status?.value] ?? 9)
        || String(a.municipality).localeCompare(String(b.municipality), "sv-SE")
        || String(a.name).localeCompare(String(b.name), "sv-SE");
    });

  const allServicePoints = dedupeServicePoints([...MANUAL_SERVICE_POINTS, ...servicePoints]);

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: "Officiella seed-källor + OpenStreetMap-kandidater via Overpass",
    attribution: "OpenStreetMap contributors, ODbL. OSM-data används som kandidater och serviceunderlag.",
    warning: "Kandidatplatser från OpenStreetMap är inte automatiskt verifierade som tillåtna nattplatser. Kontrollera alltid skyltning och länkad källa.",
    counts: {
      places: places.length,
      officialSeeds: toArray(official.places).length,
      operatorSeeds: toArray(operator.places).length,
      manualSeeds: manualPlaces.length,
      osmCandidatesRaw: remainingOsm.length,
      finalCandidates: places.filter((place) => place.place_status?.value === "candidate").length,
      confirmedActive: places.filter((place) => place.place_status?.value === "active").length,
      withImages: places.filter((place) => toArray(place.images).length).length,
      servicePoints: allServicePoints.length
    },
    places,
    servicePoints: allServicePoints
  };

  await writeFile(outputPath, `${JSON.stringify(payload)}\n`, "utf8");
  console.log(`Wrote ${places.length} places and ${allServicePoints.length} service points to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
