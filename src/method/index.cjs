'use strict';
module.exports = { ...require('./coordinator.cjs'), ...require('./capabilities.cjs'),
  ...require('./trace-adapter.cjs'), ...require('./browser-provider.cjs'),
  ...require('./application-provider.cjs'), ...require('./clipboard-provider.cjs'),
  ...require('./artifacts.cjs'), ...require('./geometry.cjs') };
