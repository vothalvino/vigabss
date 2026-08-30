'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const product = require('../src/product');

const root = path.resolve(__dirname, '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));

describe('VigaBSS release identity', () => {
  it('uses the first alpha SemVer selected for the pre-launch release', () => {
    expect(product).toMatchObject({
      name: 'VigaBSS',
      version: '0.1.0-alpha.1',
      releaseChannel: 'alpha',
    });
  });

  it('keeps every first-party package and the Helm app version aligned', () => {
    const chart = yaml.load(fs.readFileSync(path.join(root, 'charts/fireisp/Chart.yaml'), 'utf8'));
    const versions = [
      readJson('package.json').version,
      readJson('frontend/package.json').version,
      readJson('e2e/package.json').version,
      readJson('frontend/ui-kit/package.json').version,
      chart.version,
      chart.appVersion,
    ];
    expect(new Set(versions)).toEqual(new Set([product.version]));
  });

  it('does not expose the inherited FireISP package name in first-party metadata', () => {
    expect(readJson('frontend/ui-kit/package.json').name).toBe('@vigabss/ui');
  });

  it('keeps static browser and PWA release copy aligned with package metadata', () => {
    const index = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
    const manifest = readJson('frontend/public/manifest.webmanifest');
    const lockup = fs.readFileSync(path.join(root, 'frontend/src/components/BrandLockup.tsx'), 'utf8');
    const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
    expect(index).toContain(product.version);
    expect(manifest.description).toContain(product.version);
    expect(lockup).toContain('__VIGABSS_VERSION__');
    expect(lockup).not.toContain(`'${product.version}'`);
    expect(installer).toContain(`VIGABSS_VERSION="${product.version}"`);
  });
});
