"use strict";

const log = require("npmlog");

/**
 * @see https://github.com/yargs/yargs/blob/master/docs/advanced.md#providing-a-command-module
 */
exports.command = "publishCurrentVersion [bump]";

exports.describe = "Publish packages in the current project for the current version.";

exports.builder = yargs => {
  const opts = {
    c: {
      describe: "Publish packages after every successful merge using the sha as part of the tag.",
      alias: "canary",
      type: "boolean",
    },
    // preid is copied from ../version/command because a whitelist for one option isn't worth it
    preid: {
      describe: "Specify the prerelease identifier when publishing a prerelease",
      type: "string",
      requiresArg: true,
      defaultDescription: "alpha",
    },
    contents: {
      describe: "Subdirectory to publish. Must apply to ALL packages.",
      type: "string",
      requiresArg: true,
      defaultDescription: ".",
    },
    "dist-tag": {
      describe: "Publish packages with the specified npm dist-tag",
      type: "string",
      requiresArg: true,
    },
    "git-head": {
      describe:
        "Explicit SHA to set as gitHead when packing tarballs, only allowed with 'from-package' positional.",
      type: "string",
      requiresArg: true,
    },
    registry: {
      describe: "Use the specified registry for all npm client operations.",
      type: "string",
      requiresArg: true,
    },
    "require-scripts": {
      describe: "Execute ./scripts/prepublish.js and ./scripts/postpublish.js, relative to package root.",
      type: "boolean",
    },
    "no-git-reset": {
      describe: "Do not reset changes to working tree after publishing is complete.",
      type: "boolean",
    },
    "git-reset": {
      // proxy for --no-git-reset
      hidden: true,
      type: "boolean",
    },
    "temp-tag": {
      describe: "Create a temporary tag while publishing.",
      type: "boolean",
    },
    "no-verify-access": {
      describe: "Do not verify package read-write access for current npm user.",
      type: "boolean",
    },
    "scope": {
      describe: "scope for which to publish current version",
      type: "string",
      requiresArg: true
    },
    "verify-access": {
      // proxy for --no-verify-access
      hidden: true,
      type: "boolean",
    },
    // y: {
    //   describe: "Skip all confirmation prompts.",
    //   alias: "yes",
    //   type: "boolean",
    // },
  };

  yargs.options(opts);

  // "unhide" duplicate options
  const { hiddenOptions } = yargs.getOptions();
  const sharedKeys = ["preid", "y"];

  for (const sharedKey of sharedKeys) {
    hiddenOptions.splice(hiddenOptions.findIndex(k => k === sharedKey), 1);
  }

  yargs.group(Object.keys(opts).concat(sharedKeys), "Command Options:");

  return yargs
    .option("npm-tag", {
      // TODO: remove in next major release
      hidden: true,
      conflicts: "dist-tag",
      type: "string",
      requiresArg: true,
    })
    .option("verify-registry", {
      // TODO: remove in next major release
      hidden: true,
      type: "boolean",
    })
    .check(argv => {
      /* eslint-disable no-param-reassign */
      if (argv.npmTag) {
        argv.distTag = argv.npmTag;
        argv["dist-tag"] = argv.npmTag;
        delete argv.npmTag;
        delete argv["npm-tag"];
        log.warn("deprecated", "--npm-tag has been renamed --dist-tag");
      }
      /* eslint-enable no-param-reassign */

      return argv;
    });
};

exports.handler = function handler(argv) {
  return require(".")(argv);
};
