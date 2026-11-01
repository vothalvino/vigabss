// =============================================================================
// VigaBSS 5.0 — Mexican time zone of a postal code
// =============================================================================
// Anexo 20 defines a CFDI's Fecha as the local time at LugarExpedicion, and
// PACs convert it to an instant with the huso horario of that postal code in
// SAT's c_CodigoPostal catalog, refusing a Fecha in the future. Writing every
// Fecha in America/Mexico_City put issuers in Baja California, Baja California
// Sur, Sonora, Sinaloa, Nayarit and Ciudad Juárez one or two hours ahead, so
// their first stamp of every invoice, egreso and REP failed (CFD-05).
//
// The first digits of a Mexican postal code name its state. The catalog is not
// shipped, so this maps the states (and the municipalities the catalog splits
// out) whose zone differs from Mexico City's. Everything else is Mexico City
// time.
// =============================================================================

const DEFAULT_TIME_ZONE = 'America/Mexico_City';

// [prefix, IANA zone], most specific first.
const ZONES_BY_PREFIX = [
  // Nayarit: Bahía de Banderas keeps central time; the rest is on Pacific time.
  ['6373', 'America/Bahia_Banderas'],
  ['63', 'America/Mazatlan'],
  // Chihuahua: Ciudad Juárez follows the US border DST; the state is central.
  ['320', 'America/Ciudad_Juarez'], ['321', 'America/Ciudad_Juarez'], ['322', 'America/Ciudad_Juarez'],
  ['323', 'America/Ciudad_Juarez'], ['324', 'America/Ciudad_Juarez'], ['325', 'America/Ciudad_Juarez'],
  ['326', 'America/Ciudad_Juarez'],
  ['21', 'America/Tijuana'], ['22', 'America/Tijuana'], // Baja California
  ['23', 'America/Mazatlan'], // Baja California Sur
  ['80', 'America/Mazatlan'], ['81', 'America/Mazatlan'], ['82', 'America/Mazatlan'], // Sinaloa
  ['83', 'America/Hermosillo'], ['84', 'America/Hermosillo'], ['85', 'America/Hermosillo'], // Sonora
  ['77', 'America/Cancun'], // Quintana Roo
];

function isKnownTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * IANA time zone for a Mexican postal code; Mexico City when unknown.
 * @param {string|number|null|undefined} postalCode
 * @returns {string}
 */
function timeZoneForPostalCode(postalCode) {
  const cp = String(postalCode ?? '').trim();
  if (!/^\d{5}$/.test(cp)) return DEFAULT_TIME_ZONE;
  const hit = ZONES_BY_PREFIX.find(([prefix]) => cp.startsWith(prefix));
  // An ICU build without a newer zone (Ciudad_Juarez is from 2022) falls back.
  return hit && isKnownTimeZone(hit[1]) ? hit[1] : DEFAULT_TIME_ZONE;
}

module.exports = { timeZoneForPostalCode, DEFAULT_TIME_ZONE };
