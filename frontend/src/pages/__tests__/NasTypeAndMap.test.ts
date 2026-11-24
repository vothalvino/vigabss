// A NAS's make is chosen from a list (it was free text, so "Mikrotik",
// "mikrotik" and "MT" could all exist), and NAS routers are drawn on the
// topology map at their site.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = (name: string) => readFileSync(resolve(__dirname, '..', name), 'utf8');
const locale = (name: string) => JSON.parse(readFileSync(resolve(__dirname, '../../i18n/locales', `${name}.json`), 'utf8'));

describe('NAS type', () => {
  const src = page('NasList.tsx');

  it('is a list of makes, each with a label in every language', () => {
    const list = /const NAS_TYPES: string\[\] = \[([^\]]+)\]/.exec(src)![1].split(',').map(v => v.trim().replace(/'/g, ''));
    expect(list).toEqual(['mikrotik', 'cisco', 'juniper', 'huawei', 'ubiquiti', 'other']);
    for (const lang of ['en', 'es', 'pt-BR']) {
      for (const make of list) expect(locale(lang).nasTypes[make]).toBeTruthy();
    }
    expect(src).not.toMatch(/placeholder=\{t\('ui\.nasList\.eGMikrotikCiscoUbiquiti'\)\}/);
  });

  it('a value saved before the list existed is still shown, not silently dropped', () => {
    expect(src).toMatch(/form\.type && !NAS_TYPES\.includes\(form\.type\) && <option value=\{form\.type\}>\{form\.type\}<\/option>/);
  });
});

describe('NAS routers on the topology map', () => {
  const src = page('TopologyMapPage.tsx');

  it('are drawn differently from devices and cannot be dragged to a new place', () => {
    expect(src).toMatch(/node\.kind === 'nas' \? '#2563eb'/);
    expect(src).toMatch(/editMode && node\.kind !== 'nas' \?/);
  });

  it('are not offered in the "not placed yet" list, which saves positions on devices', () => {
    expect(src.match(/n\.kind !== 'nas' && \(n\.latitude == null \|\| n\.longitude == null\)/g)).toHaveLength(2);
  });

  it('the page says which NAS routers could not be placed', () => {
    expect(src).toMatch(/nas_without_location/);
    expect(locale('en').topologyMap.nasNotShown).toMatch(/\{\{names\}\}/);
  });
});

describe('drawing links on the topology map', () => {
  const src = page('TopologyMapPage.tsx');

  it('two markers are picked, then the kind of link is chosen and saved', () => {
    expect(src).toMatch(/apiFetch\('\/topology\/map\/links', \{\s+method: 'POST'/);
    expect(src).toMatch(/a: linking\?\.a\?\.id, b: linking\?\.b\?\.id, link_type: linkType/);
    // Any marker can be an end, a NAS included.
    expect(src).toMatch(/eventHandlers=\{linking\s+\? \{ click: \(\) => pickForLink\(node\) \}/);
    // Clicking the same marker twice does not make a link to itself.
    expect(src).toMatch(/if \(cur\.a\.id === node\.id\) return cur;/);
  });

  it('is only offered to someone who may create links, and removal to someone who may delete them', () => {
    expect(src).toMatch(/const canLink = can\(user, 'network_links\.create'\);/);
    expect(src).toMatch(/\{canLink && \(/);
    expect(src).toMatch(/\{canUnlink && !linking && !editMode && \(/);
  });

  it('every kind of link has a label in every language', () => {
    for (const lang of ['en', 'es', 'pt-BR']) {
      for (const kind of ['fiber', 'wireless', 'copper', 'virtual', 'other']) expect(locale(lang).topologyMap.linkTypes[kind]).toBeTruthy();
    }
  });
});
