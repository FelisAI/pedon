"""Native QA of EXT_mesh_gpu_instancing without expanding the geometry.

Blender 5.2's importer creates an object for every extension instance and ignores
_COLOR_0. Import the prototypes, then use Geometry Nodes instance-on-points with
exact TRS and shader instancer colors. No instance is sampled out or simplified.
Axis conversion follows Blender's bundled glTF importer (blender_gltf.py).
"""
import json
import mmap
import struct
import tempfile
from pathlib import Path
import bpy
import numpy as np
from mathutils import Vector, Quaternion, Matrix


def import_instances(path, measure=True, realize=False, progress=None):
    progress = progress or (lambda *args, **kwargs: None)
    progress('read_export')
    with open(path, 'rb') as source:
        data = mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ)
    size, kind = struct.unpack_from('<I4s', data, 12)
    assert kind == b'JSON'
    gltf = json.loads(data[20:20 + size])
    binary = memoryview(data)[28 + size:]

    def accessor(index):
        a = gltf['accessors'][index]
        assert a['componentType'] == 5126 and not a.get('sparse'), 'expected dense float instance attributes'
        n = {'VEC3': 3, 'VEC4': 4}[a['type']]
        view = gltf['bufferViews'][a['bufferView']]
        offset = view.get('byteOffset', 0) + a.get('byteOffset', 0)
        stride = view.get('byteStride', n * 4)
        # Views over the exported bytes, not millions of Python float tuples.
        return np.ndarray((a['count'], n), dtype='<f4', buffer=binary,
                          offset=offset, strides=(stride, 4))

    instances = []
    for i, node in enumerate(gltf.get('nodes', [])):
        ext = node.get('extensions', {}).pop('EXT_mesh_gpu_instancing', None)
        if ext:
            node['name'] = f'qa_prototype_{i}'
            attrs = {key: accessor(index) for key, index in ext['attributes'].items()}
            instances.append((node['name'], attrs))
    for key in ('extensionsUsed', 'extensionsRequired'):
        if key in gltf:
            gltf[key] = [x for x in gltf[key] if x != 'EXT_mesh_gpu_instancing']
    content = json.dumps(gltf, separators=(',', ':')).encode()
    content += b' ' * (-len(content) % 4)
    with tempfile.NamedTemporaryFile(suffix='.glb') as temp:
        # A real garden can be well over a gigabyte. Concatenating it repeatedly
        # consumes the memory budget before Blender has even begun importing geometry.
        temp.write(struct.pack('<4sII', b'glTF', 2, 28 + len(content) + len(binary)))
        temp.write(struct.pack('<I4s', len(content), b'JSON')); temp.write(content)
        temp.write(struct.pack('<I4s', len(binary), b'BIN\0')); temp.write(binary)
        temp.flush()
        progress('import_prototypes', instance_batches=len(instances), realize=realize)
        bpy.ops.import_scene.gltf(filepath=temp.name)
    del data, binary
    progress('prototype_dependency_update')
    bpy.context.view_layer.update()
    progress('build_instance_points')
    bounds = []
    prototypes = {name for name, _ in instances}
    for obj in bpy.context.scene.objects:
        if measure and obj.type == 'MESH' and obj.name not in prototypes:
            bounds.extend(obj.matrix_world @ Vector(p) for p in obj.bound_box)
    total = 0
    last_report = 0
    material_cache = {}
    for name, attrs in instances:
        proto = bpy.data.objects[name]
        world = proto.matrix_world.copy()
        count = len(next(iter(attrs.values())))
        assert all(len(values) == count for values in attrs.values())
        trans = attrs.get('TRANSLATION', [(0, 0, 0)] * count)
        quats = attrs.get('ROTATION', [(0, 0, 0, 1)] * count)
        scales = attrs.get('SCALE', [(1, 1, 1)] * count)
        colors = attrs.get('_COLOR_0', [(1, 1, 1)] * count)
        locations = [(t[0], -t[2], t[1]) for t in trans]
        rotations = [Quaternion((q[3], q[0], -q[2], q[1])) for q in quats]
        scale = [(s[0], s[2], s[1]) for s in scales]
        corners = [Vector(p) for p in proto.bound_box]
        low = Vector((float('inf'),) * 3); high = -low
        # Garden cameras already arrive from the viewer. Walking eight corners
        # for each of millions of needles is useful specimen QA, not framing.
        for t, q, s in (zip(locations, rotations, scale) if measure else []):
            m = world @ Matrix.LocRotScale(Vector(t), q, Vector(s))
            for p in corners:
                v = m @ p
                for axis in range(3):
                    low[axis] = min(low[axis], v[axis]); high[axis] = max(high[axis], v[axis])
        if measure:
            bounds.extend((low, high))
        mesh = bpy.data.meshes.new(name + '_points')
        mesh.from_pydata(locations, [], [])
        for key, values in [('qa_rotation', [q.to_euler() for q in rotations]), ('qa_scale', scale)]:
            a = mesh.attributes.new(key, 'FLOAT_VECTOR', 'POINT')
            a.data.foreach_set('vector', [v for row in values for v in row])
        a = mesh.attributes.new('qa_color', 'FLOAT_COLOR', 'POINT')
        a.data.foreach_set('color', [v for row in colors for v in (*row[:3], 1)])
        obj = bpy.data.objects.new(name + '_instances', mesh)
        bpy.context.collection.objects.link(obj); obj.matrix_world = world
        # Object Info supplies prototype local geometry, without its scene transform.
        proto.parent = None; proto.matrix_world = Matrix.Identity(4); proto.hide_render = True
        tree = bpy.data.node_groups.new(name + '_instances', 'GeometryNodeTree')
        tree.interface.new_socket(name='Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
        tree.interface.new_socket(name='Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
        incoming = tree.nodes.new('NodeGroupInput'); outgoing = tree.nodes.new('NodeGroupOutput')
        info = tree.nodes.new('GeometryNodeObjectInfo'); info.transform_space = 'ORIGINAL'; info.inputs['Object'].default_value = proto
        inst = tree.nodes.new('GeometryNodeInstanceOnPoints')
        tree.links.new(incoming.outputs['Geometry'], inst.inputs['Points'])
        tree.links.new(info.outputs['Geometry'], inst.inputs['Instance'])
        for key, socket in [('qa_rotation', 'Rotation'), ('qa_scale', 'Scale')]:
            a = tree.nodes.new('GeometryNodeInputNamedAttribute'); a.data_type = 'FLOAT_VECTOR'; a.inputs['Name'].default_value = key
            tree.links.new(a.outputs['Attribute'], inst.inputs[socket])
        if realize:
            # Millions of two-triangle needles are cheap geometry but very
            # expensive Cycles objects. Join each batch without dropping a leaf.
            joined = tree.nodes.new('GeometryNodeRealizeInstances')
            tree.links.new(inst.outputs['Instances'], joined.inputs['Geometry'])
            tree.links.new(joined.outputs['Geometry'], outgoing.inputs['Geometry'])
        else:
            tree.links.new(inst.outputs['Instances'], outgoing.inputs['Geometry'])
        modifier = obj.modifiers.new('Exact exported plant instances', 'NODES'); modifier.node_group = tree
        for slot in proto.material_slots:
            original = slot.material
            if original.name not in material_cache:
                mat = original.copy(); material_cache[original.name] = mat
                nodes = mat.node_tree.nodes; links = mat.node_tree.links
                shader = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
                color = shader.inputs['Base Color']
                mix = nodes.new('ShaderNodeMixRGB'); mix.blend_type = 'MULTIPLY'; mix.inputs[0].default_value = 1
                if color.is_linked: links.new(color.links[0].from_socket, mix.inputs[1])
                else: mix.inputs[1].default_value = color.default_value
                attr = nodes.new('ShaderNodeAttribute'); attr.attribute_type = 'GEOMETRY' if realize else 'INSTANCER'; attr.attribute_name = 'qa_color'
                links.new(attr.outputs['Color'], mix.inputs[2]); links.new(mix.outputs[0], color)
            slot.material = material_cache[original.name]
        total += count
        print('NATIVE_INSTANCES', name, count, flush=True)
        if total - last_report >= 250000:
            progress('build_instance_points', completed_instances=total, last_batch=name)
            last_report = total
    progress('evaluate_instances', source_instances=total, realize=realize)
    bpy.context.view_layer.update()
    progress('instances_evaluated', source_instances=total, realize=realize)
    evaluated = (sum(1 for instance in bpy.context.evaluated_depsgraph_get().object_instances if instance.is_instance)
                 if measure and not realize else None)
    if measure and not realize:
        assert evaluated == total, f'Native instance loss: {evaluated} != {total}'
    report = {'source_instances': total, 'evaluated_instances': evaluated, 'batches': len(instances), 'per_instance_color': True}
    Path(path).with_suffix('.native-instances.json').write_text(json.dumps(report, indent=2) + '\n')
    return bounds
