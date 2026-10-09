'use strict';

const fs = require('fs');

// plugin-ui-utils is ESM-only, so load it with import() to work on every supported Node version.
import('@homebridge/plugin-ui-utils').then(({ HomebridgePluginUiServer }) => {
  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      this.onRequest('/console-info', () => this.consoleInfo());
      this.ready();
    }

    /** Whether the web console is enabled in the saved config, and its port. */
    consoleInfo() {
      try {
        const cfg = JSON.parse(fs.readFileSync(this.homebridgeConfigPath, 'utf8'));
        const mine = (cfg.platforms || []).find((p) => p && p.platform === 'HikvisionDVR') || {};
        const port = Number(mine.webConsolePort);
        return { enabled: mine.webConsole === true, port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 8100 };
      } catch (e) {
        return { enabled: false, port: 8100 };
      }
    }
  }
  return new UiServer();
}).catch((e) => {
  console.error(`Plugin UI server failed: ${e.message}`);
  process.exit(1);
});
