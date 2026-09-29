// What phone keyboards put into the numeric fields. Arabic keypads type Arabic-Indic (or Persian) digits and a decimal
// comma; these become the ASCII digits and point the checks expect, instead of being dropped or joined.
const latinDigits = (text: string) => text
  .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0));

/** An alert level as typed: ',' or the Arabic decimal separator is the decimal point; anything else not numeric is dropped. */
export const levelInput = (text: string): string => latinDigits(text).replace(/[,٫]/g, '.').replace(/[^\d.]/g, '');
/** A sign-in code as typed: digits and spaces only. */
export const codeInput = (text: string): string => latinDigits(text).replace(/[^\d ]/g, '');
