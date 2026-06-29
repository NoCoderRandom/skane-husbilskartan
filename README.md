# Skånes husbilskarta

Statisk GitHub Pages-app för husbilsplatser i Skåne.

Appen visar bekräftade ställplatser, campingar och gästhamnar tillsammans med
OpenStreetMap-kandidater. Kandidater ska inte läsas som garanterat tillåten
nattparkering förrän pris, regler och service är verifierade mot operatör,
kommun eller skyltning.

## Data

- `data/official-places.json` innehåller manuellt kontrollerade seed-källor.
- `data/operator-places.json` innehåller operatörs-/kommunverifierade kandidater.
- `data/place-images.json` innehåller kuraterade fria bilder med licensuppgifter.
- `data/osm-cache.json` är cache från Overpass/OpenStreetMap.
- `data/places.json` är den färdiga filen som sidan läser.
- `scripts/build-data.mjs` bygger om `places.json`.

## Bygga om data lokalt

```bash
npm run build:data
```

För att hämta ny OSM-data från Overpass:

```bash
FORCE_REFRESH_OSM=1 npm run build:data
```

På GitHub körs databyggaren vid deploy och på veckoschema.
