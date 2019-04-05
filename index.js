"use strict";

const os = require("os");
const path = require("path");
const crypto = require("crypto");
const pFinally = require("p-finally");
const pMap = require("p-map");
const pPipe = require("p-pipe");
const pReduce = require("p-reduce");
const semver = require("semver");

const Command = require("@lerna/command");
const ValidationError = require("@lerna/validation-error");
const describeRef = require("@lerna/describe-ref");
const checkWorkingTree = require("@lerna/check-working-tree");
const PromptUtilities = require("@lerna/prompt");
const output = require("@lerna/output");
const collectUpdates = require("@lerna/collect-updates");
const npmConf = require("@lerna/npm-conf");
const npmDistTag = require("@lerna/npm-dist-tag");
const npmPublish = require("@lerna/npm-publish");
const packDirectory = require("@lerna/pack-directory");
const logPacked = require("@lerna/log-packed");
const { createRunner } = require("@lerna/run-lifecycle");
const batchPackages = require("@lerna/batch-packages");
const runParallelBatches = require("@lerna/run-parallel-batches");
const pulseTillDone = require("@lerna/pulse-till-done");
const { getFilteredPackages } = require("@lerna/filter-options");
const PackageGraph = require("@lerna/package-graph");

const createTempLicenses = require("./lib/create-temp-licenses");
const getCurrentSHA = require("./lib/get-current-sha");
const getCurrentTags = require("./lib/get-current-tags");
const getUnpublishedPackages = require("./lib/get-unpublished-packages");
const getNpmUsername = require("./lib/get-npm-username");
const getTaggedPackages = require("./lib/get-tagged-packages");
const getPackagesWithoutLicense = require("./lib/get-packages-without-license");
const gitCheckout = require("./lib/git-checkout");
const removeTempLicenses = require("./lib/remove-temp-licenses");
const verifyNpmPackageAccess = require("./lib/verify-npm-package-access");

module.exports = factory;

function factory(argv) {
  return new PublishCommand(argv);
}

class PublishCommand extends Command {
  get otherCommandConfigs() {
    // back-compat
    return ["version"];
  }

  get requiresGit() {
    // `lerna publish from-package` doesn't _need_ git, per se
    return false;
  }

  initialize() {
    if (this.options.canary) {
      this.logger.info("canary", "enabled");
    }

    if (this.options.requireScripts) {
      this.logger.info("require-scripts", "enabled");
    }

    if (!this.options.scope) {
      throw new ValidationError("ENOSCRIPT", "--packages argument is required");
    }

    // https://docs.npmjs.com/misc/config#save-prefix
    this.savePrefix = this.options.exact ? "" : "^";

    // inverted boolean options are only respected if prefixed with `--no-`, e.g. `--no-verify-access`
    this.gitReset = this.options.gitReset !== false;
    this.verifyAccess = this.options.verifyAccess !== false;

    // npmSession and user-agent are consumed by npm-registry-fetch (via libnpmpublish)
    const npmSession = crypto.randomBytes(8).toString("hex");
    const userAgent = `lerna/${this.options.lernaVersion}/node@${process.version}+${process.arch} (${
      process.platform
    })`;

    this.logger.verbose("session", npmSession);
    this.logger.verbose("user-agent", userAgent);

    this.conf = npmConf({
      lernaCommand: "publish",
      npmSession,
      npmVersion: userAgent,
      registry: this.options.registry,
    });

    this.conf.set("user-agent", userAgent, "cli");

    if (this.conf.get("registry") === "https://registry.yarnpkg.com") {
      this.logger.warn("", "Yarn's registry proxy is broken, replacing with public npm registry");
      this.logger.warn("", "If you don't have an npm token, you should exit and run `npm login`");

      this.conf.set("registry", "https://registry.npmjs.org/", "cli");
    }

    // inject --dist-tag into opts, if present
    const distTag = this.getDistTag();

    if (distTag) {
      this.conf.set("tag", distTag.trim(), "cli");
    }

    // a "rooted leaf" is the regrettable pattern of adding "." to the "packages" config in lerna.json
    this.hasRootedLeaf = this.packageGraph.has(this.project.manifest.name);

    if (this.hasRootedLeaf) {
      this.logger.info("publish", "rooted leaf detected, skipping synthetic root lifecycles");
    }

    this.runPackageLifecycle = createRunner(this.options);

    // don't execute recursively if run from a poorly-named script
    this.runRootLifecycle = /^(pre|post)?publish$/.test(process.env.npm_lifecycle_event)
      ? stage => {
          this.logger.warn("lifecycle", "Skipping root %j because it has already been called", stage);
        }
      : stage => this.runPackageLifecycle(this.project.manifest, stage);

    let chain = getFilteredPackages(this.packageGraph, this.execOpts, this.options);

    return chain.then((pkgs) => {
      this.packagesToPublish = pkgs.filter(pkg => !pkg.private);
      this.scopedPackages = this.packagesToPublish.map(pkg => this.packageGraph.get(pkg.name));

      this.batchedPackages = this.toposort
        ? batchPackages(
            this.packagesToPublish,
            this.options.rejectCycles,
            // Don't sort based on devDependencies because that
            // would increase the chance of dependency cycles
            // causing less-than-ideal a publishing order.
            "dependencies"
          )
        : [this.packagesToPublish];

      return true;
    });
  }

  execute() {
    this.enableProgressBar();
    this.logger.info("publish", "Publishing packages to npm...");

    let chain = Promise.resolve();

    chain = chain.then(() => this.prepareRegistryActions());
    chain = chain.then(() => this.prepareLicenseActions());
    chain = chain.then(() => this.verifyWorkingTreeClean());

    if (this.options.canary) {
      chain = chain.then(() => this.updateCanaryVersions());
    }

    chain = chain.then(() => this.resolveLocalDependencyLinks());
    chain = chain.then(() => this.annotateGitHead());
    chain = chain.then(() => this.serializeChanges());
    chain = chain.then(() => this.packUpdated());
    chain = chain.then(() => this.publishPacked());

    if (this.gitReset) {
      chain = chain.then(() => this.resetChanges());
    }

    if (this.options.tempTag) {
      chain = chain.then(() => this.npmUpdateAsLatest());
    }

    return chain.then(() => {
      const count = this.packagesToPublish.length;
      const message = this.packagesToPublish.map(pkg => ` - ${pkg.name}@${pkg.version}`);

      output("Successfully published:");
      output(message.join(os.EOL));

      this.logger.success("published", "%d %s", count, count === 1 ? "package" : "packages");
    });
  }

  verifyWorkingTreeClean() {
    return describeRef(this.execOpts).then(checkWorkingTree.throwIfUncommitted);
  }

  prepareLicenseActions() {
    return Promise.resolve()
      .then(() => getPackagesWithoutLicense(this.project, this.packagesToPublish))
      .then(packagesWithoutLicense => {
        if (packagesWithoutLicense.length && !this.project.licensePath) {
          this.packagesToBeLicensed = [];

          const names = packagesWithoutLicense.map(pkg => pkg.name);
          const noun = names.length > 1 ? "Packages" : "Package";
          const verb = names.length > 1 ? "are" : "is";
          const list =
            names.length > 1
              ? `${names.slice(0, -1).join(", ")}${names.length > 2 ? "," : ""} and ${
                  names[names.length - 1] /* oxford commas _are_ that important */
                }`
              : names[0];

          this.logger.warn(
            "ENOLICENSE",
            "%s %s %s missing a license.\n%s\n%s",
            noun,
            list,
            verb,
            "One way to fix this is to add a LICENSE.md file to the root of this repository.",
            "See https://choosealicense.com for additional guidance."
          );
        } else {
          this.packagesToBeLicensed = packagesWithoutLicense;
        }
      });
  }

  prepareRegistryActions() {
    let chain = Promise.resolve();

    if (this.conf.get("registry") !== "https://registry.npmjs.org/") {
      this.logger.notice("", "Skipping all user and access validation due to third-party registry");
      this.logger.notice("", "Make sure you're authenticated properly ¯\\_(ツ)_/¯");

      return chain;
    }

    /* istanbul ignore if */
    if (process.env.LERNA_INTEGRATION) {
      return chain;
    }

    if (this.verifyAccess) {
      // validate user has valid npm credentials first,
      // by far the most common form of failed execution
      chain = chain.then(() => getNpmUsername(this.conf.snapshot));
      chain = chain.then(username => {
        // if no username was retrieved, don't bother validating
        if (username) {
          return verifyNpmPackageAccess(this.packagesToPublish, username, this.conf.snapshot);
        }
      });
    }

    return chain;
  }

  updateCanaryVersions() {
    const publishableUpdates = this.scopedPackages.filter(node => !node.pkg.private);

    return pMap(publishableUpdates, ({ pkg, localDependencies }) => {

      for (const [depName, resolved] of localDependencies) {
        // other canary versions need to be updated, non-canary is a no-op
        const depVersion = this.packageGraph.get(depName).pkg.version;

        // it no longer matters if we mutate the shared Package instance
        pkg.updateLocalDependency(resolved, depVersion, this.savePrefix);
      }

      // writing changes to disk handled in serializeChanges()
    });
  }

  resolveLocalDependencyLinks() {
    // resolve relative file: links to their actual version range

    const updatesWithLocalLinks = this.scopedPackages.map(pkg => this.packageGraph.get(pkg.name)).filter(
      ({ pkg, localDependencies }) =>
        !pkg.private &&
        localDependencies.size &&
        Array.from(localDependencies.values()).some(({ type }) => type === "directory")
    );

    return pMap(updatesWithLocalLinks, ({ pkg, localDependencies }) => {
      for (const [depName, resolved] of localDependencies) {
        // regardless of where the version comes from, we can't publish "file:../sibling-pkg" specs
        const depVersion = this.packageGraph.get(depName).pkg.version;

        // it no longer matters if we mutate the shared Package instance
        pkg.updateLocalDependency(resolved, depVersion, this.savePrefix);
      }

      // writing changes to disk handled in serializeChanges()
    });
  }

  annotateGitHead() {
    try {
      const gitHead = this.options.gitHead || getCurrentSHA(this.execOpts);

      for (const pkg of this.packagesToPublish) {
        // provide gitHead property that is normally added during npm publish
        pkg.set("gitHead", gitHead);
      }
    } catch (err) {
      // from-package should be _able_ to run without git, but at least we tried
      this.logger.silly("EGITHEAD", err.message);
      this.logger.notice(
        "FYI",
        "Unable to set temporary gitHead property, it will be missing from registry metadata"
      );
    }

    // writing changes to disk handled in serializeChanges()
  }

  serializeChanges() {
    return pMap(this.packagesToPublish, pkg => pkg.serialize());
  }

  resetChanges() {
    // the package.json files are changed (by gitHead if not --canary)
    // and we should always __attempt_ to leave the working tree clean
    const { cwd } = this.execOpts;
    const dirtyManifests = [this.project.manifest]
      .concat(this.packagesToPublish)
      .map(pkg => path.relative(cwd, pkg.manifestLocation));

    return gitCheckout(dirtyManifests, this.execOpts).catch(err => {
      this.logger.silly("EGITCHECKOUT", err.message);
      this.logger.notice("FYI", "Unable to reset working tree changes, this probably isn't a git repo.");
    });
  }

  execScript(pkg, script) {
    const scriptLocation = path.join(pkg.location, "scripts", script);

    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      require(scriptLocation);
    } catch (ex) {
      this.logger.silly("execScript", `No ${script} script found at ${scriptLocation}`);
    }

    return pkg;
  }

  removeTempLicensesOnError(error) {
    return Promise.resolve()
      .then(() =>
        removeTempLicenses(this.packagesToBeLicensed).catch(removeError => {
          this.logger.error(
            "licenses",
            "error removing temporary license files",
            removeError.stack || removeError
          );
        })
      )
      .then(() => {
        // restore original error into promise chain
        throw error;
      });
  }

  packUpdated() {
    const tracker = this.logger.newItem("npm pack");

    tracker.addWork(this.packagesToPublish.length);

    let chain = Promise.resolve();

    chain = chain.then(() => createTempLicenses(this.project.licensePath, this.packagesToBeLicensed));

    if (!this.hasRootedLeaf) {
      // despite being deprecated for years...
      chain = chain.then(() => this.runRootLifecycle("prepublish"));

      // these lifecycles _should_ never be employed to run `lerna publish`...
      chain = chain.then(() => this.runPackageLifecycle(this.project.manifest, "prepare"));
      chain = chain.then(() => this.runPackageLifecycle(this.project.manifest, "prepublishOnly"));
      chain = chain.then(() => this.runPackageLifecycle(this.project.manifest, "prepack"));
    }

    const { contents } = this.options;
    const getLocation = contents ? pkg => path.resolve(pkg.location, contents) : pkg => pkg.location;

    const opts = this.conf.snapshot;
    const mapper = pPipe(
      [
        this.options.requireScripts && (pkg => this.execScript(pkg, "prepublish")),

        pkg =>
          pulseTillDone(packDirectory(pkg, getLocation(pkg), opts)).then(packed => {
            tracker.verbose("packed", pkg.name, path.relative(this.project.rootPath, getLocation(pkg)));
            tracker.completeWork(1);

            // store metadata for use in this.publishPacked()
            pkg.packed = packed;

            // manifest may be mutated by any previous lifecycle
            return pkg.refresh();
          }),
      ].filter(Boolean)
    );

    chain = chain.then(() =>
      pReduce(this.batchedPackages, (_, batch) => pMap(batch, mapper, { concurrency: 10 }))
    );

    chain = chain.then(() => removeTempLicenses(this.packagesToBeLicensed));

    // remove temporary license files if _any_ error occurs _anywhere_ in the promise chain
    chain = chain.catch(error => this.removeTempLicensesOnError(error));

    if (!this.hasRootedLeaf) {
      chain = chain.then(() => this.runPackageLifecycle(this.project.manifest, "postpack"));
    }

    return pFinally(chain, () => tracker.finish());
  }

  publishPacked() {
    const tracker = this.logger.newItem("publish");

    tracker.addWork(this.packagesToPublish.length);

    let chain = Promise.resolve();

    const opts = Object.assign(this.conf.snapshot, {
      // distTag defaults to "latest" OR whatever is in pkg.publishConfig.tag
      // if we skip temp tags we should tag with the proper value immediately
      tag: this.options.tempTag ? "lerna-temp" : this.conf.get("tag"),
    });

    const mapper = pPipe(
      [
        pkg =>
          pulseTillDone(npmPublish(pkg, pkg.packed.tarFilePath, opts)).then(() => {
            tracker.success("published", pkg.name, pkg.version);
            tracker.completeWork(1);

            logPacked(pkg.packed);

            return pkg;
          }),

        this.options.requireScripts && (pkg => this.execScript(pkg, "postpublish")),
      ].filter(Boolean)
    );

    chain = chain.then(() => runParallelBatches(this.batchedPackages, this.concurrency, mapper));

    if (!this.hasRootedLeaf) {
      // cyclical "publish" lifecycles are automatically skipped
      chain = chain.then(() => this.runRootLifecycle("publish"));
      chain = chain.then(() => this.runRootLifecycle("postpublish"));
    }

    return pFinally(chain, () => tracker.finish());
  }

  npmUpdateAsLatest() {
    const tracker = this.logger.newItem("npmUpdateAsLatest");

    tracker.addWork(this.packagesToPublish.length);
    tracker.showProgress();

    let chain = Promise.resolve();

    const opts = this.conf.snapshot;
    const getDistTag = publishConfig => {
      if (opts.tag === "latest" && publishConfig && publishConfig.tag) {
        return publishConfig.tag;
      }

      return opts.tag;
    };
    const mapper = pkg => {
      const spec = `${pkg.name}@${pkg.version}`;
      const distTag = getDistTag(pkg.get("publishConfig"));

      return Promise.resolve()
        .then(() => pulseTillDone(npmDistTag.remove(spec, "lerna-temp", opts)))
        .then(() => pulseTillDone(npmDistTag.add(spec, distTag, opts)))
        .then(() => {
          tracker.success("dist-tag", "%s@%s => %j", pkg.name, pkg.version, distTag);
          tracker.completeWork(1);

          return pkg;
        });
    };

    chain = chain.then(() => runParallelBatches(this.batchedPackages, this.concurrency, mapper));

    return pFinally(chain, () => tracker.finish());
  }

  getDistTag() {
    if (this.options.distTag) {
      return this.options.distTag;
    }

    if (this.options.canary) {
      return "canary";
    }

    // undefined defaults to "latest" OR whatever is in pkg.publishConfig.tag
  }
}

module.exports.PublishCommand = PublishCommand;
