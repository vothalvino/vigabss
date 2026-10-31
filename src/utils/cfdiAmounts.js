// =============================================================================
// VigaBSS 5.0 — CFDI 4.0 amounts within the Anexo 20 limits (CFD-03)
// =============================================================================
// SAT checks every Concepto Importe against Cantidad × ValorUnitario, and
// every Traslado Importe against Base × TasaOCuota, within limits that depend
// on HOW MANY DECIMALS each value is written with (Anexo 20, "límite
// inferior / superior"). The cfdi_* columns are DECIMAL(x,4), and writing
// them raw ("824.1900") narrowed those limits; a last-line IVA plug could then
// fall outside them, and a quantity rounded to 2 decimals stopped matching its
// Importe. Values are now written at the precision they were computed with,
// the tax is split per line by largest remainder (each line within its
// limits), and the document is checked before it goes to the PAC.
// =============================================================================

const MONEY_DECIMALS = 2;
const EPSILON = 1e-12;

/** A money value written with 2 decimals (MXN). */
function formatMoney(value) {
  return Number(value || 0).toFixed(MONEY_DECIMALS);
}

/** Up to 6 decimals, trailing zeros removed, at least `minDecimals`. */
function formatTrimmed(value, minDecimals) {
  const fixed = Number(value || 0).toFixed(6);
  const [whole, digits] = fixed.split('.');
  let frac = digits.replace(/0+$/, '');
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, '0');
  return frac.length ? `${whole}.${frac}` : whole;
}

/** Cantidad: as entered (1, 1.5, 12.345), never padded to the column scale. */
const formatQuantity = value => formatTrimmed(value, 0);
/** ValorUnitario: at least 2 decimals, up to 6 when the price has them. */
const formatUnitValue = value => formatTrimmed(value, MONEY_DECIMALS);

function decimalsOf(text) {
  const s = String(text);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

const truncate = (value, decimals) => Math.floor((value + EPSILON) * 10 ** decimals) / 10 ** decimals;
const roundUp = (value, decimals) => Math.ceil((value - EPSILON) * 10 ** decimals) / 10 ** decimals;

/** Anexo 20 limits for a Concepto Importe, from the values as written. */
function conceptoImporteBounds(cantidadText, valorUnitarioText, importeDecimals = MONEY_DECIMALS) {
  const qty = Number(cantidadText);
  const price = Number(valorUnitarioText);
  const halfQ = 10 ** -decimalsOf(cantidadText) / 2;
  const halfV = 10 ** -decimalsOf(valorUnitarioText) / 2;
  return [
    truncate((qty - halfQ) * (price - halfV), importeDecimals),
    roundUp((qty + halfQ - EPSILON) * (price + halfV - EPSILON), importeDecimals),
  ];
}

/** Anexo 20 limits for a Traslado Importe, from the Base as written. */
function trasladoImporteBounds(baseText, tasa, importeDecimals = MONEY_DECIMALS) {
  const base = Number(baseText);
  const rate = Number(tasa);
  const half = 10 ** -decimalsOf(baseText) / 2;
  return [
    truncate((base - half) * rate, importeDecimals),
    roundUp((base + half - EPSILON) * rate, importeDecimals),
  ];
}

/**
 * Split `totalTax` over the lines so each line's tax is the floor or ceiling
 * (in cents) of base × rate. The rounded document tax always lies between the
 * sum of the floors and the sum of the ceilings, so this always succeeds for
 * a tax computed as round(subtotal × rate) — and every line is then inside
 * its Anexo 20 limits. Returns null when `totalTax` cannot be split that way
 * (e.g. a hand-entered tax amount that does not match the rate).
 *
 * @param {number[]} bases  line bases (2-decimal amounts)
 * @param {number} rate     e.g. 0.16
 * @param {number} totalTax the document's stored tax amount
 * @returns {number[]|null}
 */
function allocateLineTaxes(bases, rate, totalTax) {
  const exact = bases.map(b => Math.round(Number(b) * 100) * rate); // cents, unrounded
  const floors = exact.map(c => Math.floor(c + EPSILON));
  const target = Math.round(Number(totalTax) * 100);
  let remaining = target - floors.reduce((a, b) => a + b, 0);
  const fractional = exact
    .map((c, i) => ({ i, frac: c - floors[i] }))
    .filter(x => x.frac > EPSILON)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  if (remaining < 0 || remaining > fractional.length) return null;
  const cents = [...floors];
  for (const { i } of fractional) {
    if (remaining === 0) break;
    cents[i] += 1;
    remaining -= 1;
  }
  return cents.map(c => c / 100);
}

/**
 * Check conceptos and their traslados against the Anexo 20 limits, using the
 * same formatting the XML builder writes.
 *
 * @param {Array<{id, cantidad, valor_unitario, importe}>} conceptos
 * @param {Array<{cfdi_concepto_id, tax_type, tipo_factor, base, tasa_o_cuota, importe}>} impuestos
 * @returns {string[]} one message per violation (empty = valid)
 */
function anexo20Violations(conceptos, impuestos) {
  const problems = [];
  conceptos.forEach((c, index) => {
    const line = index + 1;
    const cantidad = formatQuantity(c.cantidad);
    const valor = formatUnitValue(c.valor_unitario);
    const importe = Number(formatMoney(c.importe));
    const [lo, hi] = conceptoImporteBounds(cantidad, valor);
    if (importe < lo - EPSILON || importe > hi + EPSILON) {
      problems.push(`Line ${line}: Importe ${formatMoney(importe)} is not Cantidad ${cantidad} × ValorUnitario ${valor} (allowed ${lo.toFixed(2)}–${hi.toFixed(2)})`);
    }
    for (const t of impuestos.filter(x => x.cfdi_concepto_id === c.id && x.tax_type === 'traslado' && x.tipo_factor !== 'Exento')) {
      const base = formatMoney(t.base);
      const taxImporte = Number(formatMoney(t.importe));
      const [tlo, thi] = trasladoImporteBounds(base, t.tasa_o_cuota);
      if (taxImporte < tlo - EPSILON || taxImporte > thi + EPSILON) {
        problems.push(`Line ${line}: IVA ${formatMoney(taxImporte)} is outside Base ${base} × ${Number(t.tasa_o_cuota)} (allowed ${tlo.toFixed(2)}–${thi.toFixed(2)})`);
      }
    }
  });
  return problems;
}

module.exports = {
  formatMoney,
  formatQuantity,
  formatUnitValue,
  conceptoImporteBounds,
  trasladoImporteBounds,
  allocateLineTaxes,
  anexo20Violations,
};
