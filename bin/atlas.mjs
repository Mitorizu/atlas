#!/usr/bin/env node
// Entry point for the `atlas` command. Registers tsx so the TypeScript sources run
// directly, then hands off to the dispatcher.
import { register } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

register();
const { cli } = await import(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'atlas.ts'));
cli();
