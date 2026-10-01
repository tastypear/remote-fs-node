"use strict";

const client = require("./lib/client");
const constants = require("./lib/constants");
const asyncApi = require("./lib/async-api");
const syncApi = require("./lib/sync-api");
const promisesApi = require("./lib/promises-api");
const { patch, restore, isPatched, bypass, isInBypass } = require("./lib/patch");
const { isBindingPatched } = require("./lib/binding");
const { Stats, Dirent, Dir } = require("./lib/stats");
const { ReadStream, WriteStream } = require("./lib/streams");
const { FSWatcher, StatWatcher } = require("./lib/watcher");

// Build the full fs-compatible object
const fs = {
  ...asyncApi,
  ...syncApi,
  promises: promisesApi,
  Stats,
  Dirent,
  Dir,
  ReadStream,
  WriteStream,
  FSWatcher,
  StatWatcher,
  constants,
  existsSync: syncApi.existsSync,
};

// Copy constants properties to fs itself (Node does this)
Object.assign(fs, constants);

module.exports = {
  fs,
  configure(opts) { client.configure(opts); },
  patch(options) { patch(fs, options); },
  restore,
  isPatched,
  bypass,
  isInBypass,
  isBindingPatched,
  client,
  constants,
  promises: promisesApi,
  syncBridge: require("./lib/sync-bridge"),
  default: fs,
};

// Also export fs properties on the module itself for convenience
Object.assign(module.exports, asyncApi, syncApi);
module.exports.constants = constants;
module.exports.promises = promisesApi;