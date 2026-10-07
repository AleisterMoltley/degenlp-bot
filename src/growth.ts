/** Reference pace. The weekly multiple keeps compounding and does not cap size. */

export function paceSol(args: {
  startSol: number;
  targetSol: number;
  startedAt: number;
  now: number;
  weekMs: number;
}): number {
  const start = Math.max(args.startSol, 1e-9);
  const target = Math.max(args.targetSol, start);
  const span = Math.max(args.weekMs, 1);
  const t = Math.max(0, (args.now - args.startedAt) / span);
  return start * Math.pow(target / start, t);
}

export function deploySolFor(equitySol: number, riskFraction: number): number {
  const equity = Math.max(equitySol, 0);
  if (equity <= 0) return 0;
  const risk = Math.min(0.9, Math.max(0.05, riskFraction));
  return Math.round(equity * risk * 1e6) / 1e6;
}

export function equitySol(args: {
  startSol: number;
  realizedSol: number;
  openNetUsd: number;
  solPrice: number;
}): number {
  const open = args.solPrice > 0 ? args.openNetUsd / args.solPrice : 0;
  return args.startSol + args.realizedSol + open;
}
