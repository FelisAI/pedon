// Tests about a REAL, measured site read the reference site (tools/project.py test_site),
// which tools/selftest.py pins for the run. Without one — a fresh checkout — they skip,
// as their python counterparts do (tests/conftest.py, `needs_site`).
import fs from "node:fs";
import { dataPath } from "../../../viewer/project_paths.js";

export const HAS_SITE = fs.existsSync(dataPath("site.json"));
export const needsSite = HAS_SITE ? {} : { skip: "about a real site: set PEDON_TEST_SITE (or ~/PEDON/.test_site) to one" };
