// =============================================================================
// NPR-06 — WISPr bandwidth vendor-type codes match the WISPr dictionary
// =============================================================================
// The encoder wrote Max-Down as vendor-type 7 and Max-Up as 8, the reverse of
// the WISPr dictionary (Max-Up 7, Max-Down 8). Every embedded-server
// Access-Accept and every CoA for a generic/WISPr plan reached the NAS with
// upload and download swapped.
// =============================================================================

const enc = require('../src/services/radiusCoaEncoder');

// RADIUS VSA: type 26, length, vendor id (4 bytes), vendor type, vendor length, value.
function decodeVsa(buf) {
  expect(buf[0]).toBe(26);
  return { vendorId: buf.readUInt32BE(2), vendorType: buf[6], value: buf.readUInt32BE(8) };
}

test.each([
  ['WISPr-Bandwidth-Max-Up', 7, 5000000],
  ['WISPr-Bandwidth-Max-Down', 8, 10000000],
])('%s is vendor 14122 type %i', (name, type, bps) => {
  const vsa = decodeVsa(enc.encodeNamedAttributes([{ name, value: bps }]));
  expect(vsa).toEqual({ vendorId: 14122, vendorType: type, value: bps });
});

test('the direct encoders agree', () => {
  expect(decodeVsa(enc.encodeWisprBandwidthMaxUp(1)).vendorType).toBe(7);
  expect(decodeVsa(enc.encodeWisprBandwidthMaxDown(1)).vendorType).toBe(8);
});
