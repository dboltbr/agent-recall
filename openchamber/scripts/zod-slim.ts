// Browser-bundle stand-in for `import { z } from "zod"`: the namespace import makes esbuild keep
// all of zod (every locale, ~450 KB). Re-exporting only the builders the release contract uses
// lets it shake the rest. Add a builder here when `core/release-status.ts` starts using one.
import { array, boolean, enum as enumOf, literal, number, object, string } from "zod";

export const z = { array, boolean, enum: enumOf, literal, number, object, string };
