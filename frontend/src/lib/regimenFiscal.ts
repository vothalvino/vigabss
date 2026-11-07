// =============================================================================
// SAT c_RegimenFiscal codes for a picker
// =============================================================================
// The tax regimes a CFDI receptor can declare (SAT catalogue c_RegimenFiscal,
// CFDI 4.0). The descriptions are the catalogue's official Spanish names,
// which stay in Spanish in every locale like other SAT catalogue names
// (docs/language-guideline.md). Staff screens that can call the server read
// /sat-catalogs/regimen-fiscal instead; this list serves screens that cannot,
// such as the reseller app.
// =============================================================================

export interface RegimenFiscalOption {
  code: string;
  description: string;
}

export const REGIMEN_FISCAL_OPTIONS: readonly RegimenFiscalOption[] = [
  { code: '601', description: 'General de Ley Personas Morales' },
  { code: '603', description: 'Personas Morales con Fines no Lucrativos' },
  { code: '605', description: 'Sueldos y Salarios e Ingresos Asimilados a Salarios' },
  { code: '606', description: 'Arrendamiento' },
  { code: '607', description: 'Régimen de Enajenación o Adquisición de Bienes' },
  { code: '608', description: 'Demás ingresos' },
  { code: '610', description: 'Residentes en el Extranjero sin Establecimiento Permanente en México' },
  { code: '611', description: 'Ingresos por Dividendos (socios y accionistas)' },
  { code: '612', description: 'Personas Físicas con Actividades Empresariales y Profesionales' },
  { code: '614', description: 'Ingresos por intereses' },
  { code: '615', description: 'Régimen de los ingresos por obtención de premios' },
  { code: '616', description: 'Sin obligaciones fiscales' },
  { code: '620', description: 'Sociedades Cooperativas de Producción que optan por diferir sus ingresos' },
  { code: '621', description: 'Incorporación Fiscal' },
  { code: '622', description: 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras' },
  { code: '623', description: 'Opcional para Grupos de Sociedades' },
  { code: '624', description: 'Coordinados' },
  { code: '625', description: 'Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas' },
  { code: '626', description: 'Régimen Simplificado de Confianza' },
];

/** RFC of a persona moral (12 characters) or física (13). */
export const RFC_PATTERN = /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/;

/** Código postal: five digits. */
export const CODIGO_POSTAL_PATTERN = /^\d{5}$/;
