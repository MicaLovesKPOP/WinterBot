'use strict';

const fs = require('node:fs');
const path = require('node:path');

function validState(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.rounds)) throw new Error('Invalid WinterBot scheduling data schema.');
  for (const round of raw.rounds) {
    if (!round || typeof round.id !== 'string' || typeof round.title !== 'string' ||
      !['collecting','review','voting','final'].includes(round.phase) ||
      !Array.isArray(round.participants) || !round.availability ||
      !Array.isArray(round.candidates) || !Array.isArray(round.excludedCandidateIds) ||
      !Array.isArray(round.publications) || !round.startDate || !round.endDate || !round.timezone) {
      throw new Error('Scheduling round has invalid or incomplete fields.');
    }
    if (round.phase === 'voting' && (!round.ballot || !Array.isArray(round.ballot.options))) {
      throw new Error('Active ballot is missing or corrupt.');
    }
  }
  return raw;
}

function readState(file) {
  return validState(JSON.parse(fs.readFileSync(file, 'utf8')));
}

class SchedulingStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.backup = this.file + '.bak';
    this.queue = Promise.resolve();
    this.state = { version: 1, rounds: [] };
  }
  initialize() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const exists = fs.existsSync(this.file);
    const backupExists = fs.existsSync(this.backup);
    if (!exists && !backupExists) return;
    try {
      this.state = readState(this.file);
    } catch (error) {
      if (!backupExists) throw new Error('Scheduling state is missing or corrupt, without a valid backup: ' + error.message);
      try {
        this.state = readState(this.backup);
        if (exists) fs.renameSync(this.file, this.file + '.corrupt.' + Date.now());
        fs.copyFileSync(this.backup, this.file);
      } catch (backupError) {
        throw new Error('Scheduling state and backup are both unusable: ' + backupError.message);
      }
    }
  }
  read() {
    return structuredClone(this.state);
  }
  async transaction(modify) {
    const run = async () => {
      const next = structuredClone(this.state);
      const value = await modify(next);
      const tmp = this.file + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'w' });
      readState(tmp);
      try {
        if (fs.existsSync(this.file)) await fs.promises.copyFile(this.file, this.backup);
        await fs.promises.rename(tmp, this.file);
      } catch (error) {
        await fs.promises.unlink(tmp).catch(() => {});
        throw error;
      }
      this.state = next;
      return value;
    };
    const task = this.queue.then(run, run);
    this.queue = task.catch(() => {});
    return task;
  }
}

module.exports = { SchedulingStore };
