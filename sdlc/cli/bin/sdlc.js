#!/usr/bin/env node
// sdlc CLI 入口（ESM 直发，无构建链）。
import { run } from '../src/main.js';

process.exitCode = await run(process.argv.slice(2));
