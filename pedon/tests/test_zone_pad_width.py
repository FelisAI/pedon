"""The design brief states how wide a level pad can be in each zone. analyze_site.py measures that
width against the site's limits at the survey and records them; the brief rescales from THOSE to
the limits it quotes. Rescaling from the defaults instead doubled the width on a site whose
retaining limit is twice the default."""
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import agent          # noqa: E402
import analyze_site   # noqa: E402


def zone_on_a_slope(site):
    """A 7 x 7 m zone falling 0.25 m per metre, surveyed by analyze_site itself."""
    cells = [(x * 1.0, y * 1.0, y * 0.25) for x in range(8) for y in range(8)]
    rows = [[y * 0.25 for _x in range(8)] for y in range(7, -1, -1)]
    grid = analyze_site.Grid({"cell_m": 1, "x0": 0, "x1": 7, "y0": 0, "y1": 7,
                              "rows": rows, "scanned_cells": 64, "total_cells": 64})
    return analyze_site.summarise_zone("z", cells, grid, site)


def stated(site, zone):
    text = agent.zone_facts({**site, "zones": [zone]}, agent.constraints(site))
    return (float(re.search(r"at most ([\d.]+) m ACROSS", text).group(1)),
            float(re.search(r"about ([\d.]+) m if", text).group(1)))


def limits(retain):
    return {"constraints": {"retain_limit_m": retain, "footing_threshold_m": retain / 2}}


@pytest.mark.parametrize("retain", [1.2, 2.4, 0.8])
def test_the_brief_quotes_the_width_the_survey_measured(retain):
    site = limits(retain)
    zone = zone_on_a_slope(site)
    assert "max_level_pad_width_m" in zone, "the synthetic zone is too flat to quote a pad width"
    assert stated(site, zone) == (zone["max_level_pad_width_m"], zone["easy_level_pad_width_m"])


def test_limits_changed_after_the_survey_rescale_from_the_surveyed_ones():
    zone = zone_on_a_slope(limits(2.4))              # surveyed with a 2.4 m retaining limit
    now = limits(1.2)                                 # the limit was halved since
    most, easy = stated(now, zone)
    assert most == pytest.approx(zone["max_level_pad_width_m"] / 2, abs=0.1)
    assert easy == pytest.approx(zone["easy_level_pad_width_m"] / 2, abs=0.1)
