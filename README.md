# Where the rats are (and were)

Interactive map and analysis of every rat sighting reported to New York City's 311 line since 2010 — 289,292 reports — checked against 2.1 million health department rodent inspections. Includes an address lookup that reports what has happened within a short walk of any New York City address.

**Live site:** https://vitalcity-nyc.github.io/rat-map/

A Vital City data project.

## What's here

- `docs/` — the static site served by GitHub Pages (no build step; vanilla JS + MapLibre GL)
- `docs/data/` — aggregated JSON consumed by the site, produced by `scripts/aggregate.py`
- `scripts/fetch_311.sh` — downloads rat sightings from NYC Open Data (311 datasets `76ig-c548` and `erm2-nwe9`, filtered to complaint type "Rodent," descriptor "Rat Sighting")
- `scripts/fetch_inspections.sh` — downloads all initial rodent inspections from DOHMH dataset `p937-wjvj`
- `scripts/fetch_reference.sh` — downloads district and neighborhood boundaries plus 2020 census populations
- `scripts/aggregate.py` — produces every number on the site from the raw downloads; asserts row-count floors at each step and fails loudly on short or empty fetches
- `.github/workflows/weekly-update.yml` — refreshes the data every Monday morning and commits `docs/data` only when something changed

## How the weekly refresh stays correct

`aggregate.py` derives every reporting window from the data itself: the last complete month, the year-to-date comparison window, the year range, the rolling 12- and 36-month windows, and the wording of every date in the page copy (the HTML carries `{{TOKEN}}` placeholders that the page fills from `summary.json`). Nothing needs editing as time passes — when August completes, the year-to-date comparison becomes January–August on its own.

Raw downloads land in `data/` (git-ignored; ~250 MB).

## Reproducing

```bash
scripts/fetch_311.sh
scripts/fetch_inspections.sh
# boundaries + populations: see the source list in scripts/aggregate.py header
python3 scripts/aggregate.py   # requires shapely
```

## Sources

All accessed August 5, 2026, from [NYC Open Data](https://opendata.cityofnewyork.us/) except where noted:

- [311 Service Requests from 2010 to 2019](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-2019/76ig-c548) (140,816 rat sightings)
- [311 Service Requests from 2020 to Present](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2020-to-Present/erm2-nwe9) (148,476 rat sightings through Aug. 4, 2026)
- [DOHMH Rodent Inspection](https://data.cityofnewyork.us/Health/Rodent-Inspection/p937-wjvj) (2,118,653 initial inspections)
- [Community Districts](https://data.cityofnewyork.us/City-Government/Community-Districts/5crt-au7u) and [2020 NTAs](https://data.cityofnewyork.us/City-Government/2020-Neighborhood-Tabulation-Areas-NTAs-/9nt8-h7nd) (shoreline-clipped boundaries)
- [DCP 2020 decennial census tables](https://www.nyc.gov/content/planning/pages/resources/datasets/decennial-census) (populations by community district and NTA)

Full methodology, calculations and limitations are documented on the site itself under "How we did this."

Built with AI assistance (Claude). Verify numbers against the sources before republishing.
