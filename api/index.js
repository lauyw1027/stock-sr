import { createRequire } from "module";
const require = createRequire(import.meta.url);
const app = require("../dist/index.cjs");
export default app;
