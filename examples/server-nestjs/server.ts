import { createApp } from "./app.js";

const app = await createApp();
await app.listen(3000);
console.log("listening on http://localhost:3000");
