'use strict';

const { HikvisionPlatform, PLATFORM_NAME } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, HikvisionPlatform);
};
