#!/usr/bin/env python3
# Title: Aggregate NYC rat data for "the rat map" site
# Author: Generated with Claude Code for Josh Greenman / Vital City
# Date: 2026-08-05
# Data sources (access date 2026-08-05):
#   - NYC Open Data 76ig-c548: 311 Service Requests 2010-2019 (Rodent / Rat Sighting), 140,816 rows
#   - NYC Open Data erm2-nwe9: 311 Service Requests 2020-present (Rodent / Rat Sighting), 148,476 rows
#   - NYC Open Data p937-wjvj: DOHMH Rodent Inspection, inspection_type='Initial', 2,118,653 rows
#   - NYC Open Data 5crt-au7u: Community Districts (shoreline-clipped)
#   - NYC Open Data 9nt8-h7nd: 2020 Neighborhood Tabulation Areas (shoreline-clipped)
#   - DCP nyc_decennialcensusdata_2010_2020_change.xlsx: 2020 census populations by CD and NTA2020
# Description: Produces all JSON consumed by the static site. Every derived number
#   in the site traces to a calculation in this file.
# Dependencies: Python 3.9+, shapely 2.0.7 (spatial joins), stdlib csv/json.
# Fail-loud: asserts on expected row counts and non-empty outputs.

import csv, json, math, sys, os
from collections import defaultdict, Counter
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, 'data')
OUT = os.path.join(BASE, 'docs', 'data')
os.makedirs(OUT, exist_ok=True)

YEARS = list(range(2010, 2027))            # 2026 is partial: Jan 1 - Aug 4
LAST_COMPLETE_MONTH = '2026-07'            # monthly series cut here
YTD_MONTHS = (1, 7)                        # Jan-Jul windows for YoY comparisons
LAT_STEP, LON_STEP = 0.002, 0.0026         # grid cells ~220m on a side at NYC latitude

BORO_NUM = {'MANHATTAN': 1, 'BRONX': 2, 'BROOKLYN': 3, 'QUEENS': 4, 'STATEN ISLAND': 5}

def parse_cb(cb, borough):
    """'01 BRONX' -> 201. Returns None for Unspecified/invalid."""
    if not cb:
        return None
    parts = cb.strip().rsplit(' ', 1)
    cb_up = cb.upper()
    for name, num in BORO_NUM.items():
        if cb_up.endswith(name):
            head = cb_up[: -len(name)].strip()
            if head.isdigit():
                d = int(head)
                if 1 <= d <= 99:
                    return num * 100 + d
    return None

# ---------------------------------------------------------------- load 311
rows = []
for f in ('rat_311_2010_2019.csv', 'rat_311_2020_present.csv'):
    with open(os.path.join(DATA, f), newline='') as fh:
        r = list(csv.DictReader(fh))
        print(f, len(r))
        rows.extend(r)
assert len(rows) == 289292, f"expected 289,292 sightings, got {len(rows)}"

monthly_city = Counter()
monthly_boro = defaultdict(Counter)
hourly = Counter(); hourly_excluded_midnight = 0
loctype_year = defaultdict(Counter)
cd_monthly = defaultdict(Counter)
cd_janjul = Counter()     # (boro_cd, year) -> n for Jan-Jul window
hexes = defaultdict(lambda: [0]*len(YEARS))
recent_points = []
addr_counter = Counter(); addr_latlon = defaultdict(list); addr_boro = {}
no_coord = 0; no_cb = 0
sight_pts = []   # (lon, lat, year, janjul_flag, ym) for NTA spatial join
max_date = ''

for row in rows:
    cd_str = row['created_date']            # local ET per 311 convention
    if cd_str > max_date: max_date = cd_str
    y, mo = int(cd_str[0:4]), int(cd_str[5:7])
    ym = cd_str[0:7]
    boro = row['borough'].strip().upper()
    if ym <= LAST_COMPLETE_MONTH:
        monthly_city[ym] += 1
        if boro in BORO_NUM:
            monthly_boro[boro][ym] += 1
    # hour of day: skip exact-midnight timestamps (date-only records)
    t = cd_str[11:19]
    if t == '00:00:00':
        hourly_excluded_midnight += 1
    else:
        hourly[int(t[0:2])] += 1
    lt = (row['location_type'] or 'Unknown').strip()
    loctype_year[lt][y] += 1
    bcd = parse_cb(row['community_board'], boro)
    if bcd is None:
        no_cb += 1
    else:
        if ym <= LAST_COMPLETE_MONTH:
            cd_monthly[bcd][ym] += 1
        if YTD_MONTHS[0] <= mo <= YTD_MONTHS[1]:
            cd_janjul[(bcd, y)] += 1
    lat, lon = row['latitude'], row['longitude']
    if not lat or not lon:
        no_coord += 1
        continue
    lat, lon = float(lat), float(lon)
    if not (40.4 < lat < 41.0 and -74.3 < lon < -73.6):
        no_coord += 1
        continue
    ilat, ilon = math.floor(lat / LAT_STEP), math.floor(lon / LON_STEP)
    hexes[(ilat, ilon)][y - 2010] += 1
    if '2025-08' <= ym <= '2026-07':
        recent_points.append([round(lat, 5), round(lon, 5), ym])
    janjul = YTD_MONTHS[0] <= mo <= YTD_MONTHS[1]
    sight_pts.append((lon, lat, y, janjul, ym))
    # chronic addresses: last 36 complete months
    if '2023-08' <= ym <= '2026-07':
        addr = ' '.join((row['incident_address'] or '').upper().split())
        if addr and boro in BORO_NUM:
            key = (addr, boro)
            addr_counter[key] += 1
            if len(addr_latlon[key]) < 40:
                addr_latlon[key].append((lat, lon))

print('sightings without usable coordinates:', no_coord, f'({no_coord/len(rows)*100:.1f}%)')
print('sightings without CB:', no_cb, f'({no_cb/len(rows)*100:.1f}%)')
print('hourly excluded midnight:', hourly_excluded_midnight)
print('max created_date:', max_date)

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
    if p.get('ntatype') not in (None, '0', 0):   # keep residential + parks etc? keep all, flag later
        pass
    nta_geoms.append(shape(f['geometry'])); nta_ids.append(p['nta2020'])
    nta_names[p['nta2020']] = {'name': p['ntaname'], 'borough': p['boroname'], 'type': p.get('ntatype')}

def spatial_join(pts_lonlat, polys, poly_ids):
    """Return array of poly_id (or None) per point."""
    pt_geoms = shapely.points([p[0] for p in pts_lonlat], [p[1] for p in pts_lonlat])
    tree = STRtree(pt_geoms)
    assign = [None] * len(pt_geoms)
    for gi, poly in enumerate(polys):
        idx = tree.query(poly, predicate='intersects')
        for i in idx:
            assign[i] = poly_ids[gi]
    return assign

print('joining 311 points to NTAs...')
nta_assign = spatial_join([(p[0], p[1]) for p in sight_pts], nta_geoms, nta_ids)
nta_yearly = defaultdict(Counter)
nta_janjul = Counter()
unassigned = 0
for (lon, lat, y, janjul, ym), nid in zip(sight_pts, nta_assign):
    if nid is None:
        unassigned += 1; continue
    nta_yearly[nid][y] += 1
    if janjul:
        nta_janjul[(nid, y)] += 1
print('311 points not inside any NTA:', unassigned)

# ---------------------------------------------------------------- inspections
print('loading inspections...')
insp_city_year = defaultdict(lambda: [0, 0])   # year -> [n_initial, n_rat_activity]
insp_pts = []                                   # (lon, lat, year, rat_flag)
insp_bad_date = 0; insp_no_coord = 0
today = '2026-08-06'
with open(os.path.join(DATA, 'inspections_initial.csv'), newline='') as fh:
    for row in csv.DictReader(fh):
        d = row['inspection_date']
        if not d or d[0:10] < '2010-01-01' or d[0:10] >= today:
            insp_bad_date += 1; continue
        y = int(d[0:4])
        rat = row['result'] in ('Failed for Rat Activity', 'Failed for Rat Activity and Other Reason', 'Rat Activity')
        insp_city_year[y][0] += 1
        if rat: insp_city_year[y][1] += 1
        try:
            lat, lon = float(row['latitude']), float(row['longitude'])
        except ValueError:
            insp_no_coord += 1; continue
        if not (40.4 < lat < 41.0 and -74.3 < lon < -73.6):
            insp_no_coord += 1; continue
        insp_pts.append((lon, lat, y, rat))
print('inspections excluded for bad dates:', insp_bad_date, '; no coords:', insp_no_coord)
assert sum(v[0] for v in insp_city_year.values()) > 2000000

print('joining inspections to CDs...')
cd_assign = spatial_join([(p[0], p[1]) for p in insp_pts], cd_geoms, cd_ids)
insp_cd_year = defaultdict(lambda: defaultdict(lambda: [0, 0]))
for (lon, lat, y, rat), cid in zip(insp_pts, cd_assign):
    if cid is None: continue
    c = insp_cd_year[cid][y]; c[0] += 1
    if rat: c[1] += 1

print('joining inspections to NTAs...')
nta_assign2 = spatial_join([(p[0], p[1]) for p in insp_pts], nta_geoms, nta_ids)
insp_nta_year = defaultdict(lambda: defaultdict(lambda: [0, 0]))
for (lon, lat, y, rat), nid in zip(insp_pts, nta_assign2):
    if nid is None: continue
    c = insp_nta_year[nid][y]; c[0] += 1
    if rat: c[1] += 1

# ---------------------------------------------------------------- outputs
months = []
y0, m0 = 2010, 1
while f'{y0:04d}-{m0:02d}' <= LAST_COMPLETE_MONTH:
    months.append(f'{y0:04d}-{m0:02d}')
    m0 += 1
    if m0 == 13: m0 = 1; y0 += 1

boro_pop = defaultdict(int)
for cd, v in pops['cd'].items():
    boro_pop[v['borough']] += v['pop2020']

# CD names
CD_NAMES = {}  # from populations file
for cd, v in pops['cd'].items():
    CD_NAMES[cd] = v['name']

summary = {
    'generated': '2026-08-05',
    'last_data_date': max_date[0:10],
    'total_sightings': len(rows),
    'months': months,
    'monthly_city': [monthly_city.get(m, 0) for m in months],
    'monthly_boro': {b: [monthly_boro[b].get(m, 0) for m in months] for b in BORO_NUM},
    'boro_pop2020': dict(boro_pop),
    'hourly': [hourly.get(h, 0) for h in range(24)],
    'hourly_excluded_midnight': hourly_excluded_midnight,
    'seasonality_note': 'complete years 2010-2025',
    'loctype_year': {},
    'insp_city_year': {str(y): insp_city_year[y] for y in sorted(insp_city_year)},
    'chronic': [],
    'no_coord': no_coord,
    'no_cb': no_cb,
    'insp_bad_date': insp_bad_date,
    'insp_no_coord': insp_no_coord,
}

# location types: top 9 + Other, per year
lt_totals = {lt: sum(c.values()) for lt, c in loctype_year.items()}
top_lts = sorted(lt_totals, key=lt_totals.get, reverse=True)[:9]
for lt in top_lts:
    summary['loctype_year'][lt] = [loctype_year[lt].get(y, 0) for y in YEARS]
other = [0]*len(YEARS)
for lt, c in loctype_year.items():
    if lt not in top_lts:
        for i, y in enumerate(YEARS):
            other[i] += c.get(y, 0)
summary['loctype_year']['All other'] = other
summary['years'] = YEARS

# chronic addresses (top 100, last 36 months)
for (addr, boro), n in addr_counter.most_common(100):
    lls = addr_latlon[(addr, boro)]
    lat = sorted(x[0] for x in lls)[len(lls)//2]
    lon = sorted(x[1] for x in lls)[len(lls)//2]
    summary['chronic'].append({'address': addr.title(), 'borough': boro.title(), 'n': n,
                               'lat': round(lat, 5), 'lon': round(lon, 5)})

json.dump(summary, open(os.path.join(OUT, 'summary.json'), 'w'))

# geo_cd.json
geo_cd = {}
for cid in cd_ids:
    pop = pops['cd'].get(cid, {}).get('pop2020')
    geo_cd[cid] = {
        'name': CD_NAMES.get(cid, f'CD {cid}'),
        'pop': pop,
        'monthly': [cd_monthly[int(cid)].get(m, 0) for m in months] if int(cid) in cd_monthly else [0]*len(months),
        'janjul': {str(y): cd_janjul.get((int(cid), y), 0) for y in YEARS},
        'insp': {str(y): insp_cd_year[cid][y] for y in sorted(insp_cd_year[cid])},
    }
json.dump(geo_cd, open(os.path.join(OUT, 'geo_cd.json'), 'w'))

# geo_nta.json
geo_nta = {}
for nid in nta_ids:
    pop = pops['nta'].get(nid, {}).get('pop2020')
    geo_nta[nid] = {
        'name': nta_names[nid]['name'],
        'borough': nta_names[nid]['borough'],
        'type': nta_names[nid]['type'],
        'pop': pop,
        'yearly': {str(y): nta_yearly[nid].get(y, 0) for y in YEARS},
        'janjul': {str(y): nta_janjul.get((nid, y), 0) for y in YEARS},
        'insp': {str(y): insp_nta_year[nid][y] for y in sorted(insp_nta_year[nid])},
    }
json.dump(geo_nta, open(os.path.join(OUT, 'geo_nta.json'), 'w'))

# hex.json — compact arrays [ilat, ilon, y2010..y2026]
hex_out = {'lat_step': LAT_STEP, 'lon_step': LON_STEP, 'years': YEARS,
           'cells': [[k[0], k[1]] + v for k, v in hexes.items()]}
json.dump(hex_out, open(os.path.join(OUT, 'hex.json'), 'w'), separators=(',', ':'))
print('hex cells:', len(hexes))

# recent points
json.dump(recent_points, open(os.path.join(OUT, 'points_recent.json'), 'w'), separators=(',', ':'))
print('recent points:', len(recent_points))

for f in ('summary.json', 'geo_cd.json', 'geo_nta.json', 'hex.json', 'points_recent.json'):
    p = os.path.join(OUT, f)
    sz = os.path.getsize(p)
    assert sz > 200, f'{f} suspiciously small'
    print(f, f'{sz/1e6:.2f} MB')
print('AGGREGATION DONE')
