'use strict';

const path = require('node:path');
const { createScheduler } = require('./server');

const scheduler = createScheduler({
  mode: 'demo',
  host: '127.0.0.1',
  port: Number(process.env.SCHEDULING_DEMO_PORT || 8791),
  dataFile: path.join(process.cwd(), 'scheduling-demo.json'),
});
scheduler.start().then(({ url }) => {
  console.log('WinterBot scheduling preview: ' + url);
  console.log('This is a local-only demo. No Discord messages or events can be created.');
}).catch(error => {
  console.error('Scheduler preview failed:', error);
  process.exitCode = 1;
});
process.on('SIGINT', () => scheduler.stop().then(() => process.exit(0)));
process.on('SIGTERM', () => scheduler.stop().then(() => process.exit(0)));
