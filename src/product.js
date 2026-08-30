'use strict';

// One source of truth for release identity. package.json is also what release
// automation, container builds, and dependency tooling already read, so runtime
// surfaces should consume it instead of carrying independent version literals.
const { version } = require('../package.json');

const PRODUCT_NAME = 'VigaBSS';

module.exports = Object.freeze({
  name: PRODUCT_NAME,
  version,
  displayName: `${PRODUCT_NAME} ${version}`,
  releaseChannel: version.includes('-alpha.') ? 'alpha'
    : version.includes('-beta.') ? 'beta'
      : version.includes('-rc.') ? 'rc'
        : 'stable',
});
