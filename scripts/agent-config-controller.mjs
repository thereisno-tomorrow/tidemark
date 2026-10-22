#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '../lib/controller.mjs';

const root = path.resolve(process.env.AGENT_CONFIG_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
await serveStdio({ root, stateRoot: process.env.AGENT_CONFIG_STATE_ROOT, projectRoot: process.env.AGENT_CONFIG_PROJECT_ROOT });
