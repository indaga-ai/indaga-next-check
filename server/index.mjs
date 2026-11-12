// Local server: `npm start`, then open http://localhost:8788.
// Without NEARAI_API_KEY it runs the whole flow with a local stand-in model (clearly marked on the page); the
// hardware attestation check still runs against NEAR AI Cloud's public endpoint. With the key, briefs come from the
// attested model.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHandler } from './handler.mjs';
import { StandIn } from './stand-in.mjs';
import { configFromEnv } from './config.mjs';

const cfg = configFromEnv(process.env);
const handler = createHandler({
  ...cfg,
  staticRoot: fileURLToPath(new URL('../web/', import.meta.url)),
  standIn: new StandIn(cfg.model),
});
const port = Number(process.env.PORT || 8788);
createServer(handler).listen(port, '127.0.0.1', () => {
  console.log(`Indaga Next Check on http://localhost:${port}`);
  console.log(`  model:     ${cfg.model}`);
  console.log(`  inference: ${cfg.apiKey ? 'NEAR AI Cloud (key set)' : 'local stand-in (no NEARAI_API_KEY); attestation is still checked live'}`);
});
