// Display precision never changes the stored composite: public shows a whole number, Pro one decimal.
export const publicScore = (score: number): string => Math.round(score).toString();
export const proScore = (score: number): string => score.toFixed(1);
