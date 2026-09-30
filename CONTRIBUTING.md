# Contributing to PEDON

Thank you for helping. PEDON designs gardens on a measured scan of real ground, so most of what
matters here is being right about the ground, the frames and the numbers — and knowing you are.

## Set up

```bash
cd pedon/viewer && npm install          # Node 20+
pip install -r pedon/requirements.txt   # Python 3.9+
cd pedon/viewer && npm run dev          # http://localhost:5178 — open the demo garden
```

`README.md` walks through starting a site of your own. No API keys are needed or wanted:
the design agent runs on a CLI you are logged in to (`claude` or `codex`).

## Before you change anything

Read `AGENTS.md` — it is short, and it is the entry point for people and agents alike. It holds
the rules that do not change (one write path for every design change, physical facts enforced and
taste only reported, code measures and the model decides, owner ground truth is never generated)
and an index of which document to open for the work you are doing.

## Tests

```bash
python3 pedon/tools/selftest.py
```

Both halves — Python and the viewer — in about two minutes, with no viewer running and no network.
A fresh checkout runs the app's tests against a small fixture library; the tests about a real
measured site, or about your own library, skip until you have one. Run it before and after your
change, and:

- **See a new test fail first.** Break the code it guards, watch it go red, then put the code back.
  A test that has never been red has not been shown to test anything.
- **Test at a non-zero yaw.** The site frame and the world frame are identical until north is set,
  so a frame bug is invisible at yaw 0. The demo garden has north set at 25°.
- **Look at a UI change in the running viewer** — the whole screen, clicked — not only in source.

## Where your change goes

- Code, tools, validators, docs: this repository.
- Anything *made along the way* for a site — a plant or object model, a texture, a reference
  photograph, a species builder, catalogue rows — belongs to the user's library
  (`~/PEDON/library`), never to this repository. `pedon/docs/library.md` says what each item
  must record about where it came from and on what licence.
- A site's own files live in `~/PEDON/<site>/` and are never committed.
- Code from elsewhere keeps its notice and must be under a licence that can join AGPL-3.0:
  MIT, BSD, Apache-2.0, LGPL or GPL-3.0 — not GPL-2.0-only.

## Pull requests

Keep a change to one idea, say what you measured, and include the test you saw fail. If an
investigation shows the requested approach is wrong, say so in the pull request rather than
building something else instead.

## Licence

PEDON is licensed under the GNU Affero General Public License, version 3 only (`LICENSE`).
By opening a pull request you agree that your contribution is licensed under the same terms.
