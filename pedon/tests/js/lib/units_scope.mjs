// THE FORMATTER, HANDED TO A SLICED BLOCK OF main.js. The ui_* tests run pure blocks of main.js
// in a `new Function` sandbox; blocks that show a size ask units.js, under the names main.js
// imports it by. They get the REAL functions, never a copy — a copy is the second owner of the
// conversion that units.test.mjs forbids.
import { len, small, area, pair, span, size, parseLen, lenField, lengthUnit, units } from
  "../../../viewer/src/shell/units.js";

export const UNIT_NAMES = ["fmtLen", "fmtSmall", "fmtArea", "sizePair", "sizeSpan", "plantSize", "parseLen",
                           "lenField", "lengthUnit", "displayUnits"];
export const UNIT_FNS = [len, small, area, pair, span, size, parseLen, lenField, lengthUnit, units];
