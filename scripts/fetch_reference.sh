#!/bin/bash
# Title: Fetch boundaries and populations for "Where the rats are"
# Sources: NYC Open Data 5crt-au7u (Community Districts, shoreline-clipped),
#          NYC Open Data 9nt8-h7nd (2020 Neighborhood Tabulation Areas, shoreline-clipped),
#          NYC DCP nyc_decennialcensusdata_2010_2020_change.xlsx (2020 census populations).
# These change rarely, but the weekly job refetches so the build never depends on
# files that happen to be sitting on one machine.
# Fails loud: any missing or short file aborts.
set -euo pipefail
cd "$(dirname "$0")/../data" 2>/dev/null || { mkdir -p "$(dirname "$0")/../data"; cd "$(dirname "$0")/../data"; }

UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36"

fetch_geo() {
  local id=$1 out=$2 min_features=$3
  curl -sfL --retry 3 --retry-delay 5 \
    "https://data.cityofnewyork.us/api/geospatial/${id}?method=export&format=GeoJSON" -o "$out"
  local n
  n=$(python3 -c "import json;print(len(json.load(open('$out'))['features']))")
  echo "$out: $n features"
  if [ "$n" -lt "$min_features" ]; then
    echo "FATAL: $out has $n features, expected at least $min_features." >&2
    exit 1
  fi
}

fetch_geo 5crt-au7u cd_boundaries.geojson 59
fetch_geo 9nt8-h7nd nta2020.geojson 250

curl -sfL --retry 3 --retry-delay 5 -A "$UA" \
  "https://www.nyc.gov/assets/planning/download/office/planning-level/nyc-population/census2020/nyc_decennialcensusdata_2010_2020_change.xlsx" \
  -o census2020.xlsx
echo "census2020.xlsx: $(wc -c < census2020.xlsx) bytes"

# Extract 2020 populations for community districts and 2020 NTAs.
python3 - <<'PY'
import json, openpyxl
wb = openpyxl.load_workbook('census2020.xlsx', read_only=True)
ws = wb['2010, 2020, and Change']
rows = list(ws.iter_rows(values_only=True))
hdr = [str(x) for x in rows[3]]
gi, bi, gid, ni, pi = (hdr.index(c) for c in ('GeoType', 'Borough', 'GeoID', 'Name', 'Pop_20'))
cd, nta = {}, {}
for r in rows[4:]:
    if r[gi] == 'CD':
        cd[str(r[gid])] = {'name': r[ni], 'borough': r[bi], 'pop2020': r[pi]}
    elif r[gi] == 'NTA2020':
        nta[str(r[gid])] = {'name': r[ni], 'pop2020': r[pi]}
assert len(cd) >= 59 and len(nta) >= 250, f'unexpected geography counts: {len(cd)} CDs, {len(nta)} NTAs'
json.dump({'cd': cd, 'nta': nta}, open('populations.json', 'w'))
print(f'populations.json: {len(cd)} community districts, {len(nta)} neighborhoods')
PY
echo DONE
