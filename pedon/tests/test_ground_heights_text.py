"""The brief's ground grid says which way its rows run — and says it TRUE. A label of
"south->north" over a grid written north row first makes a model reading it flip the site."""
import agent


def test_the_brief_names_the_row_it_shows_first_by_where_it_is():
    # a grid whose north edge (y = 4) is 3 m high and whose south edge (y = 0) is at 0: the row
    # the brief prints first must be the one it says is first
    tp = {"cell_m": 2, "x0": 0, "x1": 2, "y0": 0, "y1": 4, "min_m": 0.0, "max_m": 3.0,
          "rows": [["  3.0", "  3.0"], ["  1.5", "  1.5"], ["  0.0", "  0.0"]]}
    text = agent.ground_heights_text(tp)
    grid = [line for line in text.splitlines() if line.strip() and line.split()[0].replace(".", "").isdigit()]
    assert grid[0].split() == ["3.0", "3.0"], grid
    assert "rows run north->south" in text and "first row is y = 4" in text, text


def test_it_is_what_the_reader_reads(monkeypatch):
    # filled_at, the grid's one reader in code, finds the north edge on the first row
    tp = {"cell_m": 2, "x0": 0, "x1": 2, "y0": 0, "y1": 4, "min_m": 0.0, "max_m": 3.0,
          "rows": [["  3.0", "  3.0"], ["  1.5", "  1.5"], ["  0.0", "  0.0"]]}
    monkeypatch.setattr(agent, "_TERRAIN", tp)
    assert agent.filled_at(0, 4) == 3.0 and agent.filled_at(0, 0) == 0.0
