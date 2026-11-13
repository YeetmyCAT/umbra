# Umbra: satellite planetarium

A static web app (no build step) for iPhone and desktop. It shows every tracked object in Earth orbit that has public orbital elements, with realistic brightness, and keeps the sky from SkyScout without its weather, airglow or light pollution.

## Run locally
`node tools/serve.cjs 8134`, then open http://localhost:8134 (the `umbra` entry in `D:\Claude\.claude\launch.json`).

## Data
- `tools/buildcatalog.cjs` merges CelesTrak OMM element sets with SATCAT facts and McCants' quicksat standard magnitudes and sizes into `data/catalog.json`. CelesTrak has no "everything" feed without a login, so it combines the union of several name queries. Responses are cached in `tools/cache` because CelesTrak answers each query once per 2 hours.
- TLE text is never used: OMM keeps full catalogue numbers (100,000+) and 4-digit years.
- The `.github/workflows/catalog.yml` workflow rebuilds the catalogue every 2 hours and redeploys GitHub Pages. Selecting an object also asks CelesTrak for its newest elements.
- Stars: `stars.json` and `stars8.bin` come from SkyScout. `gaia1.bin` and `gaia2.bin` hold Gaia DR3 stars from V 8 to 10.5, built by `tools/prepgaia.cjs`.
- Earth: NASA Blue Marble, city lights extracted from Black Marble, a cloud snapshot and a water mask (from Bolide).

## Physics
- `js/light.js` covers sunlight on each object: penumbra plus reddened, ozone-tinted grazing light; earthshine; and facet photometry (diffuse plus specular lobes, Sun-tracking panels, attitude laws).
- `js/shapes.js` holds one description per spacecraft type, used both for the 3D model (`js/models3d.js`) and for the facets that make flares.
- `js/worker.js` runs SGP4/SDP4 for the whole catalogue, pass predictions, the flare and GEO-glint search, and Sun/Moon transits.
- `js/tracker.js` moves every object each frame with two-body motion between exact SGP4 updates.

## Tests
`node tests/calib.js` and `node tests/iss.js` print the photometry calibration.
