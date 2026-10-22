import { createApp } from "./app.js";

await createApp().listen({ port: 3000 });
console.log("listening on http://localhost:3000");
