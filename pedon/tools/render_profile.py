"""Read an export's geometry cost without loading its binary buffers or Blender.

    python3 tools/render_profile.py data/photoreal/scene.glb --out /tmp/scene-cost.json

These are exported triangle counts before visibility culling, not GPU draw stats
or an estimate of Blender's memory. The render monitor measures memory separately.
"""
import argparse
import json
from pathlib import Path
import struct
import sys
import tempfile


def probe_import(path, *, realize, profile_path):
    """Compare exact instancing with realization, without ever starting Cycles."""
    from photoreal import BLENDER, ROOT, OUT_DIR
    from render_process import run_bounded, render_slot
    script = '''
import bpy,json,sys
cfg=json.loads(sys.argv[sys.argv.index('--')+1])
sys.path.insert(0,cfg['tools'])
from render_process import phase
from blender_plant_instances import import_instances
bpy.ops.wm.read_factory_settings(use_empty=True)
phase('blender_ready')
import_instances(cfg['path'], measure=False, realize=cfg['realize'], progress=phase)
phase('import_complete')
'''
    with render_slot(OUT_DIR), tempfile.NamedTemporaryFile('w', suffix='.py') as temporary:
        temporary.write(script)
        temporary.flush()
        result = run_bounded([BLENDER, '-b', '--python-exit-code', '1', '-P', temporary.name, '--',
                              json.dumps({'tools': str(Path(__file__).resolve().parent),
                                          'path': str(Path(path).resolve()), 'realize': realize})],
                             cwd=ROOT, timeout=180, profile_path=profile_path)
    if result.returncode:
        raise RuntimeError(f'Import failed: {result.stderr[-1000:]}')


def scene_cost(path):
    with open(path, 'rb') as source:
        header = source.read(20)
        magic, version, length, size, kind = struct.unpack('<4sIII4s', header)
        if magic != b'glTF' or version != 2 or kind != b'JSON':
            raise ValueError('Expected a binary glTF 2 scene')
        if size > length - 20 or length != Path(path).stat().st_size:
            raise ValueError('Truncated or invalid GLB')
        doc = json.loads(source.read(size))
    accessors = doc.get('accessors', [])
    meshes = doc.get('meshes', [])
    nodes = doc.get('nodes', [])
    parents = {child: i for i, node in enumerate(nodes) for child in node.get('children', [])}

    def triangles(primitive):
        index = primitive.get('indices', primitive['attributes']['POSITION'])
        count = accessors[index]['count']
        mode = primitive.get('mode', 4)
        return count // 3 if mode == 4 else max(0, count - 2) if mode in (5, 6) else 0

    costs = [sum(triangles(p) for p in mesh['primitives']) for mesh in meshes]
    rows = []
    for i, node in enumerate(nodes):
        if 'mesh' not in node:
            continue
        attrs = node.get('extensions', {}).get('EXT_mesh_gpu_instancing', {}).get('attributes', {})
        counts = {accessors[a]['count'] for a in attrs.values()}
        if len(counts) > 1:
            raise ValueError(f'Inconsistent instance attribute counts on node {i}')
        count = next(iter(counts)) if counts else 1
        ancestry, current = [], i
        while True:
            ancestor = nodes[current]
            extras = ancestor.get('extras', {})
            ancestry.append({'node': current, 'name': ancestor.get('name', ''),
                             **{k: extras[k] for k in ('id', 'species', 'kind') if k in extras}})
            if current not in parents:
                break
            current = parents[current]
        rows.append({'node': i, 'name': node.get('name', ''), 'mesh': node['mesh'],
                     'instances': count if attrs else 0,
                     'prototype_triangles': costs[node['mesh']],
                     'expanded_triangles': costs[node['mesh']] * count,
                     'ancestry': list(reversed(ancestry))})
    views = doc.get('bufferViews', [])
    image_views = {im['bufferView'] for im in doc.get('images', []) if 'bufferView' in im}
    used_meshes = {row['mesh'] for row in rows}
    return {'source': str(Path(path).resolve()), 'file_bytes': length,
            'json_bytes_read': size, 'mesh_nodes': len(rows), 'unique_meshes': len(used_meshes),
            'unique_mesh_triangles': sum(costs[i] for i in used_meshes),
            'instances': sum(row['instances'] for row in rows),
            'expanded_triangles': sum(row['expanded_triangles'] for row in rows),
            'embedded_image_bytes': sum(views[i]['byteLength'] for i in image_views),
            'external_images': sum('uri' in im for im in doc.get('images', [])),
            'nodes': sorted(rows, key=lambda row: row['expanded_triangles'], reverse=True),
            'scope': 'All exported mesh nodes, before camera culling; compressed image bytes, not decoded texture memory.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('glb')
    parser.add_argument('--out')
    parser.add_argument('--probe-import', choices=['native', 'realized'],
                        help='Bounded Blender import only; compare representations without starting Cycles')
    parser.add_argument('--memory-out', help='Memory report for --probe-import (required with it)')
    args = parser.parse_args()
    if args.probe_import and not args.memory_out:
        parser.error('--probe-import requires --memory-out')
    try:
        report = scene_cost(args.glb)
        if args.out:
            Path(args.out).write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({**report, 'nodes': report['nodes'][:12]}, indent=2))
        if args.probe_import:
            probe_import(args.glb, realize=args.probe_import == 'realized', profile_path=args.memory_out)
    except (RuntimeError, OSError, ValueError, struct.error, KeyError, IndexError) as error:
        print(json.dumps({'error': str(error),
                          **({'profile': args.memory_out} if args.probe_import else {})}))
        sys.exit(1)
