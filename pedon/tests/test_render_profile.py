"""Count shared exported geometry, not an accumulated renderer counter."""
import json
import struct
import pytest
from render_profile import scene_cost


def write_scene(path, doc):
    data = json.dumps(doc).encode()
    data += b' ' * (-len(data) % 4)
    path.write_bytes(struct.pack('<4sIII4s', b'glTF', 2, 20 + len(data), len(data), b'JSON') + data)


def test_shared_meshes_instances_and_nontriangle_modes(tmp_path):
    source = tmp_path / 'scene.glb'
    doc = {'accessors': [{'count': 6}, {'count': 5}, {'count': 100}],
           'meshes': [{'primitives': [{'attributes': {'POSITION': 0}},
                                      {'attributes': {'POSITION': 1}, 'mode': 5},
                                      {'attributes': {'POSITION': 0}, 'mode': 1}]}],
           'nodes': [{'children': [1, 2], 'extras': {'species': 'test grass', 'id': 'p1',
                                                    'leafAttachments': ['not part of a memory report']}},
                     {'mesh': 0, 'extensions': {'EXT_mesh_gpu_instancing': {'attributes': {'TRANSLATION': 2}}}},
                     {'mesh': 0}]}
    write_scene(source, doc)
    report = scene_cost(source)
    assert report['unique_mesh_triangles'] == 5
    assert report['expanded_triangles'] == 505
    assert report['instances'] == 100
    assert report['nodes'][0]['ancestry'][0] == {'node': 0, 'name': '', 'species': 'test grass', 'id': 'p1'}


def test_rejects_truncated_export_and_disagreeing_instance_attributes(tmp_path):
    source = tmp_path / 'scene.glb'
    doc = {'accessors': [{'count': 3}, {'count': 10}],
           'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}],
           'nodes': [{'mesh': 0, 'extensions': {'EXT_mesh_gpu_instancing': {
               'attributes': {'TRANSLATION': 0, 'SCALE': 1}}}}]}
    write_scene(source, doc)
    with pytest.raises(ValueError, match='Inconsistent'):
        scene_cost(source)
    source.write_bytes(source.read_bytes()[:-4])
    with pytest.raises(ValueError, match='Truncated'):
        scene_cost(source)
