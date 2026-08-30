// Vercel serverless entry point. Vercel routes every matching request here and
// invokes the Express app. server.js skips app.listen() when process.env.VERCEL
// is "1" and exports the app at the bottom of the module — this file is the
// only thing Vercel needs to wrap.
import app from "../server.js";

export default app;
