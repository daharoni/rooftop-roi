# Launch licensing notes

Status 2026-10-03. This is a working summary, not legal advice; terms change, so re-read each linked page before launch. Items marked (unsure) are things I could not confirm from a primary source.

## Satellite imagery (the blocker)

The tile provider is one block at the top of `app/roof/roofBuilder.js` (`TILE_PROVIDERS`, `TILE_PROVIDER`). The default is still `esri`.

**Esri World Imagery (`server.arcgisonline.com`).** The service is governed by Esri's terms for ArcGIS Online / ArcGIS Location Platform content, which do not give a free, key-less licence for commercial or ad-supported apps. Using the raw tile URL without an account or API key in a public product is outside what I understand those terms to allow. Switch before any commercial launch. Terms: https://www.esri.com/en-us/legal/terms/full-master-agreement and https://developers.arcgis.com/documentation/mapping-apis-and-services/deployment/basemap-attribution/ . (unsure of the exact clause; confirm with Esri or counsel.)

**USGS The National Map imagery (`basemap.nationalmap.gov`).** US-government work, public domain; USGS asks for credit ("USGS The National Map") and that you not imply endorsement. Policy: https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits . Measured limits (2026-10-03, curl at lat 34.15 lon -118.76, plus LA and New York): z16 returns 200 (about 19-31 KB JPEG); z17, z18 and z19 all return 404. The service metadata lists levels to 23 but the cache stops at 16 (about 2.4 m per pixel), which is too coarse to trace a roof. It is licence-safe but not good enough on its own. USGS publishes higher-resolution NAIP and other orthoimagery through WMS/ImageServer endpoints that could be tiled client-side; not tested here.

**MapTiler (`api.maptiler.com`, `satellite-v2`).** Needs an API key (public in the browser; restrict it by origin in the MapTiler Cloud console). Checked 2026-10-03 at https://www.maptiler.com/cloud/pricing/ : the Free plan ($0, 5k map sessions and 100k API requests a month) is for "testing, PoC, prototyping, personal, or non-commercial use"; commercial use needs Flex ($30/month, 25k sessions and 500k requests, overage $0.15 per 1k requests) or a Custom contract. Free and Flex require the MapTiler logo on the map plus MapTiler and OpenStreetMap attribution. Terms: https://www.maptiler.com/terms/ . Native imagery zoom is about 20 in many urban areas (unsure for all areas); `maxNativeZoom` is set to 20.

**Mapbox satellite (not wired in).** Checked 2026-10-03 at https://www.mapbox.com/pricing : Raster Tiles API is free up to 750,000 tile requests a month, then $0.25 per 1,000; Static Tiles are free to 200,000 a month, then $0.50 per 1,000. Commercial web use is allowed under the account terms with the Mapbox logo and attribution and a public token; printed or video reuse of the imagery needs a separate agreement. https://www.mapbox.com/legal/tos

Whichever provider is chosen: add its host to `app/privacy.js` CALLS (`kind: "img"`) and to the CSP `img-src` in `index.html`; `tests/privacy-hosts.test.mjs` fails if the two disagree.

## Open-Meteo (`api.open-meteo.com`, `archive-api.open-meteo.com`, `geocoding-api.open-meteo.com`)

The free API is for non-commercial use only (checked 2026-10-03 at https://open-meteo.com/en/terms : the examples given are private websites without ads, home automation and education), with limits of 10,000 calls a day, 5,000 an hour and 600 a minute. Data is licensed CC BY 4.0, so the footer carries the attribution link. Commercial or ad-supported use needs a paid API subscription (Standard 1M calls a month, Professional 5M, Enterprise 50M+; prices are shown only at checkout: https://open-meteo.com/en/pricing ) or a self-hosted instance, since the code is open. The archive call is the heavy one: a new location now costs 3 multi-year requests (down from 11), cached afterwards in the browser.

## Nominatim (`nominatim.openstreetmap.org`)

The public instance is a shared volunteer service. Its usage policy: absolute maximum 1 request per second, a valid identifying User-Agent or Referer, no autocomplete-as-you-type, cache results, no bulk geocoding, and the right to block heavy users; results are ODbL, so show "Results (c) OpenStreetMap contributors". A browser cannot set User-Agent, so the Referer identifies the site. Policy: https://operations.osmfoundation.org/policies/nominatim/ . The app only calls on an explicit Find press, which fits, but a public product with ads is the kind of use they say may be refused; plan for a commercial geocoder (for example MapTiler Geocoding, Geoapify, or a Census geocoder for US addresses; unsure of fit) or a self-hosted Nominatim.

## Geocoding via Open-Meteo place search

Same Open-Meteo terms as above (the geocoding API is part of the same free, non-commercial tier).

## Self-hosted assets

Chart.js (MIT), Leaflet (BSD-2) and IBM Plex (OFL 1.1) are vendored in `app/vendor/` with licences and hashes in `app/vendor/LICENSES.md`. MIT/BSD require the copyright notice to be kept with copies; the licence text sits in the file headers of the minified files for Chart.js and Leaflet.
