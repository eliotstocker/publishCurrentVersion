# `@lerna/publish`

> Publish packages in the current project for the current verison
this is a standalone copy of publish-current-version with the version stuff removed, built specifically for running separately after lerna version when you wish to split a build pipeline

## Usage
unless you are splitting out `lerna version` and npm publish it is unlikely you will want to use this package, in general it is a bad idea and people will shun you

```sh
publish-current-version --scope @scope/package # publish package(s) (with correct dependencies) to npm
```

When run, this command publishes packages specified by scope to npm with the current version

> Lerna will never publish packages which are marked as private (`"private": true` in the `package.json`). (this stands true for this package)

## Options

`publish-current-version` supports all of the options provided by [`lerna version`](https://github.com/lerna/lerna/tree/master/commands/version#options) in addition to the following:

- [`--canary`](#--canary)
- [`--contents <dir>`](#--contents-dir)
- [`--dist-tag <tag>`](#--dist-tag-tag)
- [`--git-head <sha>`](#--git-head-sha)
- [`--no-git-reset`](#--no-git-reset)
- [`--no-verify-access`](#--no-verify-access)
- [`--preid`](#--preid)
- [`--registry <url>`](#--registry-url)
- [`--temp-tag`](#--temp-tag)
- [`--yes`](#--yes)

### `--canary`

```sh
publish-current-version --canary
# 1.0.0 => 1.0.1-alpha.0+${SHA} of packages changed since the previous commit
# a subsequent canary publish will yield 1.0.1-alpha.1+${SHA}, etc

publish-current-version --canary --preid beta
# 1.0.0 => 1.0.1-beta.0+${SHA}

# The following are equivalent:
publish-current-version --canary minor
publish-current-version --canary preminor
# 1.0.0 => 1.1.0-alpha.0+${SHA}
```

When run with this flag, `publish-current-version` publishes packages in a more granular way (per commit).
Before publishing to npm, it creates the new `version` tag by taking the current `version`, bumping it to the next _minor_ version, adding the provided meta suffix (defaults to `alpha`) and appending the current git sha (ex: `1.0.0` becomes `1.1.0-alpha.0+81e3b443`).

If you have publish canary releases from multiple active development branches in CI,
it is recommended to customize the [`--preid`](#--preid) and [`--dist-tag <tag>`](#--dist-tag-tag) on a per-branch basis to avoid clashing versions.

> The intended use case for this flag is a per commit level release or nightly release.

### `--contents <dir>`

Subdirectory to publish. Must apply to ALL packages, and MUST contain a package.json file.
Package lifecycles will still be run in the original leaf directory.
You should probably use one of those lifecycles (`prepare`, `prepublishOnly`, or `prepack`) to _create_ the subdirectory and whatnot.

If you're into unnecessarily complicated publishing, this will give you joy.

```sh
publish-current-version --contents dist
# publish the "dist" subfolder of every Lerna-managed leaf package
```

### `--dist-tag <tag>`

```sh
publish-current-version --dist-tag next
```

When run with this flag, `publish-current-version` will publish to npm with the given npm [dist-tag](https://docs.npmjs.com/cli/dist-tag) (defaults to `latest`).

This option can be used to publish a [`prerelease`](http://carrot.is/coding/npm_prerelease) or `beta` version under a non-`latest` dist-tag, helping consumers avoid automatically upgrading to prerelease-quality code.

> Note: the `latest` tag is the one that is used when a user runs `npm install my-package`.
> To install a different tag, a user can run `npm install my-package@prerelease`.

### `--git-head <sha>`

Explicit SHA to set as [`gitHead`](https://git.io/fh7np) on manifests when packing tarballs, only allowed with [`from-package`](#bump-from-package) positional.

For example, when publishing from AWS CodeBuild (where `git` is not available),
you could use this option to pass the appropriate [environment variable](https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-env-vars.html) to use for this package metadata:

```sh
publish-current-version from-package --git-head ${CODEBUILD_RESOLVED_SOURCE_VERSION}
```

Under all other circumstances, this value is derived from a local `git` command.

### `--no-git-reset`

By default, `publish-current-version` ensures any changes to the working tree have been reset.

To avoid this, pass `--no-git-reset`. This can be especially useful when used as part of a CI pipeline in conjunction with the `--canary` flag. For instance, the `package.json` version numbers which have been bumped may need to be used in subsequent CI pipeline steps (such as Docker builds).

```sh
publish-current-version --no-git-reset
```

### `--no-verify-access`

By default, `lerna` will verify the logged-in npm user's access to the packages about to be published. Passing this flag will disable that check.

If you are using a third-party registry that does not support `npm access ls-packages`, you will need to pass this flag (or set `command.publish.verifyAccess` to `false` in lerna.json).

> Please use with caution

### `--preid`

Unlike the `lerna version` option of the same name, this option only applies to [`--canary`](#--canary) version calculation.

```sh
publish-current-version --canary
# uses the next semantic prerelease version, e.g.
# 1.0.0 => 1.0.1-alpha.0

publish-current-version --canary --preid next
# uses the next semantic prerelease version with a specific prerelease identifier, e.g.
# 1.0.0 => 1.0.1-next.0
```

When run with this flag, `publish-current-version --canary` will increment `premajor`, `preminor`, `prepatch`, or `prerelease` semver
bumps using the specified [prerelease identifier](http://semver.org/#spec-item-9).

### `--registry <url>`

When run with this flag, forwarded npm commands will use the specified registry for your package(s).

This is useful if you do not want to explicitly set up your registry
configuration in all of your package.json files individually when e.g. using
private registries.

### `--temp-tag`

When passed, this flag will alter the default publish process by first publishing
all changed packages to a temporary dist-tag (`lerna-temp`) and then moving the
new version(s) to the dist-tag configured by [`--dist-tag`](#--dist-tag-tag) (default `latest`).

This is not generally necessary, as Lerna will publish packages in topological
order (all dependencies before dependents) by default.

### `--yes`

```sh
publish-current-version --canary --yes
# skips `Are you sure you want to publish the above changes?`
```

When run with this flag, `publish-current-version` will skip all confirmation prompts.
Useful in [Continuous integration (CI)](https://en.wikipedia.org/wiki/Continuous_integration) to automatically answer the publish confirmation prompt.

## Per-Package Configuration

A leaf package can be configured with special [`publishConfig`](https://docs.npmjs.com/files/package.json#publishconfig) that in _certain_ circumstances changes the behavior of `publish-current-version`.

### `publishConfig.access`

To publish packages with a scope (e.g., `@mycompany/rocks`), you must set [`access`](https://docs.npmjs.com/misc/config#access):

```json
  "publishConfig": {
    "access": "public"
  }
```

- If this field is set for a package _without_ a scope, it **will** fail.
- If you _want_ your scoped package to remain private (i.e., `"restricted"`), there is no need to set this value.

  Note that this is **not** the same as setting `"private": true` in a leaf package; if the `private` field is set, that package will _never_ be published under any circumstances.

### `publishConfig.registry`

You can customize the registry on a per-package basis by setting [`registry`](https://docs.npmjs.com/misc/config#registry):

```json
  "publishConfig": {
    "registry": "http://my-awesome-registry.com/"
  }
```

- Passing [`--registry`](#--registry-url) applies globally, and in some cases isn't what you want.

### `publishConfig.tag`

You can customize the dist-tag on a per-package basis by setting [`tag`](https://docs.npmjs.com/misc/config#tag):

```json
  "publishConfig": {
    "tag": "flippin-sweet"
  }
```

- Passing [`--dist-tag`](#--dist-tag-tag) will _overwrite_ this value.
- This value is _always_ ignored when [`--canary`](#--canary) is passed.
