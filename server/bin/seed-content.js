#!/usr/bin/env node
/* =================================================================
   Load content.json from the repo into the database as version 1.

     npm run seed

   The server already falls back to the file when the table is empty,
   so this is only needed if you want the seed to appear in version
   history — or to re-import after editing the file by hand.
   ================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

const file = process.env.SEED_FILE || path.join(__dirname, '..', '..', 'content.json');

let data;
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`Could not read ${file}: ${err.message}`);
  process.exit(1);
}

if (!data.reel || !data.projects) {
  console.error('That file does not look like site content (no reel/projects).');
  process.exit(1);
}

const current = db.getLatestContent();
if (current && JSON.stringify(current.data) === JSON.stringify(data)) {
  console.log('Database already matches content.json — nothing to do.');
  process.exit(0);
}

const id = db.saveContent(data, 'seed', 'imported from content.json');
console.log(`✓ Imported content.json as version #${id}`);
