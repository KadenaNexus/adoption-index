import {EVM_NETWORKS} from './config.mjs';
/** Integer base units → decimal string without trailing zeros ("9", "9.5"). */
export function formatUnits(value,decimals){
 const v=BigInt(value),base=10n**BigInt(decimals),sign=v<0n?'-':'',abs=v<0n?-v:v;
 const frac=decimals?(abs%base).toString().padStart(decimals,'0').replace(/0+$/,''):'';
 return `${sign}${abs/base}${frac?'.'+frac:''}`;
}
/** Public explorer link for a stored payment or unmatched transfer row. */
export function explorerTxUrl(row){
 const n=EVM_NETWORKS[row.network];
 return n&&row.tx_hash?`${n.explorerUrl}/tx/${row.tx_hash}`:null;
}
