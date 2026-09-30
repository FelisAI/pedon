"""The agent receives the current proposal's real pixels, never a stale preview."""
import base64
import json
import sys
from pathlib import Path
from types import SimpleNamespace
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import agent
import photoreal
import view_mcp


def test_photoreal_is_discoverable_in_the_existing_allowed_tool():
    tool = next(t for t in view_mcp.TOOLS if t['name'] == 'look')
    assert 'photoreal' in tool['inputSchema']['properties']['render']['enum']
    assert 'mcp__yardeye__look' in agent.MCP_TOOLS
    assert 'render="photoreal"' in agent.EXPLORE_BRIEF


def test_camera_uses_the_exported_world_frame_not_another_ground_lookup(monkeypatch):
    monkeypatch.setattr(photoreal, '_ground', lambda *a: pytest.fail('second ground lookup'))
    # Values from an arbitrary world-space camera, already including north yaw.
    result = photoreal.camera_from_view({'camera_world': {
        'eye': [12.3, 4.2, -7.1], 'look': [8.6, 3.9, -2.7], 'fov_deg': 51}})
    assert result['eye'] == [12.3, 7.1, 4.2]
    assert result['look'] == [8.6, 2.7, 3.9]
    assert result['fov_deg'] == 51


def test_photoreal_returns_inline_png_and_requires_a_fresh_export(monkeypatch, tmp_path):
    monkeypatch.setattr(photoreal, 'BLENDER', __file__)
    monkeypatch.setattr(view_mcp, 'CALL_LOG', str(tmp_path / 'calls'))
    from PIL import Image
    import io
    buffer = io.BytesIO()
    Image.new('RGB', (2, 2), (20, 50, 70)).save(buffer, format='PNG')
    image = buffer.getvalue()
    def run(argv, **kwargs):
        assert '--reuse-scene' not in argv
        request = json.loads(argv[argv.index('--view-json') + 1])
        assert request['eye'] == [1, 2, 1.65]
        assert request['look_at'] == [3, 4, 1.2]
        path = Path(argv[argv.index('--out') + 1])
        path.write_bytes(image)
        return SimpleNamespace(returncode=0, stdout=json.dumps({'ok': True, 'image':str(path)}))
    monkeypatch.setattr(photoreal, 'run_bounded', run)
    out = view_mcp.call_tool('look', {'render':'photoreal', 'eye':[1,2,1.65], 'look_at':[3,4,1.2]})
    block = out['content'][0]
    assert block['mimeType'] == 'image/png'
    assert base64.b64decode(block['data']) == image
    assert json.loads((tmp_path / 'calls').read_text().splitlines()[-1])['rendered'] is True


@pytest.mark.parametrize('reply', [{'ok': False, 'error':'Blender failed'}, {'ok': True}])
def test_failure_or_missing_image_cannot_pass_the_seeing_gate(monkeypatch, tmp_path, reply):
    monkeypatch.setattr(photoreal, 'BLENDER', __file__)
    monkeypatch.setattr(view_mcp, 'CALL_LOG', str(tmp_path / 'calls'))
    monkeypatch.setattr(photoreal, 'run_bounded', lambda *a, **k:
                        SimpleNamespace(returncode=0, stdout=json.dumps(reply)))
    out = view_mcp.call_tool('look', {'render':'photoreal', 'subject':'bed'})
    assert out['isError']
    assert not any(c['type'] == 'image' for c in out['content'])
    assert json.loads((tmp_path / 'calls').read_text().splitlines()[-1])['rendered'] is False


@pytest.mark.parametrize('quality', [None, 'fast', 'detailed'])
def test_stale_viewer_cannot_return_fast_preview_as_a_review(monkeypatch, tmp_path, quality):
    path = tmp_path / 'frame.jpg'; path.write_bytes(b'frame')
    monkeypatch.setattr(view_mcp, '_post', lambda *a, **k: {'ok': True, 'path':str(path), 'id':'test',
        'meta': {'render_quality': quality, 'growth':'mature'}})
    out = view_mcp.do_look({'subject':'bed'})
    assert bool(out.get('isError')) == (quality != 'detailed')


def test_named_photoreal_view_uses_owner_coordinates_unchanged(monkeypatch):
    vp = {'name':'Door', 'eye':[1,2,1.65], 'look_at':[3,4,1.2]}
    monkeypatch.setattr(view_mcp, 'saved_viewpoints', lambda: [vp])
    seen = {}
    monkeypatch.setattr(view_mcp, 'do_photoreal', lambda args: seen.update(args) or {})
    view_mcp.do_look({'viewpoint':'door', 'render':'photoreal'})
    assert seen['eye'] is vp['eye'] and seen['look_at'] is vp['look_at']


def test_codex_timeout_covers_the_whole_photoreal_call():
    config = agent.codex_mcp_args(str(Path(agent.ROOT) / '.mcp.json'))
    deadline = next(x for x in config if x.startswith('mcp_servers.yardeye.tool_timeout_sec='))
    assert int(deadline.split('=')[1]) > photoreal.REVIEW_TIMEOUT_S


def test_black_cycles_output_is_a_failed_look(monkeypatch, tmp_path):
    from PIL import Image
    monkeypatch.setattr(photoreal, 'BLENDER', __file__)
    monkeypatch.setattr(view_mcp, 'CALL_LOG', str(tmp_path / 'calls'))
    def run(argv, **kwargs):
        path = argv[argv.index('--out') + 1]
        Image.new('RGB', (2,2), (0,0,0)).save(path)
        return SimpleNamespace(returncode=0, stdout=json.dumps({'ok':True}))
    monkeypatch.setattr(photoreal, 'run_bounded', run)
    out = view_mcp.call_tool('look', {'render':'photoreal', 'subject':'bed'})
    assert out['isError']
    assert not any(c['type'] == 'image' for c in out['content'])


def test_cycles_uses_the_existing_instance_importer_without_specimen_measurement(monkeypatch):
    imported = []
    fake = SimpleNamespace(ops=SimpleNamespace(wm=SimpleNamespace(read_factory_settings=lambda **k:None)))
    monkeypatch.setitem(sys.modules, 'bpy', fake)
    monkeypatch.setitem(sys.modules, 'blender_plant_instances',
                        SimpleNamespace(import_instances=lambda path, **kw: imported.append((path, kw))))
    prefix = photoreal.BLENDER_SCRIPT.split('scene = bpy.context.scene')[0]
    assert 'import_instances' in prefix
    monkeypatch.setattr(sys, 'argv', ['blender','--', json.dumps({'glb':'proposal.glb', 'tools':'/tmp'})])
    original_path = sys.path[:]
    try:
        exec(prefix, {})
    finally:
        sys.path[:] = original_path
    from render_process import phase
    assert imported == [('proposal.glb', {'measure':False, 'realize':True, 'progress':phase})]


def test_unconfirmed_export_is_cleaned_up_without_starting_blender(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(photoreal, 'OUT_DIR', str(tmp_path))
    snapshot = tmp_path / 'scene_test.glb'; snapshot.write_bytes(b'geometry')
    monkeypatch.setattr(photoreal, 'export_scene', lambda *a, **k: (str(snapshot), {}))
    monkeypatch.setattr(photoreal, 'run_bounded', lambda *a, **k: pytest.fail('unconfirmed export'))
    assert photoreal.main(['--view-json','{"subject":"bed"}']) == 1
    assert not snapshot.exists()
    assert 'full-detail' in capsys.readouterr().out


def test_capture_clock_uses_the_dates_local_offset(monkeypatch):
    import os
    import time
    previous = os.environ.get('TZ')
    try:
        monkeypatch.setenv('TZ', 'America/Los_Angeles'); time.tzset()
        for day, expected in [('2026-08-24', -7), ('2026-01-24', -8)]:
            argv = photoreal.sun_position_args((day, '17:17'))
            assert argv[argv.index('--time') + 1] == '17:17'
            assert float(argv[argv.index('--utc-offset') + 1]) == expected
    finally:
        if previous is None: os.environ.pop('TZ', None)
        else: os.environ['TZ'] = previous
        time.tzset()
