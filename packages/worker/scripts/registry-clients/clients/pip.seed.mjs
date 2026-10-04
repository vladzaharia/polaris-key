/** The PyPI fixture (F-05), shared by the pip, uv and Poetry clients; seeded once per state. */
import { seedPypi } from "../pypi-fixture.mjs";

await seedPypi(process.env.STATE);
