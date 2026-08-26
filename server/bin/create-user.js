#!/usr/bin/env node
/* =================================================================
   Create an admin user, or reset an existing one's password.

     npm run create-user -- you@example.com

   The password is read from the terminal with echo off, so it never
   lands in your shell history.
   ================================================================= */
'use strict';

const readline = require('readline');
const db = require('../lib/db');
const auth = require('../lib/auth');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      // Repaint the prompt without the typed characters.
      if (['\n', '\r', ''].includes(String(char))) return;
      readline.moveCursor(process.stdout, -1000, 0);
      readline.clearLine(process.stdout, 1);
      process.stdout.write(question);
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const email = (process.argv[2] || '').toLowerCase().trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('Usage: npm run create-user -- you@example.com');
    process.exit(1);
  }

  const existing = db.findUserByEmail(email);
  if (existing) {
    console.log(`${email} already exists — this will reset the password and sign out every device.`);
  }

  const password = await askHidden('Password (min 10 chars): ');
  if (password.length < 10) {
    console.error('Too short. Use at least 10 characters.');
    process.exit(1);
  }
  const again = await askHidden('Confirm: ');
  if (password !== again) {
    console.error('Passwords did not match.');
    process.exit(1);
  }

  const hash = auth.hashPassword(password);
  if (existing) {
    db.setPassword(existing.id, hash);
    console.log(`✓ Password reset for ${email}`);
  } else {
    db.createUser(email, hash);
    console.log(`✓ Created ${email}`);
  }
  console.log('  Sign in at /admin');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
