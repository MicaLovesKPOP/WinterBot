'use strict';

// Reproducibly bundle the official Discord Embedded App SDK with the Activity.
// This is a developer-only build step; DiscordBotHosting serves the committed
// static file without requiring build tools or npm install scripts at runtime.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const esbuild=require('esbuild');

const ROOT=path.resolve(__dirname,'..');
const source=path.join(ROOT,'src/scheduling/activity-client/main.js');
const output=path.join(ROOT,'src/scheduling/activity-public/activity.js');
const hash=crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');

esbuild.build({
  entryPoints:[source],
  outfile:output,
  bundle:true,
  platform:'browser',
  format:'iife',
  target:'es2020',
  minify:true,
  // Preserve bundled SDK/dependency license notices in the generated asset.
  legalComments:'eof',
  banner:{js:'/* WinterBot Activity source SHA256: '+hash+' */'},
  logLevel:'warning',
}).then(()=>{
  console.log('Built WinterBot Discord Activity ('+fs.statSync(output).size+' bytes).');
}).catch(error=>{
  console.error(error);
  process.exitCode=1;
});
