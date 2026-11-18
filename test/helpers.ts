import { DatabaseService } from '../src/db/database.service';
import { IngestService } from '../src/ingest/ingest.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { ReconService } from '../src/recon/recon.service';
import { ReportService } from '../src/report/report.service';

export interface Harness {
  dbs: DatabaseService;
  ingest: IngestService;
  recon: ReconService;
  report: ReportService;
}

export function makeHarness(): Harness {
  const dbs = new DatabaseService(':memory:');
  const ingest = new IngestService(dbs);
  const ledger = new LedgerService(dbs);
  const recon = new ReconService(dbs, ingest, ledger);
  const report = new ReportService(dbs);
  return { dbs, ingest, recon, report };
}

export const payoutEvent = (
  event_id: string, payout_id: string, type: string, amount_bs: number, timestamp: string,
) => ({ event_id, payout_id, type, amount_bs, timestamp });
