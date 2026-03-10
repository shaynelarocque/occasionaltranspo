#!/usr/bin/env python3
"""
Ottawa/Gatineau Transit Travel Time Map — GTFS Processor

Generates subway.js and schedules/ files from OC Transpo and STO GTFS data.

Usage:
    python3 process_gtfs.py

Requires:
    data/octranspo_gtfs.zip  — OC Transpo GTFS (download manually, see README)
    data/sto_gtfs.zip        — STO GTFS (auto-downloaded)

Outputs:
    subway.js
    schedules/transfers.js
    schedules/weekday_rush.json
    schedules/weekday_evening.json
    schedules/weekend_afternoon.json
"""

import bisect, csv, io, json, math, os, sys, zipfile, ssl
import urllib.request
from collections import defaultdict, Counter
from datetime import datetime, date as date_type

HOURS = 3600
STO_URL = 'https://contenu.sto.ca/GTFS/GTFS.zip'

AGENCY_CONFIGS = [
    {
        'prefix': 'oct',
        'zip_path': 'data/octranspo_gtfs.zip',
        'download_url': None,  # Requires API key from OC Transpo developer portal
        'fallback_color': 'D52B1E',  # OC Transpo red
    },
    {
        'prefix': 'sto',
        'zip_path': 'data/sto_gtfs.zip',
        'download_url': STO_URL,
        'fallback_color': '005DAA',  # STO blue
    },
]

SCHEDULE_CONFIGS = [
    # (output_name, day_type, start_hour, end_hour)
    ('weekday_rush',      'weekday', 7,  10),
    ('weekday_evening',   'weekday', 19, 22),
    ('weekend_afternoon', 'weekend', 12, 15),
]


def time_str_to_float(t):
    """Parse HH:MM:SS (may exceed 24h) into seconds."""
    h, m, s = map(float, t.split(':'))
    return h * 3600 + m * 60 + s


def download_if_missing(url, path):
    if os.path.exists(path):
        print(f'  Using cached {path}')
        return True
    print(f'  Downloading {url} → {path} ...')
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        req = urllib.request.Request(url, headers={'User-Agent': 'occasionaltranspo/1.0'})
        # Some transit agency servers use self-signed certs; skip verification
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with urllib.request.urlopen(req, context=ctx) as resp, open(path, 'wb') as out:
            out.write(resp.read())
        print('  Done.')
        return True
    except Exception as e:
        print(f'  Failed: {e}')
        return False


def open_gtfs_file(zf, filename):
    """Open a file from a GTFS zip, handling optional subdirectory nesting."""
    namelist = zf.namelist()
    candidates = [n for n in namelist if n.endswith('/' + filename) or n == filename]
    if not candidates:
        return []
    with zf.open(candidates[0]) as f:
        return list(csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig')))


def read_gtfs(zip_path, prefix, fallback_color):
    """Parse a GTFS zip into normalised dicts with prefixed IDs."""
    print(f'  Reading {zip_path} ...')
    with zipfile.ZipFile(zip_path) as zf:
        namelist = zf.namelist()

        def read(filename):
            return open_gtfs_file(zf, filename)

        def p(raw_id):
            return f'{prefix}_{raw_id}'

        # ── Service IDs ──────────────────────────────────────────────────────
        # weekday_sids     = ALL service IDs that run on any weekday (for route discovery)
        # representative_weekday_sids = service IDs from ONE typical day (for schedule events)
        # weekend_sids     = service IDs that run on Sat or Sun
        weekday_sids, weekend_sids = set(), set()
        representative_weekday_sids = set()
        representative_weekend_sids = set()

        WEEKDAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
        # Group service IDs by which weekday they run on (some agencies publish
        # one service ID per calendar day rather than a single recurring "weekday" ID)
        sids_by_weekday = defaultdict(set)  # 0=Mon … 4=Fri

        calendar_rows = read('calendar.txt')
        for row in calendar_rows:
            sid = p(row['service_id'])
            for i, day in enumerate(WEEKDAY_NAMES):
                if row.get(day, '0') == '1':
                    weekday_sids.add(sid)
                    sids_by_weekday[i].add(sid)
            if row.get('saturday', '0') == '1' or row.get('sunday', '0') == '1':
                weekend_sids.add(sid)

        # representative_weekday_sids will be filled after we read trips (need trip
        # counts to pick the single best service ID per day).  Store day→sids for now.
        # We will finalize representative_weekday_sids below after reading trips.txt.
        _sids_by_weekday = sids_by_weekday  # keep reference for post-trip selection

        # Fallback: parse calendar_dates.txt if calendar.txt is empty/missing
        if not weekday_sids:
            cal_dates_rows = read('calendar_dates.txt')
            if cal_dates_rows:
                # Classify service_ids by the day-of-week of their dates
                # Also try keyword detection in the service_id string itself
                svc_day_counts = defaultdict(lambda: defaultdict(int))
                for row in cal_dates_rows:
                    if row.get('exception_type', '1') != '1':
                        continue
                    sid = p(row['service_id'])
                    try:
                        d = datetime.strptime(row['date'], '%Y%m%d')
                        svc_day_counts[sid][d.weekday()] += 1  # 0=Mon, 5=Sat, 6=Sun
                    except ValueError:
                        pass
                    # Keyword fallback from service_id name (bilingual)
                    raw = row['service_id'].lower()
                    if any(kw in raw for kw in ('semaine', 'weekday', 'wkd', 'lundi', 'monday')):
                        weekday_sids.add(sid)
                    if any(kw in raw for kw in ('samedi', 'saturday', 'sat')):
                        weekend_sids.add(sid)
                    if any(kw in raw for kw in ('dimanche', 'sunday', 'sun')):
                        weekend_sids.add(sid)

                # For any service_ids not yet classified, use day-of-week majority
                for sid, day_counts in svc_day_counts.items():
                    if sid not in weekday_sids and sid not in weekend_sids:
                        weekday_count = sum(day_counts[d] for d in range(5))  # Mon-Fri
                        weekend_count = day_counts[5] + day_counts[6]  # Sat+Sun
                        if weekday_count >= weekend_count:
                            weekday_sids.add(sid)
                        else:
                            weekend_sids.add(sid)

            if not weekday_sids:
                print('  [warn] No calendar data found — using all service IDs for all schedules')
                all_sids = {p(r['service_id']) for r in read('trips.txt')}
                weekday_sids = all_sids
                weekend_sids = all_sids

        # Safety net: if calendar_dates path ran, representative sets may still be empty
        if not representative_weekday_sids:
            representative_weekday_sids = weekday_sids
        if not representative_weekend_sids:
            representative_weekend_sids = weekend_sids

        # ── Stops ────────────────────────────────────────────────────────────
        parent_map = {}  # child stop_id → parent stop_id
        stops = {}
        for row in read('stops.txt'):
            sid = p(row['stop_id'])
            parent = row.get('parent_station', '').strip()
            if parent:
                parent_map[sid] = p(parent)
            try:
                stops[sid] = {
                    'name': row['stop_name'].strip(),
                    'lat': float(row['stop_lat']),
                    'lon': float(row['stop_lon']),
                }
            except (ValueError, KeyError):
                pass

        def resolve(raw_id):
            sid = p(raw_id)
            seen = set()
            while sid in parent_map and sid not in seen:
                seen.add(sid)
                sid = parent_map[sid]
            return sid

        # ── Routes ───────────────────────────────────────────────────────────
        routes = {}
        for row in read('routes.txt'):
            rid = p(row['route_id'])
            color = row.get('route_color', '').strip().lstrip('#')
            if not color or color.lower() in ('ffffff', '000000', 'ffffffff'):
                color = fallback_color
            routes[rid] = {
                'short_name': (row.get('route_short_name') or row.get('route_long_name') or rid).strip(),
                'color': '#' + color,
                'type': int(row.get('route_type', 3)),
            }

        # ── Trips ────────────────────────────────────────────────────────────
        trips = {}
        for row in read('trips.txt'):
            tid = p(row['trip_id'])
            trips[tid] = {
                'service_id': p(row['service_id']),
                'route_id': p(row['route_id']),
            }

        # ── Pick representative service IDs (now that we have trip counts) ──────
        # For agencies that publish one service ID per calendar day, we want just
        # ONE day's IDs so schedule event files aren't n×inflated.
        # Strategy: pick the SINGLE service ID per day that has the most trips.
        # Always include any IDs that span the full week (e.g. O-Train named IDs).
        trips_per_sid = Counter(p(r['service_id']) for r in read('trips.txt'))

        def _pick_best(day_set, anchor_set):
            """From day_set, pick the one SID with the most trips, plus anchor_set."""
            candidates = day_set - anchor_set
            if not candidates:
                return anchor_set or day_set
            best = max(candidates, key=lambda s: trips_per_sid.get(s, 0))
            return {best} | anchor_set

        # Weekday representative
        all_week_sids = {sid for sid in weekday_sids
                         if all(sid in _sids_by_weekday[i] for i in range(5))}
        for preferred in [2, 3, 1, 0, 4]:  # Wed, Thu, Tue, Mon, Fri
            if _sids_by_weekday[preferred]:
                representative_weekday_sids = _pick_best(_sids_by_weekday[preferred], all_week_sids)
                break
        if not representative_weekday_sids:
            representative_weekday_sids = weekday_sids

        # Weekend representative (prefer Saturday over Sunday for our schedule)
        sids_by_weekend_day = defaultdict(set)
        for row in calendar_rows:
            sid = p(row['service_id'])
            if row.get('saturday', '0') == '1':
                sids_by_weekend_day[5].add(sid)
            if row.get('sunday', '0') == '1':
                sids_by_weekend_day[6].add(sid)
        representative_weekend_sids = set()
        for preferred in [5, 6]:  # Sat, then Sun
            if sids_by_weekend_day[preferred]:
                representative_weekend_sids = _pick_best(sids_by_weekend_day[preferred], set())
                break
        if not representative_weekend_sids:
            representative_weekend_sids = weekend_sids

        # ── Stop times ───────────────────────────────────────────────────────
        stop_times_by_trip = defaultdict(list)
        for row in read('stop_times.txt'):
            tid = p(row['trip_id'])
            if tid not in trips:
                continue
            stop_id = resolve(row['stop_id'])
            try:
                t = int(time_str_to_float(row['departure_time']))
                seq = int(row['stop_sequence'])
            except (ValueError, KeyError):
                continue
            stop_times_by_trip[tid].append({'stop_id': stop_id, 'time': t, 'seq': seq})

        # ── Transfers ────────────────────────────────────────────────────────
        transfers = defaultdict(list)
        for row in read('transfers.txt'):
            if row.get('transfer_type', '') == '3':
                continue
            from_id = resolve(row['from_stop_id'])
            to_id = resolve(row['to_stop_id'])
            t = float(row.get('min_transfer_time') or '0')
            transfers[from_id].append({'to': to_id, 'time': t})

    result = {
        'stops': stops,
        'routes': routes,
        'trips': trips,
        'stop_times_by_trip': dict(stop_times_by_trip),
        'transfers': dict(transfers),
        'weekday_sids': weekday_sids,
        'weekend_sids': weekend_sids,
        'representative_weekday_sids': representative_weekday_sids,
        'representative_weekend_sids': representative_weekend_sids,
    }
    print(f'  → {len(stops)} stops, {len(routes)} routes, {len(trips)} trips')
    return result


WALK_SPEED_MS = 1.2        # m/s  (~4.3 km/h, standard pedestrian speed)
WALK_TRANSFER_MAX_M = 400  # only infer transfers within this radius


def _dist_m(lat1, lon1, lat2, lon2):
    """Haversine distance in metres."""
    R = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


WALK_WITHIN_AGENCY_MAX_M = 150   # within-agency: catches stops on same block/complex


def infer_proximity_transfers(all_stops, existing_transfers,
                              max_m=WALK_TRANSFER_MAX_M,
                              within_agency_max_m=WALK_WITHIN_AGENCY_MAX_M):
    """
    Add bidirectional walking transfers:
      - Cross-agency:  stops from different agencies within max_m metres
      - Within-agency: stops from the same agency within within_agency_max_m metres
                       (catches stops on opposite sides of a street / same terminal)
    """
    # Build a per-agency index: {prefix: [(sid, lat, lon), ...]} sorted by lat
    by_agency = defaultdict(list)
    for sid, s in all_stops.items():
        prefix = sid.split('_')[0]
        by_agency[prefix].append((sid, s['lat'], s['lon']))

    # Sort each agency list by latitude for binary-search banding
    for prefix in by_agency:
        by_agency[prefix].sort(key=lambda x: x[1])

    agencies = list(by_agency.keys())
    transfers = defaultdict(list, {k: list(v) for k, v in existing_transfers.items()})

    # Pre-compute existing transfer pairs so we don't duplicate
    existing_pairs = set()
    for from_id, xfers in existing_transfers.items():
        for x in xfers:
            existing_pairs.add((from_id, x['to']))

    def _add_pairs(stops_a, stops_b, radius_m, label):
        """Compare two stop lists and add walking transfers within radius_m."""
        nonlocal added
        dlat_deg = radius_m / 111_200
        mid_lat = stops_a[len(stops_a) // 2][1]
        dlon_deg = radius_m / (111_200 * math.cos(math.radians(mid_lat)))
        lats_b = [s[1] for s in stops_b]

        for sid_a, lat_a, lon_a in stops_a:
            # Binary search for lat band in stops_b
            lo = bisect.bisect_left(lats_b, lat_a - dlat_deg)
            hi = bisect.bisect_right(lats_b, lat_a + dlat_deg)
            for sid_b, lat_b, lon_b in stops_b[lo:hi]:
                if sid_a == sid_b:
                    continue
                if abs(lon_b - lon_a) > dlon_deg:
                    continue
                d = _dist_m(lat_a, lon_a, lat_b, lon_b)
                if d > radius_m:
                    continue
                walk_t = round(d / WALK_SPEED_MS)
                for (src, dst) in [(sid_a, sid_b), (sid_b, sid_a)]:
                    if (src, dst) not in existing_pairs:
                        transfers[src].append({'to': dst, 'time': walk_t})
                        existing_pairs.add((src, dst))
                        added += 1

    added = 0

    # Cross-agency pairs
    cross_before = 0
    for i in range(len(agencies)):
        for j in range(i + 1, len(agencies)):
            _add_pairs(by_agency[agencies[i]], by_agency[agencies[j]], max_m, 'cross')
    cross_added = added
    print(f'  Added {cross_added // 2} cross-agency walking transfer pairs '
          f'({cross_added} directed edges, max {max_m}m)')

    # Within-agency pairs
    added = 0
    if within_agency_max_m > 0:
        for prefix in agencies:
            stops = by_agency[prefix]
            _add_pairs(stops, stops, within_agency_max_m, prefix)
    within_added = added
    print(f'  Added {within_added // 2} within-agency walking transfer pairs '
          f'({within_added} directed edges, max {within_agency_max_m}m)')

    return dict(transfers)


def select_best_trip(trip_list, target_time=9 * HOURS):
    """Pick the trip with the most stops whose midpoint is closest to target_time."""
    if not trip_list:
        return None
    max_stops = max(len(t) for t in trip_list)
    # Only consider "full" trips (at least 80% of the longest)
    candidates = [t for t in trip_list if len(t) >= max_stops * 0.8]

    def score(events):
        times = sorted(e['time'] for e in events)
        mid = times[len(times) // 2]
        return abs(mid - target_time)

    return min(candidates, key=score)


def main():
    os.makedirs('data', exist_ok=True)
    os.makedirs('schedules', exist_ok=True)

    # ── Load / download GTFS ─────────────────────────────────────────────────
    all_data = []
    for cfg in AGENCY_CONFIGS:
        path = cfg['zip_path']
        if not os.path.exists(path):
            if cfg['download_url']:
                print(f'\nDownloading {cfg["prefix"].upper()} GTFS...')
                if not download_if_missing(cfg['download_url'], path):
                    continue
            else:
                print(f'\n[!] {cfg["prefix"].upper()} GTFS not found at {path}')
                print(f'    Register at https://nextrip-public-api.developer.azure-api.net/')
                print(f'    Download the GTFS Schedule zip and save it to: {path}')
                continue
        print(f'\nProcessing {cfg["prefix"].upper()} GTFS...')
        data = read_gtfs(path, cfg['prefix'], cfg['fallback_color'])
        all_data.append(data)

    if not all_data:
        print('\nError: No GTFS data available. Please download at least one feed.')
        sys.exit(1)

    # ── Merge agencies ───────────────────────────────────────────────────────
    all_stops = {}
    all_routes = {}
    all_trips = {}
    all_stop_times = {}
    all_transfers = defaultdict(list)
    all_weekday_sids = set()           # all weekday service IDs (route discovery)
    all_rep_weekday_sids = set()       # one representative weekday (event generation)
    all_weekend_sids = set()
    all_rep_weekend_sids = set()       # one representative weekend day (event generation)

    for data in all_data:
        all_stops.update(data['stops'])
        all_routes.update(data['routes'])
        all_trips.update(data['trips'])
        all_stop_times.update(data['stop_times_by_trip'])
        for sid, xfers in data['transfers'].items():
            all_transfers[sid].extend(xfers)
        all_weekday_sids |= data['weekday_sids']
        all_rep_weekday_sids |= data['representative_weekday_sids']
        all_weekend_sids |= data['weekend_sids']
        all_rep_weekend_sids |= data['representative_weekend_sids']

    print(f'\nMerged: {len(all_stops)} stops, {len(all_routes)} routes, {len(all_trips)} trips')

    # ── Representative run per route (weekday) ───────────────────────────────
    print('Selecting representative runs per route...')
    trips_by_route = defaultdict(list)
    for tid, trip in all_trips.items():
        if trip['service_id'] in all_weekday_sids and tid in all_stop_times:
            trips_by_route[trip['route_id']].append(all_stop_times[tid])

    best_runs = {}
    for route_id, trip_list in trips_by_route.items():
        best = select_best_trip(trip_list)
        if best:
            best_runs[route_id] = sorted(best, key=lambda e: e['seq'])

    # ── Build stations (only stops that appear on a route) ───────────────────
    stations_on_routes = set()
    for events in best_runs.values():
        for e in events:
            stations_on_routes.add(e['stop_id'])

    stations = {sid: all_stops[sid] for sid in stations_on_routes if sid in all_stops}
    print(f'Stations on routes: {len(stations)}')

    # ── Build lines ──────────────────────────────────────────────────────────
    lines = {}
    for route_id, events in best_runs.items():
        route = all_routes.get(route_id)
        if not route:
            continue
        stop_ids = [e['stop_id'] for e in events if e['stop_id'] in stations]
        if len(stop_ids) < 2:
            continue
        lines[route_id] = {
            'stations': stop_ids,
            'color': route['color'],
            'route_type': route['type'],
            'name': route['short_name'],
        }

    # ── Write subway.js ──────────────────────────────────────────────────────
    with open('subway.js', 'w') as f:
        f.write('subway = ' + json.dumps({'lines': lines, 'stations': stations}))
    print(f'Generated subway.js  ({len(lines)} lines, {len(stations)} stations)')

    # ── Infer cross-agency walking transfers ─────────────────────────────────
    print('Inferring cross-agency proximity transfers...')
    all_transfers = infer_proximity_transfers(all_stops, dict(all_transfers))

    # ── Write schedules/transfers.js ─────────────────────────────────────────
    # Only keep transfers where both endpoints are known stops
    filtered_xfers = {}
    for sid, xfers in all_transfers.items():
        valid = [x for x in xfers if x['to'] in all_stops]
        if valid:
            filtered_xfers[sid] = valid

    with open('schedules/transfers.js', 'w') as f:
        f.write('gtfs_transfers = ' + json.dumps(filtered_xfers))
    print('Generated schedules/transfers.js')

    # ── Write schedule event files ───────────────────────────────────────────
    # Use representative (single-day) IDs for events so we don't multiply
    # event counts when an agency publishes per-calendar-day service IDs.
    sid_map = {
        'weekday': all_rep_weekday_sids,
        'weekend': all_rep_weekend_sids,
    }

    for (name, day_type, start_h, end_h) in SCHEDULE_CONFIGS:
        service_ids = sid_map[day_type]
        min_t = start_h * HOURS
        max_t = end_h * HOURS
        events = []

        for tid, trip_events in all_stop_times.items():
            trip = all_trips.get(tid)
            if not trip or trip['service_id'] not in service_ids:
                continue
            route = all_routes.get(trip['route_id'])
            route_name = route['short_name'] if route else ''
            for e in trip_events:
                if min_t <= e['time'] <= max_t:
                    events.append({
                        'time': e['time'],
                        'trip_id': tid,
                        'stop_id': e['stop_id'],
                        'route_name': route_name,
                    })

        events.sort(key=lambda x: x['time'])
        path = f'schedules/{name}.json'
        with open(path, 'w') as f:
            json.dump({'events': events, 'start_time': min_t}, f)
        print(f'Generated {path}  ({len(events):,} events)')

    print('\nAll done! Serve the project with:')
    print('  python3 -m http.server 8000')
    print('Then open http://localhost:8000')


if __name__ == '__main__':
    main()
