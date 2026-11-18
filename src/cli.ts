import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { mkdirSync, writeFileSync } from 'fs';
import { AppModule } from './app.module';
import { ReconService } from './recon/recon.service';
import { ReportService } from './report/report.service';
import { DATA_DIR_DEFAULT } from './constants';

/** Thin CLI: ingest data/, print the report, write output/run.json. */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const dir = process.argv[2] ?? DATA_DIR_DEFAULT;
  app.get(ReconService).reconcile(dir);
  const report = app.get(ReportService);
  const out = { balances: report.balances(), breaks: report.breaks() };

  const b = out.balances;
  console.log(`\nBalances as of ${b.asOf}`);
  console.log(`  USDT sent, not yet converted : ${b.usdtInTransit} USDT`);
  console.log(`  Bs available at provider     : ${b.bsProviderAvailable} Bs`);
  console.log(`  Bs paid out (net of reversals): ${b.bsPaidOutNet} Bs  (gross ${b.bsPaidOutGross}, reversed ${b.bsReversed})`);
  console.log(`  Bs in pay-outs not yet final : ${b.bsPendingNotFinal} Bs  [${b.pendingPayouts.map((p) => p.payoutId).join(', ') || '—'}]`);
  console.log(`  Trial balance: ${b.trialBalance.map((t) => `${t.currency} D ${t.debits} = C ${t.credits}`).join(' · ')}`);
  console.log(`\nBreaks (${out.breaks.length}):`);
  for (const brk of out.breaks) {
    console.log(`  [${brk.severity.toUpperCase().padEnd(6)}] ${brk.code}  ${brk.ref}\n           ${brk.reason}`);
  }

  mkdirSync('output', { recursive: true });
  writeFileSync('output/run.json', JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote output/run.json`);
  await app.close();
}
main().catch((err) => { console.error(err); process.exit(1); });
