// Public index data the website shows, built from the backend API by lib/public-index.ts.
export type BaselineMetric={kind:'average'|'count';perWindow:number;observedDailyMean:number;rule:'observed'|'minimum'};
/** The permanent baseline (first 30 collected days = index level 50). Methodology constants, not daily Pro data. */
export type Baseline={fromDay:string;throughDay:string;level:number;metrics:Record<'addresses'|'contracts'|'tvl'|'hashrate'|'commits',BaselineMetric>};
export type PublicIndex={state:'ready'|'stale'|'pending'|'unavailable';day:string|null;score:number|null;baseline:Baseline|null;sevenDay:number|null;thirtyDay:number|null;updatedAt:string|null;message:string};
