#!/usr/bin/env python3
"""Decode the approved CSIRO/SILO subset into an inspectable, idempotent SQL import.
Requires rasterio==1.4.3 and numpy. No network, database access, or source writes.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window, from_bounds, transform as window_transform, bounds as window_bounds


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def encode(value):
    return json.dumps(value, allow_nan=False, separators=(',', ':'))


def literal(value):
    if any(tag in value for tag in ['$import$', '$check$']):
        raise ValueError('Source contains a reserved SQL delimiter')
    return "'" + value.replace("'", "''") + "'"


def insert(table, rows):
    if not rows:
        return ''
    columns = ','.join(rows[0].keys())
    return f"insert into verdant.{table}({columns}) select {columns} from jsonb_populate_recordset(null::verdant.{table},{literal(encode(rows))}::jsonb);\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('handoff', type=Path)
    parser.add_argument('--environment', choices=['sandbox', 'production'], default='sandbox')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = args.handoff / 'workspace/research'
    inputs = root / 'perennial-backtest/grape/normalized-inputs.json'
    irrigation = root / 'perennial-demo/grape/vinelogic-recorded-irrigation.json'
    source = root / 'demo-datasets/shared/silo-australia-tmax-20030101.tif'
    spatial = json.loads((root / 'demo-datasets/grape/csiro-spatial-receipt.json').read_text())
    csiro_meta = json.loads((root / 'perennial-demo/grape/csiro-metadata.json').read_text())
    normalized = json.loads(inputs.read_text())
    rows = normalized['csiro']
    events = [r for r in json.loads(irrigation.read_text()) if r['dataset'] == 'WNRA0305']
    assert len(rows) == 9 and {r['harvest_year'] for r in rows} == {2003, 2004, 2005}
    for name, digest in normalized['sources']['csiro']['hashes'].items():
        assert sha(root / 'perennial-demo/grape' / name) == digest, f'Source hash mismatch: {name}'
    assert sha(inputs) == 'a0adaa43219570c637757f5b29edf94f007cd9e912f2853efcc3e8c6178bd9ad'
    for row in rows:
        water = sum(e['irrigation_mm'] for e in events if e['treatment_number'] == row['treatment_number'])
        assert math.isclose(water, row['recorded_irrigation_mm'], abs_tol=1e-8)
    transform_version = 'verdant-handoff-v1'
    # IDs are assigned after hashing canonical normalized output.
    csiro_id = 'pending'
    env = args.environment
    observations = []
    for row in rows:
        tr = row['treatment_number']
        program = ['C', 'RDI', 'PD'][(tr-1) % 3]
        dimensions = {'treatment_number': tr, 'program': program, 'harvest_year': row['harvest_year'],
                      'source_record': row, 'evidence_class': 'observed_program_replay'}
        for variable, value, unit in [('yield', row['YLFW'], 'kg/ha'), ('recorded_irrigation', row['recorded_irrigation_mm'], 'mm'),
                                      ('soluble_solids', row['BRIX'], 'degBrix')]:
            observations.append(dict(environment=env, dataset_version_id=csiro_id, id=f't{tr:02d}-{variable}',
                                     variable=variable, value=value, unit=unit, period_label=str(row['harvest_year']),
                                     observed_on=None, entity_id=f'WNRA0305-{tr}', dimensions=dimensions, quality_flags=[]))
    for i, event in enumerate(events):
        observations.append(dict(environment=env, dataset_version_id=csiro_id, id=f'irrigation-{i:04d}',
                                 variable='irrigation_event', value=event['irrigation_mm'], unit='mm', period_label=None,
                                 observed_on=event['date'], entity_id=f"WNRA0305-{event['treatment_number']}",
                                 dimensions=event, quality_flags=[]))
    csiro_hash = hashlib.sha256(encode({'observations': [{k:v for k,v in o.items() if k not in ('environment','dataset_version_id')} for o in observations], 'spatial_support':spatial['trial']}).encode()).hexdigest()
    csiro_id = 'csiro-wnra0305-' + hashlib.sha256((csiro_hash+transform_version).encode()).hexdigest()[:16]
    for observation in observations:
        observation['dataset_version_id'] = csiro_id
    # Trust dated source identity only after matching the immutable handoff manifest.
    selected = [inputs,irrigation,source,root/'demo-datasets/grape/csiro-spatial-receipt.json',root/'perennial-demo/grape/csiro-metadata.json']
    selected += [root/'perennial-demo/grape'/name for name in normalized['sources']['csiro']['hashes']]
    pending = {str(p.relative_to(args.handoff)):p for p in selected}
    with (args.handoff/'FILES.jsonl').open() as manifest:
        for line in manifest:
            record = json.loads(line)
            path = pending.pop(record['path'],None)
            if path:
                assert path.stat().st_size==record['bytes'] and sha(path)==record['sha256'], f'Handoff mismatch: {path}'
            if not pending:
                break
    assert not pending, f'Source missing from handoff manifest: {list(pending)}'
    csiro_manifest = [{'url': normalized['sources']['csiro']['url'], 'doi': '10.25919/j503-ft52', 'sha256': digest,
                       'member_path': name, 'license': 'CC-BY-4.0'} for name, digest in normalized['sources']['csiro']['hashes'].items()]
    csiro_manifest += [{'member_path':str(p.relative_to(root)), 'sha256':sha(p), 'role':'normalized input'} for p in [inputs,irrigation]]
    datasets = [dict(environment=env, id=csiro_id, dataset_key='csiro-wnra0305', title='CSIRO Mildura observed irrigation programs, 2003–2005',
                     content_sha256=csiro_hash, source_manifest=csiro_manifest, transform_version=transform_version, data_class='observation',
                     variables={'yield':'kg/ha','recorded_irrigation':'mm','soluble_solids':'degBrix','irrigation_event':'mm'},
                     temporal_resolution='seasonal outcomes and dated irrigation events', spatial_support=spatial['trial'],
                     period_start=min(e['date'] for e in events), period_end=max(e['date'] for e in events),
                     license='CC-BY-4.0', attribution=csiro_meta['attributionStatement'], access_level='demo',
                     metadata={'outcome_count':9,'irrigation_event_count':len(events),'observation_count':len(observations),
                               'limits':'Observed programs only; no causal effects inferred from weather pixels; no verified field boundary.'})]
    with rasterio.open(source) as ds:
        assert ds.crs.to_string() == 'EPSG:4326' and ds.dtypes == ('float32',)
        assert ds.units == ('Celsius',) and ds.scales == (1.0,) and ds.offsets == (0.0,)
        assert list(ds.transform)[:6] == [0.05,0.0,111.975,0.0,-0.05,-9.975]
        # Bounded regional context around Mildura; keep original grid cells unchanged.
        w = from_bounds(140, -36, 144, -32, ds.transform)
        c0, r0 = math.floor(w.col_off), math.floor(w.row_off)
        c1, r1 = math.ceil(w.col_off+w.width), math.ceil(w.row_off+w.height)
        win = Window(c0, r0, c1-c0, r1-r0)
        band = ds.read(1, window=win, masked=True)
        assert band.size <= 16384
        values = [None if masked else float(v) for v, masked in zip(band.data.flat, np.ma.getmaskarray(band).flat)]
        assert all(v is None or math.isfinite(v) for v in values)
        affine = list(window_transform(win, ds.transform))[:6]
        bbox = list(window_bounds(win, ds.transform))
        silo_hash = hashlib.sha256(encode({'cells':values,'transform':affine,'bbox':bbox,'shape':list(band.shape),'crs':'EPSG:4326','unit':'degC','variable':'air_temperature_max','date':'2003-01-01'}).encode()).hexdigest()
        silo_id = 'silo-tmax-20030101-' + hashlib.sha256((silo_hash+transform_version).encode()).hexdigest()[:16]
        tiles = [dict(environment=env, dataset_version_id=silo_id,id='mildura',variable='air_temperature_max',unit='degC',observed_on='2003-01-01',
                      width=band.shape[1],height=band.shape[0],crs='EPSG:4326',transform=affine,bbox=bbox,cells=values,source_window=[c0,r0,c1-c0,r1-r0])]
        datasets.append(dict(environment=env,id=silo_id,dataset_key='silo-tmax-mildura',title='SILO daily maximum temperature near Mildura, 1 January 2003',
                             content_sha256=silo_hash,source_manifest=[{'url':'https://www.longpaddock.qld.gov.au/silo/gridded-data/',
                             'member_path':str(source.relative_to(root)),'sha256':sha(source),'license':'CC-BY-4.0','source_tags':ds.tags()}],
                             transform_version=transform_version,data_class='interpolated_observation',variables={'air_temperature_max':'degC'},
                             temporal_resolution='daily',spatial_support={'crs':'EPSG:4326','resolution_degrees':0.05,'support':'native grid cell'},
                             bbox=bbox,period_start='2003-01-01',period_end='2003-01-01',license='CC-BY-4.0',
                             attribution='Queensland Government SILO; interpolated Bureau of Meteorology and other observations.',access_level='demo',
                             metadata={'source_dimensions':[ds.width,ds.height],'tile_count':1,'cell_count':len(values),'missing_count':values.count(None),
                                       'layout':'top-down row-major','missing_policy':'preserve as NULL','context_only':True}))
    # Existing published versions are verified, never rewritten (including on repeat imports).
    sql = 'begin;\nselect pg_advisory_xact_lock(hashtextextended(\'verdant-handoff-import\',0));\n'
    for d in datasets:
        obs = [r for r in observations if r['dataset_version_id']==d['id']]
        raster = [r for r in tiles if r['dataset_version_id']==d['id']]
        where = f"environment={literal(env)} and id={literal(d['id'])}"
        sql += f"do $import$ begin if not exists(select 1 from verdant.dataset_versions where {where}) then\n"
        sql += insert('dataset_versions',[d]) + insert('observations',obs) + insert('raster_tiles',raster)
        sql += f"update verdant.dataset_versions set status='published',published_at=now() where {where};\nend if; end $import$;\n"
        # Compare every decoded value and metadata field, not just a row count.
        for table, expected in [('dataset_versions',[d]),('observations',obs),('raster_tiles',raster)]:
            if not expected:
                continue
            columns = ','.join(expected[0])
            condition = where if table=='dataset_versions' else f"environment={literal(env)} and dataset_version_id={literal(d['id'])}"
            sql += f"do $check$ begin if exists((select {columns} from verdant.{table} where {condition} except select {columns} from jsonb_populate_recordset(null::verdant.{table},{literal(encode(expected))}::jsonb)) union all (select {columns} from jsonb_populate_recordset(null::verdant.{table},{literal(encode(expected))}::jsonb) except select {columns} from verdant.{table} where {condition})) then raise exception 'Import verification failed: {table}'; end if; end $check$;\n"
    sql += 'commit;\n'
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(sql)
    receipt={'environment':env,'dataset_ids':[d['id'] for d in datasets],'observations':len(observations),
             'irrigation_events':len(events),'raster_cells':len(values),'sql_sha256':sha(args.output),'source_hashes_verified':True}
    args.output.with_suffix('.json').write_text(json.dumps(receipt,indent=2)+'\n')
    args.output.with_suffix('.expected.json').write_text(encode({'datasets':datasets,'observations':observations,'tiles':tiles}))
    print(json.dumps(receipt))

if __name__ == '__main__':
    main()
