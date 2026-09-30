"""A zone is named for where it truly faces. The scan grid is the capture's frame: a stored
bearing is true only after the yaw (true = stored - yaw, tools/sun.py). Naming zones by the
stored axes would call the yard north of the house "east_yard" on a capture turned 90 deg —
a fault invisible on any site where north has not been set."""
import analyze_site


def _grid_round_a_house():
    """A 21 x 21 m flat scan with a 5 x 5 m unscanned house in the middle."""
    rows = []
    for y in range(10, -11, -1):                     # north row first, as the viewer writes it
        rows.append([None if -2 <= x <= 2 and -2 <= y <= 2 else 0.0 for x in range(-10, 11)])
    return {"cell_m": 1, "x0": -10, "x1": 10, "y0": -10, "y1": 10, "rows": rows,
            "scanned_cells": sum(v is not None for r in rows for v in r), "total_cells": 21 * 21}


def _name_of_side(derived, x, y):
    for z in derived["zones"]:
        b = z["bounds_m"]
        if b["x"][0] <= x <= b["x"][1] and b["y"][0] <= y <= b["y"][1]:
            return z["zone"]


def test_at_yaw_zero_the_stored_axes_are_the_compass():
    d, building = analyze_site.derive(_grid_round_a_house(), {}, 1, oriented=True, yaw_deg=0)
    assert building, "the unscanned house was not found"
    assert _name_of_side(d, 8, 0) == "east_yard" and _name_of_side(d, 0, 8) == "north_yard"


def test_a_capture_turned_90_deg_names_each_side_where_it_truly_faces():
    # yaw 90: the stored +x axis (stored bearing 90) truly faces 90 - 90 = 0, north
    d, _ = analyze_site.derive(_grid_round_a_house(), {}, 1, oriented=True, yaw_deg=90)
    assert _name_of_side(d, 8, 0) == "north_yard", [z["zone"] for z in d["zones"]]
    assert _name_of_side(d, 0, 8) == "west_yard"          # stored 0 -> true 270
    assert _name_of_side(d, -8, 0) == "south_yard" and _name_of_side(d, 0, -8) == "east_yard"


def test_any_yaw_gives_four_different_names():
    for yaw in range(0, 360, 7):
        assert len(set(analyze_site.side_names(True, yaw))) == 4, yaw


def test_without_north_the_sides_say_they_are_the_scan_s_axes():
    assert analyze_site.side_names(False, 90) == analyze_site.UNORIENTED
