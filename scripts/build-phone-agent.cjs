#!/usr/bin/env node
'use strict';

// Kept so `node scripts/build-phone-agent.cjs` still works; the build lives in src/agentic-phone/build.cjs.
require('../src/agentic-phone/build.cjs').main();
