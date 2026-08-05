#!/usr/bin/env python3
# Title: Aggregate NYC rat data for "Where the rats are"
# Author: Generated with Claude Code for Josh Greenman / Vital City
# Data sources (see README for URLs; access date is recorded in summary.json at run time):
#   - NYC Open Data 76ig-c548: 311 Service Requests 2010-2019 (Rodent / Rat Sighting)
#   - NYC Open Data erm2-nwe9: 311 Service Requests 2020-present (Rodent / Rat Sighting)
#   - NYC Open Data p937-wjvj: DOHMH Rodent Inspection, inspection_type='Initial'
#   - NYC Open Data 5crt-au7u: Community Districts (shoreline-clipped)
#   - NYC Open Data 9nt8-h7nd: 2020 Neighborhood Tabulation Areas (shoreline-clipped)
#   - DCP nyc_decennialcensusdata_2010_2020_change.xlsx: 2020 census populations by CD and NTA2020
# Description: Produces every JSON the static site consumes. Every derived number on the
#   site traces to a calculation in this file.
# Dependencies: Python 3.9+, shapely (spatial joins), stdlib csv/json.
# Date handling: ALL reporting windows (last complete month, year-to-date comparison
#   window, year range, rolling windows) are derived from the data itself, so the weekly
#   refresh stays correct without edits.
# Fail-loud: floors on row counts and output sizes; a short or empty fetch aborts.

import csv, json, math, os
from collections import defaultdict, Counter
from datetime import date, timedelta

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, 'data')
OUT = os.path.join(BASE, 'docs', 'data')
os.makedirs(OUT, exist_ok=True)

# fail-loud floors: known-good counts as of the Aug. 5, 2026 build. Counts only grow.
MIN_SIGHTINGS = 285000
MIN_INSPECTIONS = 2000000

LAT_STEP, LON_STEP = 0.002, 0.0026        # map grid cells, ~220m per side at NYC latitude
RLAT, RLON = 0.00025, 0.00033             # address-lookup cells, ~28m per side
RLAT0, RLON0 = 40.47, -74.28              # address-lookup origin

BORO_NUM = {'MANHATTAN': 1, 'BRONX': 2, 'BROOKLYN': 3, 'QUEENS': 4, 'STATEN ISLAND': 5}
MON_ABBR = ['Jan.', 'Feb.', 'March', 'April', 'May', 'June', 'July',
            'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.']

def parse_cb(cb):
    """'01 BRONX' -> 201. Returns None for Unspecified/invalid."""
    if not cb:
        return None
    cb_up = cb.strip().upper()
    for name, num in BORO_NUM.items():
        if cb_up.endswith(name):
            head = cb_up[: -len(name)].strip()
            if head.isdigit() and 1 <= int(head) <= 99:
                return num * 100 + int(head)
    return None

def month_add(ym, n):
    y, m = int(ym[:4]), int(ym[5:7])
    t = (y * 12 + m - 1) + n
    return f'{t // 12:04d}-{t % 12 + 1:02d}'

# ---------------------------------------------------------------- load 311
rows = []
file_counts = {}
for f in ('rat_311_2010_2019.csv', 'rat_311_2020_present.csv'):
    with open(os.path.join(DATA, f), newline='') as fh:
        r = list(csv.DictReader(fh))
        print(f, len(r))
        if len(r) < 100000:
            raise SystemExit(f'FATAL: {f} has only {len(r)} rows; refusing to build.')
        file_counts[f.replace('rat_311_', '').replace('.csv', '')] = len(r)
        rows.extend(r)
if len(rows) < MIN_SIGHTINGS:
    raise SystemExit(f'FATAL: {len(rows)} sightings total, below floor {MIN_SIGHTINGS}.')

# ------------------------------------------------- derive reporting windows from data
max_date = max(r['created_date'] for r in rows)          # local ET per 311 convention
LAST_DATA_DAY = max_date[0:10]
# the month containing the latest record is partial, so monthly series stop the month before
LAST_COMPLETE_MONTH = month_add(max_date[0:7], -1)
FIRST_MONTH = '2010-01'
YEARS = list(range(2010, int(max_date[0:4]) + 1))
CUR_YEAR = YEARS[-1]
# year-to-date window: full months of the current year we can compare like-for-like
YTD_END = int(LAST_COMPLETE_MONTH[5:7]) if int(LAST_COMPLETE_MONTH[0:4]) == CUR_YEAR else 12
YTD_LABEL = f'{MON_ABBR[0]}–{MON_ABBR[YTD_END - 1]}'
LAST_COMPLETE_YEAR = CUR_YEAR - 1 if YTD_END < 12 else CUR_YEAR
LAST_DATA_LABEL = f'{MON_ABBR[int(LAST_DATA_DAY[5:7]) - 1]} {int(LAST_DATA_DAY[8:10])}, {LAST_DATA_DAY[0:4]}'
PARTIAL_YEAR_NOTE = f'{CUR_YEAR} covers Jan. 1–{MON_ABBR[int(LAST_DATA_DAY[5:7]) - 1]} {int(LAST_DATA_DAY[8:10])}'
RECENT_START = month_add(LAST_COMPLETE_MONTH, -11)       # trailing 12 complete months
CHRONIC_START = month_add(LAST_COMPLETE_MONTH, -35)      # trailing 36 complete months
print(f'latest record {LAST_DATA_DAY}; monthly series through {LAST_COMPLETE_MONTH}; '
      f'YTD window {YTD_LABEL} {CUR_YEAR}')

months = []
m = FIRST_MONTH
while m <= LAST_COMPLETE_MONTH:
    months.append(m); m = month_add(m, 1)

# ---------------------------------------------------------------- tally 311
monthly_city = Counter()
monthly_boro = defaultdict(Counter)
hourly = Counter(); hourly_excluded_midnight = 0
loctype_year = defaultdict(Counter)
cd_monthly = defaultdict(Counter)
cd_ytd = Counter()                 # (boro_cd, year) -> n within the YTD window
hexes = defaultdict(lambda: [0] * len(YEARS))
radius_cells = Counter()           # (latq, lonq, year_index) -> n, for address lookup
radius_ytd = Counter()             # same key, counting only months inside the YTD window
recent_points = []
addr_counter = Counter(); addr_latlon = defaultdict(list)
no_coord = 0; no_cb = 0
sight_pts = []                     # (lon, lat, year, in_ytd_window) for NTA spatial join

for row in rows:
    cd_str = row['created_date']
    y, mo = int(cd_str[0:4]), int(cd_str[5:7])
    ym = cd_str[0:7]
    boro = row['borough'].strip().upper()
    if ym <= LAST_COMPLETE_MONTH:
        monthly_city[ym] += 1
        if boro in BORO_NUM:
            monthly_boro[boro][ym] += 1
    # hour of day: exact-midnight stamps are date-only records, not 12 a.m. reports
    t = cd_str[11:19]
    if t == '00:00:00':
        hourly_excluded_midnight += 1
    else:
        hourly[int(t[0:2])] += 1
    loctype_year[(row['location_type'] or 'Unknown').strip()][y] += 1
    in_ytd = mo <= YTD_END
    bcd = parse_cb(row['community_board'])
    if bcd is None:
        no_cb += 1
    else:
        if ym <= LAST_COMPLETE_MONTH:
            cd_monthly[bcd][ym] += 1
        if in_ytd:
            cd_ytd[(bcd, y)] += 1
    lat, lon = row['latitude'], row['longitude']
    if not lat or not lon:
        no_coord += 1
        continue
    lat, lon = float(lat), float(lon)
    if not (40.4 < lat < 41.0 and -74.3 < lon < -73.6):
        no_coord += 1
        continue
    hexes[(math.floor(lat / LAT_STEP), math.floor(lon / LON_STEP))][y - 2010] += 1
    rkey = (round((lat - RLAT0) / RLAT), round((lon - RLON0) / RLON), y - 2010)
    radius_cells[rkey] += 1
    if in_ytd:
        radius_ytd[rkey] += 1
    if RECENT_START <= ym <= LAST_COMPLETE_MONTH:
        recent_points.append([round(lat, 5), round(lon, 5), ym])
    sight_pts.append((lon, lat, y, in_ytd))
    if CHRONIC_START <= ym <= LAST_COMPLETE_MONTH:
        addr = ' '.join((row['incident_address'] or '').upper().split())
        if addr and boro in BORO_NUM:
            key = (addr, boro)
            addr_counter[key] += 1
            if len(addr_latlon[key]) < 40:
                addr_latlon[key].append((lat, lon))

print(f'sightings without usable coordinates: {no_coord} ({no_coord/len(rows)*100:.1f}%)')
print(f'sightings without community district: {no_cb} ({no_cb/len(rows)*100:.1f}%)')
print(f'hour-of-day records excluded (midnight stamps): {hourly_excluded_midnight}')

# ---------------------------------------------------------------- boundaries
from shapely.geometry import shape
from shapely.strtree import STRtree
import shapely

cd_gj = json.load(open(os.path.join(DATA, 'cd_boundaries.geojson')))
nta_gj = json.load(open(os.path.join(DATA, 'nta2020.geojson')))
pops = json.load(open(os.path.join(DATA, 'populations.json')))

cd_geoms, cd_ids = [], []
for f in cd_gj['features']:
    cd_geoms.append(shape(f['geometry'])); cd_ids.append(str(f['properties']['boro_cd']))
nta_geoms, nta_ids, nta_names = [], [], {}
for f in nta_gj['features']:
    p = f['properties']
    nta_geoms.append(shape(f['geometry'])); nta_ids.append(p['nta2020'])
    nta_names[p['nta2020']] = {'name': p['ntaname'], 'borough': p['boroname'], 'type': p.get('ntatype')}

def spatial_join(pts_lonlat, polys, poly_ids):
    """Point-in-polygon assignment; returns poly_id (or None) per point."""
    pt_geoms = shapely.points([p[0] for p in pts_lonlat], [p[1] for p in pts_lonlat])
    tree = STRtree(pt_geoms)
    assign = [None] * len(pt_geoms)
    for gi, poly in enumerate(polys):
        for i in tree.query(poly, predicate='intersects'):
            assign[i] = poly_ids[gi]
    return assign

print('joining sightings to neighborhoods...')
nta_assign = spatial_join([(p[0], p[1]) for p in sight_pts], nta_geoms, nta_ids)
nta_yearly = defaultdict(Counter)
nta_ytd = Counter()
unassigned = 0
for (lon, lat, y, in_ytd), nid in zip(sight_pts, nta_assign):
    if nid is None:
        unassigned += 1; continue
    nta_yearly[nid][y] += 1
    if in_ytd:
        nta_ytd[(nid, y)] += 1
print('sightings not inside any neighborhood polygon:', unassigned)

# ---------------------------------------------------------------- inspections
print('loading inspections...')
insp_city_year = defaultdict(lambda: [0, 0])   # year -> [n_initial, n_found_rat_activity]
insp_pts = []
insp_bad_date = 0; insp_no_coord = 0; insp_total = 0
cutoff = (date.today() + timedelta(days=1)).isoformat()   # guard against future-dated junk
RAT_RESULTS = ('Failed for Rat Activity', 'Failed for Rat Activity and Other Reason', 'Rat Activity')
with open(os.path.join(DATA, 'inspections_initial.csv'), newline='') as fh:
    for row in csv.DictReader(fh):
        insp_total += 1
        d = row['inspection_date']
        if not d or d[0:10] < '2010-01-01' or d[0:10] >= cutoff:
            insp_bad_date += 1; continue
        y = int(d[0:4])
        rat = row['result'] in RAT_RESULTS
        insp_city_year[y][0] += 1
        if rat:
            insp_city_year[y][1] += 1
        try:
            lat, lon = float(row['latitude']), float(row['longitude'])
        except ValueError:
            insp_no_coord += 1; continue
        if not (40.4 < lat < 41.0 and -74.3 < lon < -73.6):
            insp_no_coord += 1; continue
        insp_pts.append((lon, lat, y, rat))
if insp_total < MIN_INSPECTIONS:
    raise SystemExit(f'FATAL: {insp_total} inspections, below floor {MIN_INSPECTIONS}.')
print(f'inspections excluded for impossible dates: {insp_bad_date}; without coordinates: {insp_no_coord}')

print('joining inspections to community districts...')
insp_cd_year = defaultdict(lambda: defaultdict(lambda: [0, 0]))
for (lon, lat, y, rat), cid in zip(insp_pts, spatial_join([(p[0], p[1]) for p in insp_pts], cd_geoms, cd_ids)):
    if cid is None: continue
    c = insp_cd_year[cid][y]; c[0] += 1
    if rat: c[1] += 1

print('joining inspections to neighborhoods...')
insp_nta_year = defaultdict(lambda: defaultdict(lambda: [0, 0]))
for (lon, lat, y, rat), nid in zip(insp_pts, spatial_join([(p[0], p[1]) for p in insp_pts], nta_geoms, nta_ids)):
    if nid is None: continue
    c = insp_nta_year[nid][y]; c[0] += 1
    if rat: c[1] += 1

# ---------------------------------------------------------------- outputs
boro_pop = defaultdict(int)
CD_NAMES = {}
for cd, v in pops['cd'].items():
    boro_pop[v['borough']] += v['pop2020']
    CD_NAMES[cd] = v['name']

summary = {
    'generated': date.today().isoformat(),
    'last_data_date': LAST_DATA_DAY,
    'last_data_label': LAST_DATA_LABEL,
    'last_complete_month': LAST_COMPLETE_MONTH,
    'last_complete_year': LAST_COMPLETE_YEAR,
    'ytd_end_month': YTD_END,
    'ytd_label': YTD_LABEL,
    'partial_year_note': PARTIAL_YEAR_NOTE,
    'recent_window': [RECENT_START, LAST_COMPLETE_MONTH],
    'chronic_window': [CHRONIC_START, LAST_COMPLETE_MONTH],
    'total_sightings': len(rows),
    'file_counts': file_counts,
    'total_inspections': insp_total,
    'years': YEARS,
    'months': months,
    'monthly_city': [monthly_city.get(m, 0) for m in months],
    'monthly_boro': {b: [monthly_boro[b].get(m, 0) for m in months] for b in BORO_NUM},
    'boro_pop2020': dict(boro_pop),
    'hourly': [hourly.get(h, 0) for h in range(24)],
    'hourly_excluded_midnight': hourly_excluded_midnight,
    'loctype_year': {},
    'insp_city_year': {str(y): insp_city_year[y] for y in sorted(insp_city_year)},
    'chronic': [],
    'no_coord': no_coord,
    'no_cb': no_cb,
    'insp_bad_date': insp_bad_date,
    'insp_no_coord': insp_no_coord,
}

# location types: top 9 by volume, everything else pooled
lt_totals = {lt: sum(c.values()) for lt, c in loctype_year.items()}
top_lts = sorted(lt_totals, key=lt_totals.get, reverse=True)[:9]
for lt in top_lts:
    summary['loctype_year'][lt] = [loctype_year[lt].get(y, 0) for y in YEARS]
other = [0] * len(YEARS)
for lt, c in loctype_year.items():
    if lt not in top_lts:
        for i, y in enumerate(YEARS):
            other[i] += c.get(y, 0)
summary['loctype_year']['All other'] = other

# chronic addresses over the trailing 36 complete months; median coordinate per address
for (addr, boro), n in addr_counter.most_common(100):
    lls = addr_latlon[(addr, boro)]
    lat = sorted(x[0] for x in lls)[len(lls) // 2]
    lon = sorted(x[1] for x in lls)[len(lls) // 2]
    summary['chronic'].append({'address': addr.title(), 'borough': boro.title(), 'n': n,
                               'lat': round(lat, 5), 'lon': round(lon, 5)})

json.dump(summary, open(os.path.join(OUT, 'summary.json'), 'w'))

geo_cd = {}
for cid in cd_ids:
    geo_cd[cid] = {
        'name': CD_NAMES.get(cid, f'Community District {cid}'),
        'pop': pops['cd'].get(cid, {}).get('pop2020'),
        'monthly': [cd_monthly[int(cid)].get(m, 0) for m in months],
        'ytd': {str(y): cd_ytd.get((int(cid), y), 0) for y in YEARS},
        'insp': {str(y): insp_cd_year[cid][y] for y in sorted(insp_cd_year[cid])},
    }
json.dump(geo_cd, open(os.path.join(OUT, 'geo_cd.json'), 'w'))

geo_nta = {}
for nid in nta_ids:
    geo_nta[nid] = {
        'name': nta_names[nid]['name'],
        'borough': nta_names[nid]['borough'],
        'type': nta_names[nid]['type'],
        'pop': pops['nta'].get(nid, {}).get('pop2020'),
        'yearly': {str(y): nta_yearly[nid].get(y, 0) for y in YEARS},
        'ytd': {str(y): nta_ytd.get((nid, y), 0) for y in YEARS},
        'insp': {str(y): insp_nta_year[nid][y] for y in sorted(insp_nta_year[nid])},
    }
json.dump(geo_nta, open(os.path.join(OUT, 'geo_nta.json'), 'w'))

# Simplified boundaries for the web map: 0.0002 degrees (~20m) of tolerance and five
# decimal places keeps district shapes faithful at city zoom while cutting file size ~6x.
from shapely.geometry import mapping
def write_simplified(src_gj, out_name, keep_props):
    feats = []
    for f in src_gj['features']:
        gm = mapping(shape(f['geometry']).simplify(0.0002, preserve_topology=True))
        def rnd(c):
            return [round(c[0], 5), round(c[1], 5)] if isinstance(c[0], (int, float)) else [rnd(x) for x in c]
        gm['coordinates'] = rnd(gm['coordinates'])
        feats.append({'type': 'Feature', 'geometry': gm,
                      'properties': {k: f['properties'][k] for k in keep_props if k in f['properties']}})
    json.dump({'type': 'FeatureCollection', 'features': feats},
              open(os.path.join(OUT, out_name), 'w'), separators=(',', ':'))
    print(f'{out_name}: {len(feats)} features')

write_simplified(cd_gj, 'cd.geojson', ['boro_cd'])
write_simplified(nta_gj, 'nta.geojson', ['nta2020', 'ntaname', 'boroname', 'ntatype'])

hex_out = {'lat_step': LAT_STEP, 'lon_step': LON_STEP, 'years': YEARS,
           'cells': [[k[0], k[1]] + v for k, v in hexes.items()]}
json.dump(hex_out, open(os.path.join(OUT, 'hex.json'), 'w'), separators=(',', ':'))
print('map grid cells:', len(hexes))

json.dump(recent_points, open(os.path.join(OUT, 'points_recent.json'), 'w'), separators=(',', ':'))
print('recent points:', len(recent_points))

# radius.json — sightings quantized to ~28m cells for the address lookup.
# Sorted and delta-encoded on latitude so the file gzips well (~0.3 MB over the wire).
keys = sorted(radius_cells)
dlat, lonq, yri, cnt, ycnt, prev = [], [], [], [], [], 0
for k in keys:
    dlat.append(k[0] - prev); prev = k[0]
    lonq.append(k[1]); yri.append(k[2])
    cnt.append(radius_cells[k]); ycnt.append(radius_ytd.get(k, 0))
json.dump({'lat0': RLAT0, 'lon0': RLON0, 'lat_step': RLAT, 'lon_step': RLON,
           'years': YEARS, 'ytd_end_month': YTD_END,
           'dlat': dlat, 'lon': lonq, 'yr': yri, 'cnt': cnt, 'ycnt': ycnt},
          open(os.path.join(OUT, 'radius.json'), 'w'), separators=(',', ':'))
print('radius cells:', len(keys))

for f in ('summary.json', 'geo_cd.json', 'geo_nta.json', 'hex.json', 'points_recent.json', 'radius.json', 'cd.geojson', 'nta.geojson'):
    p = os.path.join(OUT, f)
    sz = os.path.getsize(p)
    if sz < 1000:
        raise SystemExit(f'FATAL: {f} is only {sz} bytes.')
    print(f, f'{sz/1e6:.2f} MB')
print('AGGREGATION DONE')
