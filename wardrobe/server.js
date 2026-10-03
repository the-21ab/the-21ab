import path from 'node:path';
import { createApp } from './src/app.js';

const env = process.env;
const port = Number(env.PORT) || 3000;
const host = env.HOST || '0.0.0.0';

const app = createApp({
  dataDir: path.resolve(env.DATA_DIR || 'data'),
  adminToken: env.ADMIN_TOKEN,
  publicKey: env.PUBLIC_KEY,
  publicUrl: env.PUBLIC_URL,
  maxUploadBytes: env.MAX_UPLOAD_MB ? Number(env.MAX_UPLOAD_MB) * 1024 * 1024 : undefined,
  siteName: env.SITE_NAME,
});

app.server.listen(port, host, () => {
  const local = `http://localhost:${port}`;
  console.log(`Wardrobe is running at ${env.PUBLIC_URL || local}`);
  console.log(`  data folder:  ${app.config.dataDir}`);
  if (app.adminTokenGenerated) {
    console.log(`  owner password (made for you, saved in ${app.adminTokenFile}):`);
    console.log(`    ${app.adminToken}`);
  } else if (app.adminTokenFile) {
    console.log(`  owner password: saved in ${app.adminTokenFile}`);
  }
  console.log(app.config.publicKey ? '  feed is private: share links include ?key=' : '  feed is public: anyone with the link can read it');
});

function shutdown(signal) {
  console.log(`${signal} received, closing`);
  app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
